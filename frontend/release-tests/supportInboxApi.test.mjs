import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const read = p => readFile(new URL('../src/' + p, import.meta.url), 'utf8')
const compile = s => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const url = s => `data:text/javascript;base64,${Buffer.from(s).toString('base64')}`
const httpUrl = url(compile(await read('http.ts')))
const rewrite = (s, from, to) => s.replaceAll(`'${from}'`, JSON.stringify(to)).replaceAll(`"${from}"`, JSON.stringify(to))
const contractUrl = url(rewrite(compile(await read('supportInbox.ts')), './http', httpUrl))
const { supportInboxApi: api } = await import(url(rewrite(rewrite(compile(await read('supportInboxApi.ts')), './http', httpUrl), './supportInbox', contractUrl)))
const contract = await import(contractUrl)
const { configureAuthTransport, RequestError } = await import(httpUrl)
const id = '00000000-0000-4000-8000-000000000001', replyId = '00000000-0000-4000-8000-000000000002'
const meta = (extra = {}) => ({ id, reference: 'WY-0123456789ABCDEF', kind: 'feedback', category: 'bug', page: '#/training', build_version: 'synthetic-inbox', status: 'received', created_at: '2026-10-25T00:00:00.000000Z', updated_at: '2026-10-25T00:00:00.000001Z', ...extra })
const detail = () => ({ item: meta(), message: '这是仅用于合成测试的反馈正文。', device: '', replies: [] })
const query = (extra = {}) => ({ reference: '', status: '', kind: '', offset: 0, ...extra })
const page = (extra = {}) => ({ items: [meta()], total: 1, offset: 0, limit: 20, ...extra })
const signal = () => new AbortController().signal
function transport(result, action) {
  const old = globalThis.fetch, calls = []
  globalThis.fetch = async (input, init) => { calls.push({ input, init }); return { ok: true, status: 200, json: async () => result } }
  return Promise.resolve().then(() => action(calls)).finally(() => { globalThis.fetch = old; configureAuthTransport(null) })
}

test('admin list uses only bounded exact query fields, GET/no-store and same-origin transport', async () => {
  await transport(page(), async calls => {
    await api.list(query(), signal()); assert.equal(calls.length, 1)
    assert.equal(calls[0].input, '/api/v1/admin/support/feedback?reference=&status=&kind=&offset=0&limit=20')
    assert.equal(calls[0].init.cache, 'no-store'); assert.equal(calls[0].init.credentials, 'same-origin'); assert.equal(calls[0].init.body, undefined)
  })
})

test('list response must bind query/page and rejects private or unexpected fields and duplicate identifiers', async () => {
  for (const result of [page({ offset: 20 }), page({ limit: 50 }), page({ total: 0 }), page({ email: 'forbidden' }), page({ items: [meta({ user_id: 'forbidden' })] }), page({ items: [meta(), meta()], total: 2 }), page({ items: [meta({ status: 'toString' })] })]) {
    await transport(result, async () => { await assert.rejects(api.list(query(), signal()), e => e instanceof RequestError && e.message === 'INVALID_RESPONSE') })
  }
  await transport(page(), async () => { await assert.rejects(api.list(query({ status: 'resolved' }), signal()), /INVALID_RESPONSE/) })
})

test('invalid outgoing query never calls transport and cannot forward additional identity/search channels', async () => {
  await transport(page(), async calls => {
    for (const q of [query({ reference: 'user@example.com' }), query({ reference: 'wy-0123456789abcdef' }), query({ status: 'toString' }), query({ kind: 'constructor' }), query({ offset: -1 }), query({ offset: 10001 }), query({ email: 'not-allowed' })]) await assert.rejects(api.list(q, signal()), /SUPPORT_ADMIN_INVALID_INPUT/)
    assert.equal(calls.length, 0)
  })
})

test('list snapshots query identity before an asynchronous response', async () => {
  let resolve
  const old = globalThis.fetch, q = query()
  globalThis.fetch = () => new Promise(done => { resolve = done })
  try {
    const pending = api.list(q, signal()); q.status = 'resolved'
    resolve({ ok: true, status: 200, json: async () => page() })
    assert.equal((await pending).items[0].status, 'received')
  } finally { globalThis.fetch = old }
})

