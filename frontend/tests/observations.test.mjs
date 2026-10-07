import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { importSource } from './import-source.mjs'
const { validLearningTrace, validObservationReport, meaningMayBeShown, observationRate, assistanceLabels, assistanceStatusLabels } = await importSource('observations.ts')
const group = () => ({ count: 0, correct_count: 0, evidence_matched_count: 0, accuracy: null })
const stage = () => ({ observed_stages: 0, unknown_stages: 0, validated_stages: 0, retry_validated_stages: 0, first_no_recorded_assistance: group(), first_assisted: group() })
const report = () => ({ report: { profile_id: 'p1', schema_version: 1, scope: 'LEARNING_BEHAVIOR', explanation: '学习行为，不更新能力等级。', totals: { ...stage(), new_sessions: 1, legacy_sessions: 0, CORE: stage(), TRANSFER: stage() }, trend: [], records: [] } })
const trace = () => ({ schema_version: 1, stages: Object.fromEntries(['CORE', 'TRANSFER'].map(name => [name, { attempt_count: 0, assistance_kinds: [], first_attempt: null, validated: false }])) })
const first = () => ({ answer: '借助', correct: true, evidence_rule_matched: false, assistance_status: 'NONE_RECORDED', assistance_kinds: [], reason_review_status: 'UNREVIEWED', source: '劝学', text_version: 'v1' })
const record = () => ({ session_id: 's1', stage: 'CORE', first_answer: '借助', first_correct: true, first_evidence_rule_matched: false, assistance_status: 'NONE_RECORDED', assistance_kinds: [], attempt_count: 2, validated: true, retry_completed: true, reason_review_status: 'UNREVIEWED', lesson_id: 'lesson1', source: '劝学', text_version: 'v1', first_submitted_at: '2026-10-08T08:00:00Z', validated_at: '2026-10-09T08:00:00+00:00' })
const day = () => ({ date: '2026-10-08', observed_stages: 1, first_no_recorded_assistance_count: 1, first_no_recorded_assistance_correct_count: 1, first_assisted_count: 0, first_assisted_correct_count: 0, retry_validated_stages: 0 })
const observed = () => {
  const data = report(); const summary = { ...stage(), observed_stages: 1, validated_stages: 1, retry_validated_stages: 1, first_no_recorded_assistance: { count: 1, correct_count: 1, evidence_matched_count: 0, accuracy: 100 } }
  Object.assign(data.report.totals, summary, { CORE: structuredClone(summary) }); data.report.records = [record()]; data.report.trend = [day(), { ...day(), date: '2026-10-09', observed_stages: 0, first_no_recorded_assistance_count: 0, first_no_recorded_assistance_correct_count: 0, retry_validated_stages: 1 }]; return data
}

