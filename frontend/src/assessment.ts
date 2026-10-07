export const assessmentDimensions = ['vocabulary', 'syntax', 'context', 'chapter'] as const
export type AssessmentDimension = typeof assessmentDimensions[number]
export type AbilityLevel = 'L1' | 'L2' | 'L3'
export type AssessmentMode = 'PILOT' | 'FORMAL'
export type SelfAnswers = { level: 'L1' | 'L2' | 'L3' | 'UNSURE'; goal: 'FOUNDATION' | 'READING' | 'EXAM' | 'INTEREST'; word_strategy: 'CONTEXT' | 'NOTES' | 'GUESS' | 'UNSURE'; reading_experience: 'NEW' | 'GUIDED' | 'INDEPENDENT' | 'UNSURE' }
export type AssessmentStatus = 'IN_PROGRESS' | 'COMPLETED' | 'ABANDONED'
export type AssessmentExtent = 'FULL' | 'CHAPTER' | 'EXCERPT' | 'PROMPT'
export type AssessmentQuestion = { id: string; version: number | string; dimension: AssessmentDimension; difficulty: AbilityLevel; stem: string; source: string; source_url: string; passage: string; material_extent?: AssessmentExtent; passage_extent?: AssessmentExtent; text_version?: string; options: { id: string; text: string }[] }
export type DimensionResult = { score: number | null; presented_count: number; answered_count: number; skipped_count: number; correct_count: number }
export type AssessmentResult = { overall_score: number | null; suggested_level: AbilityLevel | null; level_status: 'PILOT_ONLY' | 'INSUFFICIENT' | 'PROVISIONAL'; dimensions: Record<AssessmentDimension, DimensionResult>; sufficiency: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT'; sufficiency_reasons: string[]; strengths: string[]; weaknesses: string[]; explanation: string; review: { question_id: string; correct_option_id: string; explanation: string }[] }
export type AssessmentSession = { id: string; profile_id: string; mode: AssessmentMode; status: AssessmentStatus; state_version: number; bank_version: string; scoring_version: string; self_level: AbilityLevel | null; self_answers?: Partial<SelfAnswers>; created_at: string; updated_at: string; current_index: number; questions: AssessmentQuestion[]; answers: Record<string, string | null>; result: AssessmentResult | null }
export type AssessmentSummary = { id: string; mode: AssessmentMode; status: AssessmentStatus; current_index: number; created_at: string; updated_at: string; question_count: number; answered_count: number; skipped_count: number }
export type AssessmentAvailability = { pilot_available: boolean; formal_available: boolean; pilot_question_count: number; approved_question_count: number; questions_per_session: number; bank_version: string; reason: string }
export type AssessmentCommand = { type: 'SAVE_ANSWER' | 'SKIP_QUESTION' | 'COMPLETE_ASSESSMENT' | 'ABANDON_ASSESSMENT'; expected_state_version: number; payload: { question_id?: string; option_id?: string; current_index?: number } }

export const dimensionLabels: Record<AssessmentDimension, string> = { vocabulary: '字词辨义', syntax: '句式理解', context: '语境推断', chapter: '篇章理解' }
export function assessmentReasonLabel(reason: string) {
  // Display-only localization: stored result text and unknown explanations stay intact.
  return reason.replace(/^(vocabulary|syntax|context|chapter)(?=\s|[:：]|$)/, dimension => dimensionLabels[dimension as AssessmentDimension])
}
const extentLabels: Record<AssessmentExtent, string> = { FULL: '全文', CHAPTER: '完整章', EXCERPT: '连续节选', PROMPT: '题干范围' }
export function assessmentPassageLabel(question: AssessmentQuestion) {
  if (!question.material_extent && !question.passage_extent && !question.text_version) return `本题原文 · 题目版本 ${question.version}`
  return `本题原文 · ${question.passage_extent ? extentLabels[question.passage_extent] : '选段范围未登记'} · ${question.text_version ?? '原文版本未登记'}`
}
export function answerCounts(session: AssessmentSession) {
  let answered = 0; let skipped = 0
  for (const question of session.questions) {
    if (!Object.hasOwn(session.answers, question.id)) continue
    if (session.answers[question.id] === null) skipped++
    else answered++
  }
  return { answered, skipped, resolved: answered + skipped, remaining: session.questions.length - answered - skipped }
}

type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const id = (value: unknown): value is string => text(value) && value.length > 0
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const score = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100)
const level = (value: unknown) => ['L1', 'L2', 'L3'].includes(value as string)
const strings = (value: unknown) => Array.isArray(value) && value.every(text)
const mode = (value: unknown) => value === 'PILOT' || value === 'FORMAL'
const status = (value: unknown) => ['IN_PROGRESS', 'COMPLETED', 'ABANDONED'].includes(value as string)
const selfAnswerOptions: Record<keyof SelfAnswers, readonly string[]> = { level: ['L1', 'L2', 'L3', 'UNSURE'], goal: ['FOUNDATION', 'READING', 'EXAM', 'INTEREST'], word_strategy: ['CONTEXT', 'NOTES', 'GUESS', 'UNSURE'], reading_experience: ['NEW', 'GUIDED', 'INDEPENDENT', 'UNSURE'] }
function validSelfAnswers(value: unknown) { return object(value) && Object.entries(value).every(([key, answer]) => Object.hasOwn(selfAnswerOptions, key) && selfAnswerOptions[key as keyof SelfAnswers].includes(answer as string)) }
export function safeSourceUrl(value: string) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null }
}
export function validAvailability(value: unknown): value is AssessmentAvailability {
  return object(value) && typeof value.pilot_available === 'boolean' && typeof value.formal_available === 'boolean' && count(value.pilot_question_count) && count(value.approved_question_count) && value.questions_per_session === 24 && id(value.bank_version) && text(value.reason)
}
function validQuestion(value: unknown): value is AssessmentQuestion {
  if (!object(value) || !id(value.id) || !(count(value.version) || id(value.version)) || !assessmentDimensions.includes(value.dimension as AssessmentDimension) || !level(value.difficulty) || !id(value.stem) || !text(value.source) || !text(value.source_url) || !id(value.passage) || !Array.isArray(value.options) || value.options.length < 2) return false
  if (['material_extent', 'passage_extent'].some(key => Object.hasOwn(value, key) && !['FULL', 'CHAPTER', 'EXCERPT', 'PROMPT'].includes(value[key] as string))) return false
  if (Object.hasOwn(value, 'text_version') && !id(value.text_version)) return false
  // An unfinished response must never carry answer-bearing fields.
  if (['correct_option_id', 'correct_answer', 'answer', 'answer_id', 'explanation'].some(key => Object.hasOwn(value, key))) return false
  return value.options.every(option => object(option) && id(option.id) && id(option.text) && !['correct', 'is_correct', 'explanation'].some(key => Object.hasOwn(option, key))) && new Set(value.options.map(option => option.id)).size === value.options.length
}
function validResult(value: unknown, questions: AssessmentQuestion[], answers: Record<string, unknown>) : value is AssessmentResult {
  if (!object(value) || !score(value.overall_score) || !(value.suggested_level === null || level(value.suggested_level)) || !['PILOT_ONLY', 'INSUFFICIENT', 'PROVISIONAL'].includes(value.level_status as string) || !['HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT'].includes(value.sufficiency as string) || !strings(value.sufficiency_reasons) || !strings(value.strengths) || !strings(value.weaknesses) || !text(value.explanation) || !object(value.dimensions) || !Array.isArray(value.review)) return false
  for (const dimension of assessmentDimensions) {
    const result = value.dimensions[dimension]
    if (!object(result) || !score(result.score) || !['presented_count', 'answered_count', 'skipped_count', 'correct_count'].every(key => count(result[key]))) return false
    if ((result.answered_count as number) + (result.skipped_count as number) !== result.presented_count || (result.correct_count as number) > (result.answered_count as number) || result.presented_count !== questions.filter(question => question.dimension === dimension).length) return false
    const actualAnswered = questions.filter(question => question.dimension === dimension && answers[question.id] !== null).length
    if (result.answered_count !== actualAnswered || (result.score === null) !== (actualAnswered === 0)) return false
  }
  if ((value.overall_score === null) !== Object.values(answers).every(answer => answer === null)) return false
  return value.review.length === questions.length && new Set(value.review.map(entry => object(entry) ? entry.question_id : null)).size === questions.length && value.review.every(entry => {
    if (!object(entry) || !id(entry.question_id) || !id(entry.correct_option_id) || !text(entry.explanation)) return false
    return questions.some(question => question.id === entry.question_id && question.options.some(option => option.id === entry.correct_option_id))
  })
}
export function validAssessment(value: unknown): value is AssessmentSession {
  if (!object(value) || !id(value.id) || !id(value.profile_id) || !mode(value.mode) || !status(value.status) || !count(value.state_version) || !id(value.bank_version) || !id(value.scoring_version) || !(value.self_level === null || level(value.self_level)) || !id(value.created_at) || !id(value.updated_at) || !count(value.current_index) || !Array.isArray(value.questions) || value.questions.length !== 24 || !value.questions.every(validQuestion) || !object(value.answers)) return false
  const questions = value.questions as AssessmentQuestion[]
  if (value.self_answers !== undefined && !validSelfAnswers(value.self_answers)) return false
  if (value.current_index >= questions.length || new Set(questions.map(question => question.id)).size !== questions.length) return false
  if (!Object.entries(value.answers).every(([questionId, answer]) => questions.some(question => question.id === questionId && (answer === null || question.options.some(option => option.id === answer))))) return false
  if (value.status !== 'COMPLETED') return value.result === null
  if (Object.keys(value.answers).length !== questions.length || !validResult(value.result, questions, value.answers)) return false
  return value.mode !== 'PILOT' || (value.result.level_status === 'PILOT_ONLY' && value.result.suggested_level === null)
}
export function validAssessmentSummaries(value: unknown): value is { assessments: AssessmentSummary[] } {
  return object(value) && Array.isArray(value.assessments) && value.assessments.every(item => object(item) && id(item.id) && mode(item.mode) && status(item.status) && count(item.current_index) && id(item.created_at) && id(item.updated_at) && count(item.question_count) && count(item.answered_count) && count(item.skipped_count) && item.answered_count + item.skipped_count <= item.question_count)
}