test('explicit detail uses fixed requested ID and exact metadata/body/device/reply contract', async () => {
  await transport(detail(), async calls => { assert.equal((await api.detail(id, signal())).device, ''); assert.equal(calls[0].input, `/api/v1/admin/support/feedback/${id}`) })
  for (const result of [{ ...detail(), item: meta({ id: replyId }) }, { ...detail(), email: 'hidden' }, { ...detail(), device: 'x'.repeat(121) }, { ...detail(), replies: [{ id: replyId, message: '这是合法长度的合成回复内容。', created_at: meta().updated_at, request_id: 'hidden' }] }]) await transport(result, async () => { await assert.rejects(api.detail(id, signal()), /INVALID_RESPONSE/) })
})

test('reply sends original key/CAS, omits optional status unless chosen, uses CSRF and does not retry', async () => {
  const payload = { request_id: replyId, message: '这是管理员的合成站内公开回复。', expected_updated_at: meta().updated_at }
  await transport(detail(), async calls => {
    configureAuthTransport('synthetic-csrf')
    await api.reply(id, payload, signal()); assert.equal(calls.length, 1)
    assert.equal(calls[0].input, `/api/v1/admin/support/feedback/${id}/reply`); assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(calls[0].init.body), payload); assert.equal(new Headers(calls[0].init.headers).get('X-CSRF-Token'), 'synthetic-csrf')
    assert.equal(calls[0].init.cache, 'no-store')
  })
})

test('status is an explicit CAS workflow POST, not a DELETE or user-data operation', async () => {
  const payload = { status: 'withdrawn', expected_updated_at: meta().updated_at }
  await transport(detail(), async calls => {
    await api.status(id, payload, signal()); assert.equal(calls.length, 1); assert.equal(calls[0].input, `/api/v1/admin/support/feedback/${id}/status`)
    assert.equal(calls[0].init.method, 'POST'); assert.deepEqual(JSON.parse(calls[0].init.body), payload)
  })
})

test('invalid writes or path identifiers never send an accidental request', async () => {
  await transport(detail(), async calls => {
    await assert.rejects(api.detail('../other', signal()), /SUPPORT_ADMIN_INVALID_INPUT/)
    for (const payload of [{ request_id: replyId, message: '太短', expected_updated_at: meta().updated_at }, { request_id: replyId, message: '合法长度但是状态为null测试。', expected_updated_at: meta().updated_at, status: null }, { request_id: replyId, message: '禁止多余身份字段传输测试。', expected_updated_at: meta().updated_at, email: 'private' }]) await assert.rejects(api.reply(id, payload, signal()), /SUPPORT_ADMIN_INVALID_INPUT/)
    await assert.rejects(api.status(id, { status: 'resolved', expected_updated_at: 'not-a-date' }, signal()), /SUPPORT_ADMIN_INVALID_INPUT/)
    assert.equal(calls.length, 0)
  })
})

test('server failure is surfaced once without silently retrying a potentially committed reply', async () => {
  const old = globalThis.fetch; let calls = 0
  globalThis.fetch = async () => { calls++; throw new TypeError('synthetic network drop') }
  try { await assert.rejects(api.reply(id, { request_id: replyId, message: '合成网络中断回复内容测试。', expected_updated_at: meta().updated_at }, signal()), /NETWORK_ERROR/); assert.equal(calls, 1) }
  finally { globalThis.fetch = old }
})

test('Python whitespace normalization, strict enums and bounded contracts stay explicit', () => {
  assert.equal(contract.trimInboxText('\u0085\u001c 合成回复正文十个字以上。 \u0085'), '合成回复正文十个字以上。')
  assert.notEqual(contract.trimInboxText('\ufeff合成内容\ufeff'), '合成内容')
  assert.ok(contract.replyProblem('\u0085'.repeat(12))); assert.equal(contract.replyProblem('合成回复正文十个字以上。'), '')
  assert.equal(contract.validInboxDetail({ ...detail(), replies: Array.from({ length: 21 }, () => ({ id: replyId, message: '测试回复长度超过十个字符。', created_at: meta().updated_at })) }), false)
  assert.equal(contract.validInboxMeta(meta({ kind: ['feedback'] })), false)
  assert.equal(contract.validInboxDate('2026-02-31T00:00:00.000000Z'), false)
  assert.ok(contract.inboxTimeKey('2026-10-25T00:00:00.000002Z') > contract.inboxTimeKey('2026-10-25T00:00:00.000001Z'))
  assert.equal(contract.validInboxMeta(meta({ updated_at:'2026-10-24T00:00:00Z' })), false)
})