test('tracked meaning disclosure is fail closed; historical review never creates assistance', () => {
  assert.equal(meaningMayBeShown('TRACKED', false), false)
  assert.equal(meaningMayBeShown('TRACKED', undefined), false)
  assert.equal(meaningMayBeShown('TRACKED', true), true)
  assert.equal(meaningMayBeShown('LEGACY', false), true)
  assert.equal(meaningMayBeShown('REVIEW', false), true)
  assert.equal(meaningMayBeShown('UNKNOWN', true), false)
})
test('empty trace preserves unattempted stages; no first answer or score is fabricated', () => {
  assert.equal(validLearningTrace(trace()), true)
  for (const value of [null, [], {}, { ...trace(), schema_version: 2 }, { ...trace(), stages: { CORE: trace().stages.CORE } }]) assert.equal(validLearningTrace(value), false)
  const data = trace(); data.stages.CORE.validated = true
  assert.equal(validLearningTrace(data), false)
  data.stages.CORE.validated = false; data.stages.CORE.attempt_count = 1
  assert.equal(validLearningTrace(data), false)
})
test('first provenance is separate from later assistance and stays unreviewed', () => {
  const data = trace(); Object.assign(data.stages.CORE, { attempt_count: 2, assistance_kinds: ['FEEDBACK', 'RULE_CHECK'], first_attempt: first(), validated: true })
  assert.equal(validLearningTrace(data), true)
  const assisted = structuredClone(data); Object.assign(assisted.stages.CORE.first_attempt, { assistance_status: 'ASSISTED', assistance_kinds: ['RULE_CHECK'] })
  assert.equal(validLearningTrace(assisted), true)
  for (const patch of [{ assistance_status: 'ASSISTED' }, { reason_review_status: 'REVIEWED' }, { source: null }, { assistance_kinds: ['HINT'] }]) {
    const bad = structuredClone(data); Object.assign(bad.stages.CORE.first_attempt, patch); assert.equal(validLearningTrace(bad), false)
  }
  for (const value of [['invented'], ['HINT', 'HINT'], null, 'HINT']) { const bad = structuredClone(data); bad.stages.CORE.assistance_kinds = value; assert.equal(validLearningTrace(bad), false) }
})
test('report accepts empty real state and independently dated retry completion', () => {
  assert.equal(validObservationReport(report()), true)
  assert.equal(validObservationReport(observed()), true)
  assert.equal(observationRate(null), '暂无样本')
  assert.equal(observationRate(0), '0.0%')
  for (const patch of [{ scope: 'ABILITY' }, { records: null }, { trend: {} }, { schema_version: 2 }]) assert.equal(validObservationReport({ report: { ...report().report, ...patch } }), false)
})
test('all count arrays are validated and impossible aggregation fails closed', () => {
  for (const mutate of [data => data.report.totals.CORE.observed_stages = 2, data => data.report.totals.first_no_recorded_assistance.correct_count = 2, data => data.report.totals.first_assisted.accuracy = 0, data => data.report.totals.retry_validated_stages = -1, data => data.report.totals.new_sessions = 1.5, data => data.report.records.push(record()), data => data.report.trend.push(day()), data => data.report.trend[0].date = '2026-02-30', data => data.report.trend[0].first_assisted_correct_count = 1]) {
    const data = observed(); mutate(data); assert.equal(validObservationReport(data), false)
  }
  const rounded = report(); const value = { ...stage(), observed_stages: 3, first_no_recorded_assistance: { count: 3, correct_count: 1, evidence_matched_count: 0, accuracy: 33.33 } }; Object.assign(rounded.report.totals, value, { CORE: value }); assert.equal(validObservationReport(rounded), true)
})
test('legacy UNKNOWN remains nullable and cannot be invented as an independent first answer', () => {
  const data = report(); data.report.totals.legacy_sessions = 1; data.report.totals.unknown_stages = 1; data.report.totals.CORE.unknown_stages = 1
  const legacy = { ...record(), first_answer: null, first_correct: null, first_evidence_rule_matched: null, assistance_status: 'UNKNOWN', reason_review_status: 'UNKNOWN', retry_completed: null, source: null, text_version: null, first_submitted_at: null }
  data.report.records = [legacy]; assert.equal(validObservationReport(data), true)
  for (const patch of [{ first_correct: true }, { first_answer: '正确' }, { assistance_status: 'NONE_RECORDED' }, { assistance_kinds: ['HINT'] }, { retry_completed: true }]) assert.equal(validObservationReport({ report: { ...data.report, records: [{ ...legacy, ...patch }] } }), false)
})
test('new records require genuine attribution, reviewed status is never implied', () => {
  for (const patch of [{ attempt_count: 0 }, { first_answer: null }, { source: null }, { first_submitted_at: 'yesterday' }, { validated_at: null }, { retry_completed: true, attempt_count: 1 }, { reason_review_status: 'REVIEWED' }, { assistance_status: 'ASSISTED' }]) {
    const data = observed(); Object.assign(data.report.records[0], patch); assert.equal(validObservationReport(data), false)
  }
  assert.match(assistanceStatusLabels.NONE_RECORDED, /未记录辅助/)
  assert.equal(assistanceLabels.RULE_CHECK, '证据覆盖规则反馈')
  assert.equal(Object.keys(assistanceLabels).length, 5)
})
test('all answer-bearing word knowledge is beneath controlled mount; raw layers remain available', async () => {
  const source = await readFile(new URL('../src/components/ContextReader.tsx', import.meta.url), 'utf8')
  assert.match(source, /showMeaning \? <WordKnowledge/)
  assert.match(source, /key=\{`\$\{sessionId\}:\$\{session.stage\}`\}/)
  assert.match(source, /disabled=\{busy \|\| !onRevealMeaning\}/)
  assert.match(source, /查看字词解释（记录为辅助）/)
  assert.match(source, /<ol>\{layers.map/)
  assert.doesNotMatch(source, /setIsMeaningAllowed|setShowMeaning/)
})
test('historical missing validation is described as unknown and timestamps are Beijing-localized', async () => {
  const source = await readFile(new URL('../src/components/ObservationReport.tsx', import.meta.url), 'utf8')
  assert.match(source, /record.assistance_status === 'UNKNOWN' \? '历史核验记录未完整保存'/)
  assert.match(source, /新观测规则核验完成/)
  assert.match(source, /timeZone: 'Asia\/Shanghai'/)
  assert.match(source, /readFor !== readKey/)
})
