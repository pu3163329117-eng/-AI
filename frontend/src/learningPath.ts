import type { AbilityLevel, AssessmentResult } from './assessment'

export const pathDimensions = ['vocabulary', 'syntax', 'context', 'chapter', 'translation', 'transfer'] as const
export type PathDimension = typeof pathDimensions[number]
export const pathDimensionLabels: Record<PathDimension, string> = { vocabulary: '字词理解', syntax: '句式理解', context: '语境推断', chapter: '篇章理解', translation: '翻译表达', transfer: '独立迁移' }
export type AbilityResultView = Pick<AssessmentResult, 'overall_score' | 'suggested_level' | 'level_status' | 'dimensions' | 'sufficiency' | 'sufficiency_reasons' | 'explanation'>
export type AbilityDimension = { score: number | null; presented_count: number; answered_count: number; correct_count: number; source_assessment_id: string | null }
export type AbilityHistory = { assessment_id: string; mode: 'PILOT' | 'FORMAL'; completed_at: string; bank_version: string; scoring_version: string; eligible_for_ability: boolean; reason: string; result: AbilityResultView }
export type LearnerAbility = { profile_id: string; level: AbilityLevel | null; level_status: 'UNASSESSED' | 'PROVISIONAL'; source_assessment_id: string | null; bank_version: string | null; scoring_version: string | null; assessed_at: string | null; dimensions: Record<PathDimension, AbilityDimension>; latest_pilot: null | { assessment_id: string; completed_at: string; bank_version: string; scoring_version: string; result: AbilityResultView }; history: AbilityHistory[]; explanation: string }
export type RecommendationCategory = 'MAIN' | 'REINFORCEMENT' | 'CHALLENGE'
export type RecommendationTask = { id: string; lesson_id: string; title: string; category: RecommendationCategory; task_type: 'WHOLE_READING' | 'FOCUSED_PRACTICE'; ability_level: AbilityLevel; dimension_tags: PathDimension[]; content_version: string; source: string; material_extent: 'FULL' | 'CHAPTER' | 'EXCERPT' | 'PROMPT'; reason: string; status: 'READY' | 'IN_PROGRESS' | 'COMPLETED' | 'UNAVAILABLE'; unavailable_reason: string | null; session_id: string | null }
export type RecommendationPlan = { id: string; profile_id: string; practice_level: AbilityLevel; level_source: 'USER_CHOICE' | 'FORMAL_ASSESSMENT' | 'FOUNDATION_DEFAULT'; created_at: string; tasks: RecommendationTask[]; gaps: string[]; explanation: string }
export const categoryLabels: Record<RecommendationCategory, string> = { MAIN: '主线学习', REINFORCEMENT: '专项补强', CHALLENGE: '新材料挑战' }
export const materialLabels: Record<RecommendationTask['material_extent'], string> = { FULL: '完整全文', CHAPTER: '完整章', EXCERPT: '连续节选', PROMPT: '题干材料' }
export const taskStatusLabels: Record<RecommendationTask['status'], string> = { READY: '可开始', IN_PROGRESS: '进行中', COMPLETED: '已完成', UNAVAILABLE: '暂不可用' }
export function recommendationProgress(plan: RecommendationPlan) {
  return { total: plan.tasks.length, completed: plan.tasks.filter(task => task.status === 'COMPLETED').length, unavailable: plan.tasks.filter(task => task.status === 'UNAVAILABLE').length }
}
export function pathReasonLabel(reason: string) { return reason.replace(/^(vocabulary|syntax|context|chapter|translation|transfer)(?=\s|[:：]|$)/, dimension => pathDimensionLabels[dimension as PathDimension]) }

