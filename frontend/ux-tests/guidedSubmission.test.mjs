import test from 'node:test'
import assert from 'node:assert/strict'
import { importSource } from './import-source.mjs'
const { runGuidedSubmission, draftMatchesSavedGraph } = await importSource('guidedSubmission.ts')
const draft = { basis_kind: 'CONTEXT', paragraph_index: 0, start: 1, end: 3, reason: '', conclusion: '借助' }
const base = { stage: 'CORE', state_version: 3, completed: false, transfer_ready: false, summary_ready: false, learning_trace: { stages: { CORE: { first_attempt: { answer: '借助' } }, TRANSFER: { first_attempt: { answer: '借助' } } } } }
const graph = (payload = draft) => ({ stage: 'CORE', basis_kind: payload.basis_kind, evidence: { paragraph_index: payload.paragraph_index, start: payload.start, end: payload.end }, reason: payload.reason, conclusion: payload.conclusion, ...(payload.basis_kind === 'ANNOTATION' ? { annotation: { id: payload.annotation_id, version: payload.annotation_version } } : {}) })
function fixture(session = base, payload = draft) {
  const calls = [], steps = []
  let state = session
  const options = { session, answer: '借助', payload, isCurrent: () => true, onProgress: s => steps.push(s), execute: async (type, body, expectedVersion) => {
    calls.push([type, body, expectedVersion]); assert.equal(expectedVersion, state.state_version)
    state = { ...state, state_version: state.state_version + 1 }
    if (type === 'SAVE_REASONING') state.reasoning_graph = { ...graph(body), stage: state.stage }
    if (type === 'SUBMIT_ATTEMPT') state = { ...state, ...(state.stage === 'CORE' ? { transfer_ready: true } : { summary_ready: true }) }
    if (type === 'CONTINUE_TO_TRANSFER') state = { ...state, stage: 'TRANSFER', transfer_ready: false, reasoning_graph: null }
    if (type === 'COMPLETE_SESSION') state = { ...state, completed: true }
    return { status: 'confirmed', session: state }
  } }
  return { options, calls, steps, get state() { return state } }
}
test('one intent sequences original commands with each confirmed CAS version; empty/short reasons remain valid', async () => {
  for (const reason of ['', '据句']) {
    const f = fixture(base, { ...draft, reason }); const result = await runGuidedSubmission(f.options)
    assert.equal(result.status, 'confirmed'); assert.equal(result.session.stage, 'TRANSFER')
    assert.deepEqual(f.calls.map(c => [c[0], c[2]]), [['SAVE_REASONING', 3], ['SUBMIT_ATTEMPT', 4], ['CONTINUE_TO_TRANSFER', 5]])
    assert.equal(f.calls[0][1].reason, reason)
  }
})
test('annotation source identifiers, position and version are not replaced with its meaning', async () => {
  const annotation = { ...draft, basis_kind: 'ANNOTATION', annotation_id: 'qa-note', annotation_version: 0 }
  const f = fixture(base, annotation); await runGuidedSubmission(f.options)
  assert.deepEqual(f.calls[0][1], annotation); assert.equal('meaning' in f.calls[0][1], false)
  assert.equal(draftMatchesSavedGraph({ ...base, reasoning_graph: graph(annotation) }, annotation), true)
  assert.equal(draftMatchesSavedGraph({ ...base, reasoning_graph: graph(annotation) }, { ...annotation, annotation_version: 1 }), false)
})
test('unchanged saved draft resumes at SUBMIT, ready resumes only advancement; no effect writes', async () => {
  const saved = { ...base, reasoning_graph: graph() }
  const f = fixture(saved); await runGuidedSubmission(f.options)
  assert.deepEqual(f.calls.map(c => c[0]), ['SUBMIT_ATTEMPT', 'CONTINUE_TO_TRANSFER'])
  const ready = fixture({ ...saved, transfer_ready: true }); await runGuidedSubmission(ready.options)
  assert.deepEqual(ready.calls.map(c => c[0]), ['CONTINUE_TO_TRANSFER'])
  const legacy = fixture({ ...base, transfer_ready: true, learning_trace: undefined })
  legacy.options.answer = ''; legacy.options.payload = {}
  assert.equal((await runGuidedSubmission(legacy.options)).status, 'confirmed')
  assert.deepEqual(legacy.calls.map(c => c[0]), ['CONTINUE_TO_TRANSFER'], 'server-ready historical session needs no fabricated answer or basis to continue')
})
test('TRANSFER ends at confirmed session summary, never creates another lesson', async () => {
  const f = fixture({ ...base, stage: 'TRANSFER' }); const result = await runGuidedSubmission(f.options)
  assert.equal(result.session.completed, true)
  assert.deepEqual(f.calls.map(c => c[0]), ['SAVE_REASONING', 'SUBMIT_ATTEMPT', 'COMPLETE_SESSION'])
})
test('wrong answer/insufficient evidence does not advance merely because HTTP command confirmed', async () => {
  const f = fixture({ ...base, reasoning_graph: graph() })
  f.options.execute = async (type, body, version) => { f.calls.push([type, body, version]); return { status: 'confirmed', session: { ...base, reasoning_graph: graph(), state_version: 4 } } }
  const result = await runGuidedSubmission(f.options)
  assert.equal(result.status, 'needs_revision'); assert.deepEqual(f.calls.map(c => c[0]), ['SUBMIT_ATTEMPT'])
})
test('every failed/unknown/blocked/stale command stops immediately, retaining last confirmed receipt', async () => {
  for (const status of ['definitive_failure', 'unknown', 'blocked', 'stale']) for (const failAt of ['SAVE_REASONING', 'SUBMIT_ATTEMPT', 'CONTINUE_TO_TRANSFER']) {
    const f = fixture(); const original = f.options.execute
    f.options.execute = async (...args) => args[0] === failAt ? (f.calls.push(args), { status }) : original(...args)
    const result = await runGuidedSubmission(f.options)
    assert.equal(result.status, status); assert.equal(result.stoppedAt, failAt)
    assert.equal(f.calls.at(-1)[0], failAt); assert.equal(result.session.state_version, 3 + ['SAVE_REASONING', 'SUBMIT_ATTEMPT', 'CONTINUE_TO_TRANSFER'].indexOf(failAt))
  }
})
test('identity/unmount/version scope invalidated after SAVE cannot send SUBMIT', async () => {
  const f = fixture(); let valid = true; const original = f.options.execute
  f.options.isCurrent = () => valid
  f.options.execute = async (...args) => { const result = await original(...args); valid = false; return result }
  assert.equal((await runGuidedSubmission(f.options)).status, 'stale')
  assert.deepEqual(f.calls.map(c => c[0]), ['SAVE_REASONING'])
})
test('first attempt cannot be fabricated, completed sessions cannot write, throws are unknown', async () => {
  for (const session of [{ ...base, completed: true }, { ...base, learning_trace: { stages: { CORE: { first_attempt: null } } } }]) {
    const f = fixture(session); assert.equal((await runGuidedSubmission(f.options)).status, 'blocked'); assert.equal(f.calls.length, 0)
  }
  const f = fixture(); f.options.execute = async () => { throw Error('synthetic lost response') }
  assert.equal((await runGuidedSubmission(f.options)).status, 'unknown')
})
test('invalid SAVE receipt/unchanged version/wrong stage never advances', async () => {
  for (const patch of [{}, { state_version: 4 }, { state_version: 4, stage: 'TRANSFER' }]) {
    const f = fixture(); f.options.execute = async (...args) => { f.calls.push(args); return { status: 'confirmed', session: { ...base, ...patch } } }
    assert.equal((await runGuidedSubmission(f.options)).status, 'stale'); assert.equal(f.calls.length, 1)
  }
})
test('verified feedback is captured from a real ready receipt before advancement overwrites it', async () => {
  const f = fixture(), verified = [], order = []; const execute = f.options.execute
  f.options.execute = async (...args) => {
    order.push(args[0]); const result = await execute(...args)
    result.session.feedback = args[0] === 'SUBMIT_ATTEMPT' ? '依据覆盖了原文线索；规则核验通过。' : '下一题的新提示'
    result.session.source = '合成篇'
    return result
  }
  f.options.onVerified = feedback => { order.push('VERIFIED'); verified.push(feedback) }
  assert.equal((await runGuidedSubmission(f.options)).status, 'confirmed')
  assert.deepEqual(order, ['SAVE_REASONING', 'SUBMIT_ATTEMPT', 'VERIFIED', 'CONTINUE_TO_TRANSFER'])
  assert.deepEqual(verified, [{ stage: 'CORE', stateVersion: 5, source: '合成篇', feedback: '依据覆盖了原文线索；规则核验通过。' }])
  assert.equal(f.state.feedback, '下一题的新提示'); assert.notEqual(verified[0].feedback, f.state.feedback)
})
test('verified feedback survives an unknown advancement but nonpassing or stale responses cannot create it', async () => {
  const ready = { ...base, transfer_ready: true, feedback: '真实已通过反馈', source: '合成篇' }
  const retained = [], f = fixture(ready); f.options.onVerified = value => retained.push(value)
  f.options.execute = async () => ({ status: 'unknown' })
  assert.equal((await runGuidedSubmission(f.options)).status, 'unknown'); assert.equal(retained[0].feedback, ready.feedback)
  const notReady = fixture({ ...base, reasoning_graph: graph() }); const notVerified = []
  notReady.options.onVerified = value => notVerified.push(value)
  notReady.options.execute = async () => ({ status: 'confirmed', session: { ...base, state_version: 4, feedback: '200不是规则通过' } })
  assert.equal((await runGuidedSubmission(notReady.options)).status, 'needs_revision'); assert.deepEqual(notVerified, [])
  const stale = fixture(ready); let current = true; stale.options.isCurrent = () => { const was = current; current = false; return was }
  stale.options.onVerified = value => notVerified.push(value)
  assert.equal((await runGuidedSubmission(stale.options)).status, 'stale'); assert.deepEqual(notVerified, []); assert.deepEqual(stale.calls, [])
})
test('historical ready sessions with absent/blank feedback never get invented feedback', async () => {
  for (const feedback of [undefined, '', '  ']) {
    const f = fixture({ ...base, transfer_ready: true, feedback }), verified = []
    f.options.onVerified = value => verified.push(value)
    assert.equal((await runGuidedSubmission(f.options)).status, 'confirmed'); assert.deepEqual(verified, [])
  }
})
