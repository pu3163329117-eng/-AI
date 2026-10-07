import test from 'node:test'
import assert from 'node:assert/strict'
import { importSource } from './import-source.mjs'
const { validAvailability, validAssessment, validAssessmentSummaries, answerCounts, assessmentPassageLabel, assessmentReasonLabel, safeSourceUrl } = await importSource('assessment.ts')
const dimensions = ['vocabulary', 'syntax', 'context', 'chapter']
const questions = Array.from({ length: 24 }, (_, index) => ({ id: `q-${index}`, version: 'v1', dimension: dimensions[Math.floor(index / 6)], difficulty: ['L1', 'L2', 'L3'][index % 3], stem: '根据原文判断词义', source: '原典', source_url: 'https://example.com/source', passage: '君子博学而日参省乎己。', options: [{ id: 'one', text: '每天' }, { id: 'two', text: '太阳' }] }))
const session = { id: 's1', profile_id: 'p1', mode: 'PILOT', status: 'IN_PROGRESS', state_version: 0, bank_version: 'draft-v1', scoring_version: 'trial-v1', self_level: null, self_answers: { level: 'UNSURE', goal: 'INTEREST', word_strategy: 'CONTEXT', reading_experience: 'GUIDED' }, created_at: '2026-10-07', updated_at: '2026-10-07', current_index: 0, questions, answers: {}, result: null }
const completed = () => ({ ...session, status: 'COMPLETED', answers: Object.fromEntries(questions.map(question => [question.id, 'one'])), result: { overall_score: 100, suggested_level: null, level_status: 'PILOT_ONLY', sufficiency: 'HIGH', sufficiency_reasons: ['待教研核验'], strengths: dimensions, weaknesses: [], explanation: '规则参考分，不定级', dimensions: Object.fromEntries(dimensions.map(dimension => [dimension, { score: 100, presented_count: 6, answered_count: 6, skipped_count: 0, correct_count: 6 }])), review: questions.map(question => ({ question_id: question.id, correct_option_id: 'one', explanation: '依据原文' })) } })

