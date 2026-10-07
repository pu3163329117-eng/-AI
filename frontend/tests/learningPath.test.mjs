import test from 'node:test'
import assert from 'node:assert/strict'
import { importSource } from './import-source.mjs'
const { validAbilityResponse, validRecommendationResponse, validRecommendationTask, recommendationProgress, pathReasonLabel } = await importSource('learningPath.ts')
const dimensions = ['vocabulary', 'syntax', 'context', 'chapter', 'translation', 'transfer']
const emptyDimension = () => ({ score: null, presented_count: 0, answered_count: 0, correct_count: 0, source_assessment_id: null })
const ability = () => ({ profile_id: 'p1', level: null, level_status: 'UNASSESSED', source_assessment_id: null, bank_version: null, scoring_version: null, assessed_at: null, dimensions: Object.fromEntries(dimensions.map(dimension => [dimension, emptyDimension()])), latest_pilot: null, history: [], explanation: '尚无合格正式测评。' })
const result = () => ({ overall_score: 75, suggested_level: null, level_status: 'PILOT_ONLY', sufficiency: 'HIGH', sufficiency_reasons: ['试测不定级'], explanation: '参考分', dimensions: Object.fromEntries(dimensions.slice(0, 4).map(dimension => [dimension, { score: 75, presented_count: 6, answered_count: 6, skipped_count: 0, correct_count: 4 }])) })
const pilot = () => ({ assessment_id: 'pilot1', completed_at: '2026-10-07', bank_version: 'bankv2', scoring_version: 'trialv1', result: result() })
const task = () => ({ id: 'task1', lesson_id: 'lesson1', title: '劝学字词判断', category: 'MAIN', task_type: 'FOCUSED_PRACTICE', ability_level: 'L1', dimension_tags: ['vocabulary'], content_version: 'version1', source: '劝学', material_extent: 'EXCERPT', reason: '补充真实语境练习', status: 'READY', unavailable_reason: null, session_id: null })
const plan = () => ({ id: 'plan1', profile_id: 'p1', practice_level: 'L1', level_source: 'FOUNDATION_DEFAULT', created_at: '2026-10-07', tasks: [], gaps: ['审核内容不足'], explanation: '只列实际可用任务' })