type Row = Record<string, unknown>
const row = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const id = (value: unknown): value is string => text(value) && value.trim().length > 0
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const numberScore = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
const score = (value: unknown) => value === null || numberScore(value)
const level = (value: unknown) => ['L1', 'L2', 'L3'].includes(value as string)
const nullableId = (value: unknown) => value === null || id(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
function validResult(value: unknown): value is AbilityResultView {
  if (!row(value) || !score(value.overall_score) || !(value.suggested_level === null || level(value.suggested_level)) || !['PILOT_ONLY', 'INSUFFICIENT', 'PROVISIONAL'].includes(value.level_status as string) || !['HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT'].includes(value.sufficiency as string) || !strings(value.sufficiency_reasons) || !text(value.explanation) || !row(value.dimensions)) return false
  const dimensions = value.dimensions
  return pathDimensions.slice(0, 4).every(dimension => {
    const result = dimensions[dimension]
    return row(result) && score(result.score) && count(result.presented_count) && count(result.answered_count) && count(result.skipped_count) && count(result.correct_count) && result.answered_count + result.skipped_count === result.presented_count && result.correct_count <= result.answered_count && (result.score === null) === (result.answered_count === 0)
  })
}
function validHistory(value: unknown): value is AbilityHistory {
  if (!row(value) || !id(value.assessment_id) || !['PILOT', 'FORMAL'].includes(value.mode as string) || !id(value.completed_at) || !id(value.bank_version) || !id(value.scoring_version) || typeof value.eligible_for_ability !== 'boolean' || !text(value.reason) || !validResult(value.result)) return false
  if (value.mode === 'PILOT') return !value.eligible_for_ability && value.result.level_status === 'PILOT_ONLY' && value.result.suggested_level === null
  return !value.eligible_for_ability || ['PROVISIONAL', 'INSUFFICIENT'].includes(value.result.level_status)
}
export function validAbilityResponse(value: unknown): value is { ability: LearnerAbility } {
  if (!row(value) || !row(value.ability)) return false
  const ability = value.ability
  if (!id(ability.profile_id) || !(ability.level === null || level(ability.level)) || !['UNASSESSED', 'PROVISIONAL'].includes(ability.level_status as string) || !nullableId(ability.source_assessment_id) || !nullableId(ability.bank_version) || !nullableId(ability.scoring_version) || !nullableId(ability.assessed_at) || !row(ability.dimensions) || !text(ability.explanation) || !Array.isArray(ability.history) || !ability.history.every(validHistory)) return false
  for (const dimension of pathDimensions) {
    const item = ability.dimensions[dimension]
    if (!row(item) || !score(item.score) || !count(item.presented_count) || !count(item.answered_count) || !count(item.correct_count) || item.correct_count > item.answered_count || item.answered_count > item.presented_count || !nullableId(item.source_assessment_id)) return false
    if (item.score !== null && item.answered_count < 4) return false
    if (item.score === null && item.answered_count >= 4) return false
    if (dimension === 'translation' || dimension === 'transfer') { if (item.score !== null || item.presented_count !== 0 || item.answered_count !== 0 || item.correct_count !== 0 || item.source_assessment_id !== null) return false }
    if (ability.source_assessment_id === null && (item.score !== null || item.presented_count !== 0 || item.answered_count !== 0 || item.source_assessment_id !== null)) return false
    if (dimension !== 'translation' && dimension !== 'transfer' && ability.source_assessment_id !== null && item.source_assessment_id !== ability.source_assessment_id) return false
  }
  if (ability.level_status === 'UNASSESSED' && ability.level !== null) return false
  if (ability.source_assessment_id === null && [ability.bank_version, ability.scoring_version, ability.assessed_at].some(value => value !== null)) return false
  if (ability.source_assessment_id !== null && [ability.bank_version, ability.scoring_version, ability.assessed_at].some(value => value === null)) return false
  if (ability.level_status === 'PROVISIONAL' && (ability.level === null || ability.source_assessment_id === null)) return false
  if (ability.latest_pilot !== null) {
    const pilot = ability.latest_pilot
    if (!row(pilot) || !id(pilot.assessment_id) || !id(pilot.completed_at) || !id(pilot.bank_version) || !id(pilot.scoring_version) || !validResult(pilot.result) || pilot.result.level_status !== 'PILOT_ONLY' || pilot.result.suggested_level !== null) return false
  }
  return true
}
export function validRecommendationTask(value: unknown): value is RecommendationTask {
  if (!row(value) || !id(value.id) || !id(value.lesson_id) || !id(value.title) || !['MAIN', 'REINFORCEMENT', 'CHALLENGE'].includes(value.category as string) || !['WHOLE_READING', 'FOCUSED_PRACTICE'].includes(value.task_type as string) || !level(value.ability_level) || !Array.isArray(value.dimension_tags) || !value.dimension_tags.every(tag => pathDimensions.includes(tag)) || new Set(value.dimension_tags).size !== value.dimension_tags.length || !id(value.content_version) || !id(value.source) || !['FULL', 'CHAPTER', 'EXCERPT', 'PROMPT'].includes(value.material_extent as string) || !text(value.reason) || !['READY', 'IN_PROGRESS', 'COMPLETED', 'UNAVAILABLE'].includes(value.status as string) || !(value.unavailable_reason === null || text(value.unavailable_reason)) || !nullableId(value.session_id)) return false
  if (value.task_type === 'WHOLE_READING' && !['FULL', 'CHAPTER'].includes(value.material_extent as string)) return false
  if (['IN_PROGRESS', 'COMPLETED'].includes(value.status as string) && value.session_id === null) return false
  return value.status !== 'UNAVAILABLE' || id(value.unavailable_reason)
}
export function validRecommendationResponse(value: unknown): value is { plan: RecommendationPlan | null } {
  if (!row(value)) return false
  if (value.plan === null) return true
  if (!row(value.plan)) return false
  const plan = value.plan
  return id(plan.id) && id(plan.profile_id) && level(plan.practice_level) && ['USER_CHOICE', 'FORMAL_ASSESSMENT', 'FOUNDATION_DEFAULT'].includes(plan.level_source as string) && id(plan.created_at) && Array.isArray(plan.tasks) && plan.tasks.every(validRecommendationTask) && new Set(plan.tasks.map(task => task.id)).size === plan.tasks.length && strings(plan.gaps) && text(plan.explanation)
}