test('availability requires finite typed counts and the frozen 24-question format', () => {
  const data = { pilot_available: true, formal_available: false, pilot_question_count: 48, approved_question_count: 0, questions_per_session: 24, bank_version: 'v1', reason: '待审核' }
  assert.equal(validAvailability(data), true)
  for (const patch of [{ questions_per_session: 12 }, { pilot_available: 'yes' }, { approved_question_count: NaN }]) assert.equal(validAvailability({ ...data, ...patch }), false)
})
test('unanswered, explicit skip, and ID-based answer remain different', () => {
  assert.deepEqual(answerCounts(session), { answered: 0, skipped: 0, resolved: 0, remaining: 24 })
  assert.deepEqual(answerCounts({ ...session, answers: { 'q-0': null, 'q-1': 'two' } }), { answered: 1, skipped: 1, resolved: 2, remaining: 22 })
  assert.equal(validAssessment({ ...session, answers: { 'q-0': 'two' } }), true)
  for (const answers of [{ 'q-0': 'A' }, { foreign: 'one' }, { 'q-0': false }]) assert.equal(validAssessment({ ...session, answers }), false)
})
test('active sessions reject answer-bearing fields, duplicate IDs and premature results', () => {
  assert.equal(validAssessment(session), true)
  for (const field of ['answer_id', 'correct_option_id', 'explanation']) assert.equal(validAssessment({ ...session, questions: questions.map((question, index) => index ? question : { ...question, [field]: 'one' }) }), false)
  assert.equal(validAssessment({ ...session, questions: questions.map((question, index) => index ? question : { ...question, options: [{ id: 'one', text: '每天', is_correct: true }, { id: 'two', text: '太阳' }] }) }), false)
  assert.equal(validAssessment({ ...session, questions: [...questions.slice(0, 23), questions[0]] }), false)
  assert.equal(validAssessment({ ...session, result: completed().result }), false)
  assert.equal(validAssessment({ ...session, current_index: 24 }), false)
  const metadata = { material_extent: 'FULL', passage_extent: 'EXCERPT', text_version: 'original-v2' }
  assert.equal(validAssessment({ ...session, questions: questions.map(question => ({ ...question, ...metadata })) }), true)
  for (const patch of [{ material_extent: 'PARTIAL' }, { passage_extent: null }, { text_version: 2 }]) assert.equal(validAssessment({ ...session, questions: questions.map(question => ({ ...question, ...metadata, ...patch })) }), false)
  assert.equal(assessmentPassageLabel(questions[0]), '本题原文 · 题目版本 v1')
  assert.equal(assessmentPassageLabel({ ...questions[0], ...metadata }), '本题原文 · 连续节选 · original-v2')
  assert.equal(assessmentPassageLabel({ ...questions[0], material_extent: 'FULL' }), '本题原文 · 选段范围未登记 · 原文版本未登记')
})
test('all skipped completion displays null scores, never invented zero grades', () => {
  const data = completed()
  data.answers = Object.fromEntries(questions.map(question => [question.id, null]))
  data.result.overall_score = null
  data.result.sufficiency = 'INSUFFICIENT'
  data.result.strengths = []
  data.result.dimensions = Object.fromEntries(dimensions.map(dimension => [dimension, { score: null, presented_count: 6, answered_count: 0, skipped_count: 6, correct_count: 0 }]))
  assert.equal(validAssessment(data), true)
})
test('completion needs a complete result and never gives pilot a formal level', () => {
  assert.equal(validAssessment(completed()), true)
  for (const patch of [{ result: null }, { answers: {} }, { result: { ...completed().result, suggested_level: 'L3' } }, { result: { ...completed().result, review: [] } }, { result: { ...completed().result, overall_score: Infinity } }]) assert.equal(validAssessment({ ...completed(), ...patch }), false)
  const data = completed(); data.result.dimensions.context.correct_count = 7
  assert.equal(validAssessment(data), false)
})
test('self-assessment is constrained and legacy sessions can omit it', () => {
  assert.equal(validAssessment({ ...session, self_answers: {} }), true)
  assert.equal(validAssessment({ ...session, self_answers: undefined }), true)
  for (const self_answers of [null, { goal: 'OTHER' }, { injected: 'INTEREST' }, { level: 3 }]) assert.equal(validAssessment({ ...session, self_answers }), false)
})
test('summary list has explicit empty and guarded counts', () => {
  const summary = { id: 's1', mode: 'PILOT', status: 'IN_PROGRESS', current_index: 0, created_at: '2026-10-07', updated_at: '2026-10-07', question_count: 24, answered_count: 2, skipped_count: 1 }
  assert.equal(validAssessmentSummaries({ assessments: [] }), true)
  assert.equal(validAssessmentSummaries({ assessments: [summary] }), true)
  for (const patch of [{ status: 'DONE' }, { skipped_count: 25 }, { question_count: '24' }]) assert.equal(validAssessmentSummaries({ assessments: [{ ...summary, ...patch }] }), false)
  assert.equal(validAssessmentSummaries({ assessments: [null] }), false)
})
test('source links do not permit executable schemes or embedded credentials', () => {
  assert.equal(safeSourceUrl('https://example.com/original'), 'https://example.com/original')
  for (const source of ['javascript:alert(1)', 'data:text/html,bad', 'https://user:secret@example.com', '/local', '']) assert.equal(safeSourceUrl(source), null)
})
test('sufficiency display translates only known dimension prefixes without rewriting results', () => {
  const reasons = dimensions.map(dimension => `${dimension} 有效作答不足 4 题。`)
  const original = [...reasons]
  assert.deepEqual(reasons.map(assessmentReasonLabel), ['字词辨义 有效作答不足 4 题。', '句式理解 有效作答不足 4 题。', '语境推断 有效作答不足 4 题。', '篇章理解 有效作答不足 4 题。'])
  assert.deepEqual(reasons, original)
  assert.equal(assessmentReasonLabel('context：待补测'), '语境推断：待补测')
  for (const reason of ['translation 尚未测量', 'contextual evidence is unknown', '未知原因', '题库 context 已变化']) assert.equal(assessmentReasonLabel(reason), reason)
})
