import test from 'node:test'
import assert from 'node:assert/strict'
import { importSource } from './import-source.mjs'

const { executeTrainingCommand } = await importSource('trainingCommandOutcome.ts')
const intent = () => ({ sessionId: 'synthetic', version: 3, type: 'SAVE_REASONING', payload: { reason: '', answer: '借助' }, key: 'fixed-synthetic-key' })
function host() {
  const calls = [], ctx = { current: true, alive: true }
  const io = {
    lock: { current: false }, owner: { current: null }, isCurrent: () => ctx.current, isAlive: () => ctx.alive,
    begin: t => calls.push(['begin', t]), finish: () => calls.push(['finish']),
    send: async i => { calls.push(['send', i]); return { session: { state_version: 4, transfer_ready: false } } },
    accept: value => calls.push(['accept', value]), isUnknown: e => e.message === 'NETWORK_ERROR',
    unknown: (i, e) => calls.push(['unknown', i, e.message]), failure: e => calls.push(['failure', e.message]),
    conflict: async () => calls.push(['conflict']),
  }
  return { calls, ctx, io }
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

test('confirmed returns exact server snapshot but does not assume answer validated', async () => {
  const h = host(), i = intent(), outcome = await executeTrainingCommand(i, h.io)
  assert.equal(outcome.status, 'confirmed')
  assert.equal(outcome.session.state_version, 4)
  assert.equal(outcome.session.transfer_ready, false)
  assert.equal(h.calls.filter(x => x[0] === 'send').length, 1)
  assert.equal(h.calls.find(x => x[0] === 'send')[1], i)
  assert.equal(h.io.lock.current, false)
  assert.equal(h.io.owner.current, null)
})

test('stale intent has no network or UI side effect', async () => {
  const h = host(); h.ctx.current = false
  assert.deepEqual(await executeTrainingCommand(intent(), h.io), { status: 'stale' })
  assert.deepEqual(h.calls, [])
})

test('shared operation lock rejects command without changing existing owner', async () => {
  const h = host(); h.io.lock.current = true; const token = Symbol('existing'); h.io.owner.current = token
  assert.deepEqual(await executeTrainingCommand(intent(), h.io), { status: 'blocked' })
  assert.deepEqual(h.calls, []); assert.equal(h.io.owner.current, token)
})

test('double-click cannot dispatch two writes while first is in flight', async () => {
  const h = host(), d = deferred(); let writes = 0
  h.io.send = () => { writes++; return d.promise }
  const first = executeTrainingCommand(intent(), h.io)
  assert.deepEqual(await executeTrainingCommand(intent(), h.io), { status: 'blocked' })
  d.resolve({ session: { state_version: 4 } })
  assert.equal((await first).status, 'confirmed'); assert.equal(writes, 1)
})

test('lost response returns unknown and retains original key, payload and intent, no retry', async () => {
  const h = host(), i = intent(); let writes = 0
  h.io.send = async () => { writes++; throw new Error('NETWORK_ERROR') }
  assert.deepEqual(await executeTrainingCommand(i, h.io), { status: 'unknown' })
  const unknown = h.calls.find(x => x[0] === 'unknown')
  assert.equal(unknown[1], i); assert.equal(unknown[1].key, 'fixed-synthetic-key'); assert.equal(unknown[1].payload, i.payload)
  assert.equal(writes, 1); assert.equal(h.calls.some(x => x[0] === 'accept'), false)
})

test('definitive failure never returns confirmed or invokes unknown recovery', async () => {
  const h = host(); h.io.send = async () => { throw new Error('INVALID_CONTEXT_SELECTION') }
  assert.deepEqual(await executeTrainingCommand(intent(), h.io), { status: 'definitive_failure' })
  assert.ok(h.calls.some(x => x[0] === 'failure')); assert.equal(h.calls.some(x => x[0] === 'unknown'), false)
})

test('CAS refresh is a definitive failure, not permission to continue the chain', async () => {
  const h = host(); h.io.send = async () => { throw new Error('VERSION_CONFLICT') }
  assert.deepEqual(await executeTrainingCommand(intent(), h.io), { status: 'definitive_failure' })
  assert.equal(h.calls.filter(x => x[0] === 'conflict').length, 1)
  assert.equal(h.calls.some(x => x[0] === 'accept'), false)
})

test('late success after route/identity/session/version change cannot publish response', async () => {
  for (const change of ['route', 'identity', 'session', 'version']) {
    const h = host(), d = deferred(); h.io.send = () => d.promise
    const run = executeTrainingCommand(intent(), h.io); h.ctx.current = false
    d.resolve({ session: { state_version: 4, marker: change } })
    assert.deepEqual(await run, { status: 'stale' })
    assert.equal(h.calls.some(x => x[0] === 'accept'), false)
  }
})

test('late failure cannot replace a new page error or uncertain intent', async () => {
  const h = host(), d = deferred(); h.io.send = () => d.promise
  const run = executeTrainingCommand(intent(), h.io); h.ctx.current = false
  d.reject(new Error('NETWORK_ERROR'))
  assert.deepEqual(await run, { status: 'stale' })
  assert.equal(h.calls.some(x => ['failure', 'unknown', 'conflict'].includes(x[0])), false)
})

test('obsolete owner cannot accept, release another lock or clear another busy state', async () => {
  const h = host(), d = deferred(); h.io.send = () => d.promise
  const run = executeTrainingCommand(intent(), h.io), other = Symbol('new owner'); h.io.owner.current = other
  d.resolve({ session: { state_version: 4 } })
  assert.deepEqual(await run, { status: 'stale' }); assert.equal(h.io.owner.current, other); assert.equal(h.io.lock.current, true)
  assert.equal(h.calls.some(x => ['finish', 'accept'].includes(x[0])), false)
})

test('unmounted caller does not get completion UI callbacks', async () => {
  const h = host(), d = deferred(); h.io.send = () => d.promise
  const run = executeTrainingCommand(intent(), h.io); h.ctx.current = false; h.ctx.alive = false
  d.resolve({ session: { state_version: 4 } }); assert.equal((await run).status, 'stale')
  assert.equal(h.calls.some(x => x[0] === 'finish'), false)
})

test('nonincrementing or unexpected version is uncertain, never optimistic success', async () => {
  for (const state_version of [2, 3, 5, undefined]) {
    const h = host(), i = intent(); h.io.send = async () => ({ session: { state_version } })
    assert.deepEqual(await executeTrainingCommand(i, h.io), { status: 'unknown' })
    assert.equal(h.calls.find(x => x[0] === 'unknown')[1], i)
    assert.equal(h.calls.some(x => x[0] === 'accept'), false)
  }
})
