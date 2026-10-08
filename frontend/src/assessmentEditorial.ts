/** Dedicated editorial contracts. Never use this answer-bearing payload in learner views. */
export const editorialDimensions = ['vocabulary', 'syntax', 'context', 'chapter'] as const
export const editorialStates = ['DRAFT', 'APPROVED', 'REJECTED'] as const
export const editorialDimensionLabels: Record<string, string> = { vocabulary: '字词辨义', syntax: '句式理解', context: '语境推断', chapter: '篇章理解' }
export const editorialStatusLabels: Record<string, string> = { DRAFT: '草稿 · 待审核', APPROVED: '已署名审核', REJECTED: '已退回' }
export type EditorialQuestion = {
  id: string; version: string; dimension: typeof editorialDimensions[number]; difficulty: 'L1' | 'L2' | 'L3'; type: 'choice';
  stem: string; source: string; source_url: string; passage: string; text_version: string;
  material_extent: 'FULL' | 'CHAPTER' | 'EXCERPT' | 'PROMPT'; passage_extent: 'FULL' | 'CHAPTER' | 'EXCERPT' | 'PROMPT';
  paragraph_index: number | null; start: number | null; end: number | null; full_text_start: number; full_text_end: number;
  options: { id: string; text: string }[]; answer_id: string; explanation: string; tags: string[];
  review_status: typeof editorialStates[number]; reviewer: string | null; reviewed_at: string | null;
}
export type EditorialFields = Omit<EditorialQuestion, 'id' | 'version' | 'review_status' | 'reviewer' | 'reviewed_at'>
type Validation = { validation_valid?: boolean; validation_error?: string | null }
export type QuestionRevision = Validation & { version: string; action: 'SEED' | 'EDIT' | 'APPROVE' | 'REJECT'; actor: string | null; note: string | null; created_at: string; payload: EditorialQuestion }
export type QuestionDetail = Validation & { question: EditorialQuestion; version: number; revision_version: string; actor: string | null; note: string | null; updated_at: string | null; reviewer_is_authenticated: false; history: QuestionRevision[] }
export type QuestionList = { items: QuestionDetail[]; total: number; limit: number; offset: number; disclaimer: string }
export type EditorialWrite = { id: string; key: string; method: 'PATCH' | 'POST'; body: { expected_version: number; actor: string; note: string; question?: EditorialFields; decision?: 'APPROVE' | 'REJECT' } }

