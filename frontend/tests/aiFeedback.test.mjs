import test from 'node:test'
import assert from 'node:assert/strict'
import { importSource } from './import-source.mjs'
const { validFeedbackPreview, previewMatches, previewRequest, previewMessages } = await importSource('aiFeedback.ts')
const fixture = () => ({ feedback: { mode: 'SHADOW_PREVIEW', state_version: 3, stage: 'CORE', text_version: 'v1', rubric_version: 'reason-preview-v1', rubric_review_status: 'NOT_VERIFIED', may_update_learning: false,
  status: 'OK', error_code: null, simulated: false, cached: false, summary: '候选意见', next_step: '核对原文', matched_criteria: ['引用原文'], cited_evidence: [{ id: 'e1', text: '原文片段' }], trace_id: 't1' } })
test('accepts real shadow candidate and explicit fallback, never fake grading', () => {
  assert.equal(validFeedbackPreview(fixture()), true)
  const f = fixture(); Object.assign(f.feedback, { status: 'FALLBACK', error_code: 'PROVIDER_TIMEOUT', matched_criteria: [], cited_evidence: [], cached: true })
  assert.equal(validFeedbackPreview(f), true)
})
test('fails closed on unreviewed gate, fake success, scores, mismatched failure or malformed arrays', () => {
  for (const patch of [{ may_update_learning: true }, { simulated: true }, { score: 100 }, { rubric_review_status: 'APPROVED' }, { mode: 'FORMAL' }, { state_version: 0 }, { state_version: 1.2 }, { summary: '' }, { cited_evidence: null }, { cited_evidence: [{ id: 'e1', text: '原文', score: 1 }] }, { matched_criteria: ['重复', '重复'] }, { status: 'OK', error_code: 'RATE_LIMITED' }, { status: 'FALLBACK', error_code: 'PROVIDER_TIMEOUT' }]) {
    const f = fixture(); Object.assign(f.feedback, patch); assert.equal(validFeedbackPreview(f), false, JSON.stringify(patch))
  }
  for (const value of [null, {}, { feedback: [] }, { feedback: {} }]) assert.equal(validFeedbackPreview(value), false)
})
test('response is bound to exact progress, stage and material version', () => {
  const f = fixture().feedback
  assert.equal(previewMatches(f, 3, 'CORE', 'v1'), true)
  for (const args of [[4, 'CORE', 'v1'], [3, 'TRANSFER', 'v1'], [3, 'CORE', 'v2'], [3, 'CORE', undefined]]) assert.equal(previewMatches(f, ...args), false)
})
test('request carries only saved version and explicit consent, not identity, reason or client rubric', () => {
  assert.deepEqual(previewRequest(3), { expected_state_version: 3, send_minimal_data: true })
  assert.match(previewMessages.AI_LOCAL_PREVIEW_ONLY, /本机/)
  assert.match(previewMessages.AI_FEEDBACK_STALE, /不再适用/)
})