test('unassessed formal profile stays null rather than inventing zero ability', () => {
  assert.equal(validAbilityResponse({ ability: ability() }), true)
  for (const patch of [{ level: 'L1' }, { source_assessment_id: 'pilot1' }, { level_status: 'UNKNOWN' }, { dimensions: {} }]) assert.equal(validAbilityResponse({ ability: { ...ability(), ...patch } }), false)
  const zero = ability(); zero.dimensions.context.score = 0
  assert.equal(validAbilityResponse({ ability: zero }), false)
})
test('pilot references remain independent from the six formal dimensions', () => {
  const data = ability(); data.latest_pilot = pilot(); data.history = [{ assessment_id: 'pilot1', mode: 'PILOT', completed_at: '2026-10-07', bank_version: 'bankv2', scoring_version: 'trialv1', eligible_for_ability: false, reason: '待审核，不写正式档案', result: result() }]
  assert.equal(validAbilityResponse({ ability: data }), true)
  for (const patch of [{ bank_version: '' }, { scoring_version: null }]) assert.equal(validAbilityResponse({ ability: { ...data, history: [{ ...data.history[0], ...patch }] } }), false)
  for (const patch of [{ eligible_for_ability: true }, { mode: 'FORMAL', eligible_for_ability: true }]) assert.equal(validAbilityResponse({ ability: { ...data, history: [{ ...data.history[0], ...patch }] } }), false)
  const mislabeled = pilot(); mislabeled.result.suggested_level = 'L3'
  assert.equal(validAbilityResponse({ ability: { ...data, latest_pilot: mislabeled } }), false)
  const mixed = ability(); mixed.latest_pilot = pilot(); mixed.dimensions.context = { score: 75, presented_count: 6, answered_count: 6, correct_count: 4, source_assessment_id: 'pilot1' }
  assert.equal(validAbilityResponse({ ability: mixed }), false)
})
test('provisional formal observations need attribution and keep unmeasured abilities empty', () => {
  const data = ability(); Object.assign(data, { level: 'L2', level_status: 'PROVISIONAL', source_assessment_id: 'formal1', bank_version: 'approved1', scoring_version: 'trialv1', assessed_at: '2026-10-07' })
  for (const dimension of dimensions.slice(0, 4)) data.dimensions[dimension] = { score: 75, presented_count: 6, answered_count: 6, correct_count: 4, source_assessment_id: 'formal1' }
  assert.equal(validAbilityResponse({ ability: data }), true)
  for (const patch of [{ assessed_at: null }, { scoring_version: null }]) assert.equal(validAbilityResponse({ ability: { ...data, ...patch } }), false)
  data.dimensions.transfer = { score: 100, presented_count: 1, answered_count: 1, correct_count: 1, source_assessment_id: 'training1' }
  assert.equal(validAbilityResponse({ ability: data }), false)
})
test('all-skipped pilot remains null and invalid sample counts fail closed', () => {
  const data = ability(); const skipped = pilot(); skipped.result.overall_score = null; skipped.result.sufficiency = 'INSUFFICIENT'
  for (const dimension of dimensions.slice(0, 4)) skipped.result.dimensions[dimension] = { score: null, presented_count: 6, answered_count: 0, skipped_count: 6, correct_count: 0 }
  data.latest_pilot = skipped
  assert.equal(validAbilityResponse({ ability: data }), true)
  data.latest_pilot.result.dimensions.chapter.correct_count = 1
  assert.equal(validAbilityResponse({ ability: data }), false)
})
test('reviewed formal partial observations can retain sample counts without assigning a level', () => {
  const data = ability(); Object.assign(data, { source_assessment_id: 'formal-partial', bank_version: 'approved1', scoring_version: 'trialv1', assessed_at: '2026-10-07' })
  const partial = result(); partial.level_status = 'INSUFFICIENT'; partial.overall_score = 0; partial.sufficiency = 'INSUFFICIENT'
  for (const dimension of dimensions.slice(0, 4)) {
    partial.dimensions[dimension] = { score: 0, presented_count: 6, answered_count: 2, skipped_count: 4, correct_count: 0 }
    data.dimensions[dimension] = { score: null, presented_count: 6, answered_count: 2, correct_count: 0, source_assessment_id: 'formal-partial' }
  }
  data.history = [{ assessment_id: 'formal-partial', mode: 'FORMAL', completed_at: '2026-10-07', bank_version: 'approved1', scoring_version: 'trialv1', eligible_for_ability: true, reason: '原题审核合格，作答样本不足', result: partial }]
  assert.equal(validAbilityResponse({ ability: data }), true)
  data.dimensions.context.score = 0
  assert.equal(validAbilityResponse({ ability: data }), false)
})
test('empty persisted recommendation and no plan are distinct valid states', () => {
  assert.equal(validRecommendationResponse({ plan: null }), true)
  assert.equal(validRecommendationResponse({ plan: plan() }), true)
  assert.equal(validRecommendationResponse({}), false)
  assert.equal(validRecommendationResponse({ plan: { ...plan(), tasks: null } }), false)
  assert.deepEqual(recommendationProgress(plan()), { total: 0, completed: 0, unavailable: 0 })
})
test('whole reading never mislabels excerpts and each task retains its stable identity', () => {
  assert.equal(validRecommendationTask(task()), true)
  assert.equal(validRecommendationTask({ ...task(), task_type: 'WHOLE_READING', material_extent: 'FULL' }), true)
  assert.equal(validRecommendationTask({ ...task(), task_type: 'WHOLE_READING' }), false)
  for (const patch of [{ category: 'RANDOM' }, { dimension_tags: ['context', 'context'] }, { dimension_tags: ['invented'] }, { ability_level: 'L4' }, { content_version: '' }]) assert.equal(validRecommendationTask({ ...task(), ...patch }), false)
  assert.equal(validRecommendationResponse({ plan: { ...plan(), tasks: [task(), task()] } }), false)
})
test('running, completed and unavailable task states have real backing records', () => {
  assert.equal(validRecommendationTask({ ...task(), status: 'IN_PROGRESS' }), false)
  assert.equal(validRecommendationTask({ ...task(), status: 'COMPLETED', session_id: 'session1' }), true)
  assert.equal(validRecommendationTask({ ...task(), status: 'UNAVAILABLE', unavailable_reason: '审核版本变化' }), true)
  assert.equal(validRecommendationTask({ ...task(), status: 'UNAVAILABLE' }), false)
  assert.deepEqual(recommendationProgress({ ...plan(), tasks: [task(), { ...task(), id: 't2', status: 'COMPLETED', session_id: 's2' }, { ...task(), id: 't3', status: 'UNAVAILABLE', unavailable_reason: '版本变化' }] }), { total: 3, completed: 1, unavailable: 1 })
})
test('only known prefixes are localized without rewriting unknown explanation', () => {
  assert.equal(pathReasonLabel('context 作答不足'), '语境推断 作答不足')
  assert.equal(pathReasonLabel('translation:待评估'), '翻译表达:待评估')
  assert.equal(pathReasonLabel('篇章 context 待核验'), '篇章 context 待核验')
})