type Row = Record<string, unknown>
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const nonempty = (value: unknown): value is string => text(value) && value.trim().length > 0
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const date = (value: unknown) => nonempty(value) && Number.isFinite(Date.parse(value))
const nullableText = (value: unknown) => value === null || text(value)
const extent = (value: unknown) => ['FULL', 'CHAPTER', 'EXCERPT', 'PROMPT'].includes(value as string)
export function editorialSourceUrl(value: string) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null }
}
function validFields(value: unknown, strictSource = true): boolean {
  if (!object(value) || !editorialDimensions.includes(value.dimension as typeof editorialDimensions[number]) || !['L1', 'L2', 'L3'].includes(value.difficulty as string) || value.type !== 'choice') return false
  if (!['stem', 'source', 'passage', 'text_version', 'explanation', 'answer_id'].every(key => nonempty(value[key])) || !text(value.source_url) || (strictSource && !editorialSourceUrl(value.source_url))) return false
  if (!extent(value.material_extent) || !extent(value.passage_extent) || !count(value.full_text_start) || !count(value.full_text_end)) return false
  if (![value.paragraph_index, value.start, value.end].every(v => v === null || count(v))) return false
  if (strictSource && (value.full_text_end - value.full_text_start !== Array.from(value.passage as string).length || (value.paragraph_index === null ? value.start !== null || value.end !== null : !count(value.start) || !count(value.end) || value.end - value.start !== Array.from(value.passage as string).length))) return false
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 8 || !value.options.every(option => object(option) && nonempty(option.id) && nonempty(option.text))) return false
  if (new Set(value.options.map(option => option.id)).size !== value.options.length || !value.options.some(option => option.id === value.answer_id)) return false
  if (!Array.isArray(value.tags) || !value.tags.every(nonempty) || new Set(value.tags).size !== value.tags.length) return false
  return true
}
export function validEditorialQuestion(value: unknown, strictSource = true): value is EditorialQuestion {
  if (!object(value) || !nonempty(value.id) || !nonempty(value.version) || !validFields(value, strictSource) || !editorialStates.includes(value.review_status as typeof editorialStates[number])) return false
  return value.review_status === 'DRAFT' ? value.reviewer === null && value.reviewed_at === null : nonempty(value.reviewer) && date(value.reviewed_at)
}
export function validQuestionDetail(value: unknown): value is QuestionDetail {
  if (!object(value) || !validValidation(value) || !validEditorialQuestion(value.question, value.validation_valid !== false) || !count(value.version) || value.revision_version !== value.question.version || !nullableText(value.actor) || !nullableText(value.note) || !(value.updated_at === null || date(value.updated_at)) || value.reviewer_is_authenticated !== false || !Array.isArray(value.history) || !value.history.length) return false
  const question = value.question
  if (!value.history.every(item => object(item) && validValidation(item) && nonempty(item.version) && ['SEED', 'EDIT', 'APPROVE', 'REJECT'].includes(item.action as string) && nullableText(item.actor) && nullableText(item.note) && date(item.created_at) && validEditorialQuestion(item.payload, item.validation_valid !== false) && item.payload.id === question.id && item.payload.version === item.version)) return false
  if (new Set(value.history.map(item => item.version)).size !== value.history.length) return false
  // History may be returned newest-first or oldest-first, but must contain this exact revision.
  const head = value.history.find(item => item.version === value.revision_version)
  return !!head && head.validation_valid === value.validation_valid && head.validation_error === value.validation_error && sameQuestion(head.payload, value.question)
}
function validValidation(value: Row) {
  if (value.validation_valid === undefined) return value.validation_error === undefined
  return value.validation_valid === true ? value.validation_error === null : value.validation_valid === false && nonempty(value.validation_error)
}
export function validQuestionList(value: unknown): value is QuestionList {
  return object(value) && Array.isArray(value.items) && value.items.every(validQuestionDetail) && count(value.total) && count(value.limit) && value.limit > 0 && count(value.offset) && nonempty(value.disclaimer) && value.items.length <= value.limit && value.items.length <= Math.max(0, value.total - value.offset) && new Set(value.items.map(item => item.question.id)).size === value.items.length
}
export function fieldsForQuestion(question: EditorialQuestion): EditorialFields {
  // Explicit allow-list excludes server-owned editorial metadata as well as review/version fields.
  return {
    dimension: question.dimension, difficulty: question.difficulty, type: question.type,
    stem: question.stem, source: question.source, source_url: question.source_url, passage: question.passage,
    text_version: question.text_version, material_extent: question.material_extent, passage_extent: question.passage_extent,
    paragraph_index: question.paragraph_index, start: question.start, end: question.end,
    full_text_start: question.full_text_start, full_text_end: question.full_text_end,
    options: question.options.map(option => ({ id: option.id, text: option.text })), answer_id: question.answer_id,
    explanation: question.explanation, tags: [...question.tags],
  }
}
function sameQuestion(a: unknown, b: EditorialQuestion) {
  if (!validEditorialQuestion(a, false)) return false
  return a.id === b.id && a.version === b.version && a.review_status === b.review_status && a.reviewer === b.reviewer && a.reviewed_at === b.reviewed_at && sameFields(fieldsForQuestion(a), fieldsForQuestion(b))
}
export function sameFields(a: EditorialFields, b: EditorialFields) {
  return Object.keys(a).length === Object.keys(b).length && (Object.keys(a) as (keyof EditorialFields)[]).every(key => JSON.stringify(a[key]) === JSON.stringify(b[key]))
}
export function validEditorialWrite(value: unknown): value is EditorialWrite {
  if (!object(value) || !nonempty(value.id) || !nonempty(value.key) || !object(value.body) || !count(value.body.expected_version) || !nonempty(value.body.actor) || !nonempty(value.body.note)) return false
  const body = value.body
  const question = body.question
  if (value.method === 'PATCH') return body.decision === undefined && validFields(question) && object(question) && !['id', 'version', 'review_status', 'reviewer', 'reviewed_at', 'editorial'].some(key => Object.hasOwn(question, key))
  return value.method === 'POST' && value.body.question === undefined && ['APPROVE', 'REJECT'].includes(value.body.decision as string)
}
export function editorialDraftIssues(fields: EditorialFields) {
  const issues: string[] = []
  if (!fields.stem.trim()) issues.push('题干不能为空。')
  if (fields.options.some(option => !option.text.trim())) issues.push('每个选项都需要文字。')
  if (new Set(fields.options.map(option => option.text.trim())).size !== fields.options.length) issues.push('选项文字不能完全相同。')
  if (!fields.options.some(option => option.id === fields.answer_id)) issues.push('请选择属于本题的正确选项。')
  if (!fields.explanation.trim()) issues.push('解析不能为空。')
  if (fields.tags.length > 30 || fields.tags.some(tag => Array.from(tag).length > 120)) issues.push('专项标签最多 30 项，每项不超过 120 字。')
  return issues
}
