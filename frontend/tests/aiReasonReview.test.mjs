import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { importSource } from './import-source.mjs'

const { validReviewQueue, validReviewDetail, validReviewFields, validReviewWrite, validReviewReceipt, normalizeReviewFields, emptyReviewFields } = await importSource('aiReasonReview.ts')
const hash = 'a'.repeat(64), input = 'b'.repeat(64), key = 'fixture-key-12345678'
const gates = () => ({ review_status: 'NOT_VERIFIED', reviewer_identity_verified: false, semantic_accuracy_verified: false, may_update_learning: false, live_ai_release_gate_satisfied: false })
const fields = () => ({ reviewer: '合成核对员', decision: 'UNCERTAIN', context_sufficiency: 'UNCERTAIN', source_basis: '合成注本依据', rationale: '合成核对意见', alternatives: null, suggested_labels: ['UNSCORABLE'] })
const operation = () => ({ key, case_id: 'fixture-case', body: { expected_suite_digest: hash, expected_input_digest: input, expected_revision: 0, fields: fields() } })
const note = () => ({ ...gates(), id: key, case_id: 'fixture-case', suite_digest: hash, input_digest: input, revision: 1, created_at: '2026-10-08T12:00:00+00:00', fields: fields() })
const queue = () => ({ ...gates(), suite_version: 'draft-v1', suite_digest: hash, total: 1, recorded_cases: 1, notes_total: 1, decision_counts: { ACCEPTABLE: 0, NEEDS_REVISION: 0, UNCERTAIN: 1 }, items: [{ case_id: 'fixture-case', target: '从', stage: 'CORE', source: '合成材料', input_digest: input, revision: 1, decision: 'UNCERTAIN' }] })
const detail = () => ({ ...gates(), suite_version: 'draft-v1', suite_digest: hash, case_id: 'fixture-case', source: '合成材料', input_digest: input, revision: 1, historical_note_count: 0, notes: [note()], payload: { stage: 'CORE', text_version: 'draft-v1', target: '从', student_reason: '合成理由', student_conclusion: '合成结论', visible_evidence: [{ id: 'e1', text: '合成原文' }], rubric: [{ id: 'r1', criterion: '合成标准' }] }, development_expectation: { labels: ['UNSCORABLE'], error: null, required_evidence: ['e1'], required_criteria: ['r1'], note: '开发草稿', review_status: 'NOT_VERIFIED' } })

test('local opinions remain unverified across queue detail and receipt', () => {
  assert.equal(validReviewQueue(queue()), true)
  assert.equal(validReviewDetail(detail()), true)
  assert.equal(validReviewReceipt({ ...gates(), saved: note(), replayed: false }, operation()), true)
  assert.equal(validReviewReceipt({ ...gates(), saved: note(), replayed: true }, operation()), true)
})
test('closed gates cannot be silently upgraded or carry scores', () => {
  for (const patch of [{ review_status: 'APPROVED' }, { reviewer_identity_verified: true }, { semantic_accuracy_verified: true }, { may_update_learning: true }, { live_ai_release_gate_satisfied: true }, { score: 100 }]) {
    assert.equal(validReviewQueue({ ...queue(), ...patch }), false)
    assert.equal(validReviewDetail({ ...detail(), ...patch }), false)
    assert.equal(validReviewReceipt({ ...gates(), saved: note(), replayed: false, ...patch }, operation()), false)
  }
})
test('queue counts reflect latest opinions not teacher certification or historical rows', () => {
  for (const patch of [{ recorded_cases: 2 }, { notes_total: 2 }, { total: 2 }, { total: true }, { decision_counts: { ACCEPTABLE: 1, NEEDS_REVISION: 0, UNCERTAIN: 0 } }]) assert.equal(validReviewQueue({ ...queue(), ...patch }), false)
  const value = queue(); value.items.push(structuredClone(value.items[0])); value.total = 2
  assert.equal(validReviewQueue(value), false)
})
test('detail rejects wrong versions sequence unknown criteria or hidden extra data', () => {
  const mutations = [v => v.notes[0].revision = 2, v => v.notes[0].suite_digest = 'c'.repeat(64), v => v.notes[0].input_digest = 'c'.repeat(64), v => v.notes[0].case_id = 'different', v => v.notes[0].review_status = 'APPROVED', v => v.payload.api_key = 'not-allowed', v => v.development_expectation.required_evidence = ['missing'], v => v.development_expectation.required_criteria = ['missing'], v => v.payload.rubric.push(v.payload.rubric[0]), v => v.notes[0].created_at = 'not-a-date']
  for (const mutate of mutations) { const value = detail(); mutate(value); assert.equal(validReviewDetail(value), false) }
})
test('strict write guard binds input suite progress attribution and idempotency key', () => {
  assert.equal(validReviewWrite(operation()), true)
  const mutations = [v => v.key = 'small', v => v.body.expected_revision = true, v => v.body.expected_suite_digest = 'wrong', v => v.body.fields.score = 100, v => v.body.fields.reviewer = ' ', v => v.body.fields.suggested_labels = ['UNSCORABLE', 'UNSCORABLE'], v => v.body.fields.decision = 'APPROVED']
  for (const mutate of mutations) { const value = operation(); mutate(value); assert.equal(validReviewWrite(value), false) }
})
test('receipt must describe exact submitted opinion not another successful write', () => {
  const mutations = [v => v.saved.revision = 2, v => v.saved.id = 'another-key-12345678', v => v.saved.fields.reviewer = '其他人', v => v.saved.fields.rationale = '不同意见', v => v.saved.fields.suggested_labels = [], v => v.saved.case_id = 'other-case']
  for (const mutate of mutations) { const value = { ...gates(), saved: note(), replayed: false }; mutate(value); assert.equal(validReviewReceipt(value, operation()), false) }
  const value = { ...gates(), saved: note(), replayed: true }; value.saved.fields = Object.fromEntries(Object.entries(value.saved.fields).reverse())
  assert.equal(validReviewReceipt(value, operation()), true)
})
test('empty form is not a fabricated opinion normalization keeps optional text null', () => {
  assert.equal(validReviewFields(emptyReviewFields()), false)
  assert.deepEqual(normalizeReviewFields({ ...fields(), reviewer: ' 合成核对员 ', alternatives: ' ' }), fields())
})
test('page keeps explicit recovery no automatic retry and guards leaving or late reads', async () => {
  const source = await readFile(new URL('../src/components/AIReasonReviewWorkbench.tsx', import.meta.url), 'utf8')
  assert.match(source, /按原标识确认保存/)
  assert.match(source, /validReviewWrite\(value\)/)
  assert.match(source, /onExitRiskChange\(busy \? 'working' : pending \? 'uncertain' : dirty \? 'dirty'/)
  assert.match(source, /if \(!alive\.current \|\| abort\.signal\.aborted\) return/)
  assert.match(source, /if \(!persist\(operation\)\)/)
  assert.equal((source.match(/aiReasonReviewApi\.write\(/g) ?? []).length, 1)
  assert.match(source, /\[revealed, setRevealed\] = useState\(false\)/)
})
