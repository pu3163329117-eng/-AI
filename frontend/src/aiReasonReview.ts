/** Runtime guards for local editorial opinions, never certified AI grading. */
export const reviewDecisions = ['ACCEPTABLE', 'NEEDS_REVISION', 'UNCERTAIN'] as const
export type ReviewDecision = typeof reviewDecisions[number]
export const reviewDecisionLabels: Record<ReviewDecision, string> = { ACCEPTABLE: '认为可接受', NEEDS_REVISION: '建议修订', UNCERTAIN: '尚不能判断' }
export const reviewLabels = ['CORRECT_REASONING', 'CORRECT_BUT_GUESSING', 'PARTIALLY_CORRECT', 'WRONG_KNOWLEDGE', 'WRONG_CONTEXT', 'WRONG_SYNTAX', 'WRONG_REASONING', 'INSUFFICIENT_EVIDENCE', 'UNSCORABLE'] as const
export type ReviewLabel = typeof reviewLabels[number]
export const reviewLabelNames: Record<ReviewLabel, string> = { CORRECT_REASONING: '理由成立', CORRECT_BUT_GUESSING: '结论吻合但依据未说明', PARTIALLY_CORRECT: '部分成立', WRONG_KNOWLEDGE: '字词知识问题', WRONG_CONTEXT: '语境关系问题', WRONG_SYNTAX: '句法关系问题', WRONG_REASONING: '推断关系问题', INSUFFICIENT_EVIDENCE: '证据不足', UNSCORABLE: '无法评分' }
type Gates = { review_status: 'NOT_VERIFIED'; reviewer_identity_verified: false; semantic_accuracy_verified: false; may_update_learning: false; live_ai_release_gate_satisfied: false }
type Header = Gates & { suite_version: string; suite_digest: string }
export type ReviewFields = { reviewer: string; decision: ReviewDecision; context_sufficiency: 'SUFFICIENT' | 'INSUFFICIENT' | 'UNCERTAIN'; source_basis: string; rationale: string; alternatives: string | null; suggested_labels: ReviewLabel[] }
export type ReviewNote = Gates & { id: string; case_id: string; suite_digest: string; input_digest: string; revision: number; created_at: string; fields: ReviewFields }
export type ReviewQueue = Header & { total: number; recorded_cases: number; notes_total: number; decision_counts: Record<ReviewDecision, number>; items: { case_id: string; target: string; stage: 'CORE' | 'TRANSFER'; source: string; input_digest: string; revision: number; decision: ReviewDecision | null }[] }
type Payload = { stage: 'CORE' | 'TRANSFER'; text_version: string; target: string; student_reason: string; student_conclusion: string; visible_evidence: { id: string; text: string }[]; rubric: { id: string; criterion: string }[] }
export type ReviewDetail = Header & { case_id: string; source: string; input_digest: string; revision: number; notes: ReviewNote[]; historical_note_count: number; payload: Payload; development_expectation: { labels: ReviewLabel[]; error: 'SAFETY_BLOCKED' | null; required_evidence: string[]; required_criteria: string[]; note: string; review_status: 'NOT_VERIFIED' } }
export type ReviewWrite = { key: string; case_id: string; body: { expected_suite_digest: string; expected_input_digest: string; expected_revision: number; fields: ReviewFields } }
export type ReviewReceipt = Gates & { saved: ReviewNote; replayed: boolean }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key))
const text = (v: unknown, max: number) => typeof v === 'string' && !!v.trim() && Array.from(v).length <= max
const count = (v: unknown, max = 100) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max
const hash = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const id = (v: unknown) => text(v, 100) && /^[A-Za-z0-9_.:-]+$/.test(v as string)
const token = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(v)
const unique = (v: unknown): v is unknown[] => Array.isArray(v) && new Set(v).size === v.length
const labelList = (v: unknown) => unique(v) && v.length <= 9 && v.every(item => reviewLabels.includes(item as ReviewLabel))
const gateKeys = ['review_status', 'reviewer_identity_verified', 'semantic_accuracy_verified', 'may_update_learning', 'live_ai_release_gate_satisfied']
const gates = (v: Record<string, unknown>) => v.review_status === 'NOT_VERIFIED' && gateKeys.slice(1).every(key => v[key] === false)
const header = (v: Record<string, unknown>) => gates(v) && text(v.suite_version, 100) && hash(v.suite_digest)
const stage = (v: unknown) => v === 'CORE' || v === 'TRANSFER'
const decision = (v: unknown) => reviewDecisions.includes(v as ReviewDecision)

export function emptyReviewFields(): ReviewFields { return { reviewer: '', decision: 'UNCERTAIN', context_sufficiency: 'UNCERTAIN', source_basis: '', rationale: '', alternatives: null, suggested_labels: [] } }
export function normalizeReviewFields(v: ReviewFields): ReviewFields { return { ...v, reviewer: v.reviewer.trim(), source_basis: v.source_basis.trim(), rationale: v.rationale.trim(), alternatives: v.alternatives?.trim() || null, suggested_labels: [...v.suggested_labels] } }
export function validReviewFields(v: unknown): v is ReviewFields {
  return object(v) && keys(v, ['reviewer', 'decision', 'context_sufficiency', 'source_basis', 'rationale', 'alternatives', 'suggested_labels']) && text(v.reviewer, 80) && decision(v.decision) && ['SUFFICIENT', 'INSUFFICIENT', 'UNCERTAIN'].includes(v.context_sufficiency as string) && text(v.source_basis, 2000) && text(v.rationale, 4000) && (v.alternatives === null || text(v.alternatives, 4000)) && labelList(v.suggested_labels)
}
function validNote(v: unknown): v is ReviewNote {
  return object(v) && keys(v, [...gateKeys, 'id', 'case_id', 'suite_digest', 'input_digest', 'revision', 'created_at', 'fields']) && gates(v) && token(v.id) && id(v.case_id) && hash(v.suite_digest) && hash(v.input_digest) && count(v.revision) && (v.revision as number) > 0 && typeof v.created_at === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|\+00:00)$/.test(v.created_at) && Number.isFinite(Date.parse(v.created_at)) && validReviewFields(v.fields)
}
export function validReviewQueue(v: unknown): v is ReviewQueue {
  if (!object(v) || !keys(v, [...gateKeys, 'suite_version', 'suite_digest', 'total', 'recorded_cases', 'notes_total', 'decision_counts', 'items']) || !header(v) || !count(v.total, 128) || !count(v.recorded_cases, 128) || !count(v.notes_total, 12800) || !Array.isArray(v.items) || v.items.length !== v.total || !object(v.decision_counts) || !keys(v.decision_counts, [...reviewDecisions])) return false
  const seen = new Set<string>(), counts = { ACCEPTABLE: 0, NEEDS_REVISION: 0, UNCERTAIN: 0 }
  let notes = 0
  for (const item of v.items) {
    if (!object(item) || !keys(item, ['case_id', 'target', 'stage', 'source', 'input_digest', 'revision', 'decision']) || !id(item.case_id) || seen.has(item.case_id as string) || !text(item.target, 80) || !stage(item.stage) || !text(item.source, 200) || !hash(item.input_digest) || !count(item.revision) || ((item.revision === 0) ? item.decision !== null : !decision(item.decision))) return false
    seen.add(item.case_id as string); notes += item.revision as number
    if (item.decision !== null) counts[item.decision as ReviewDecision]++
  }
  return notes === v.notes_total && Object.values(counts).reduce((a, b) => a + b, 0) === v.recorded_cases && reviewDecisions.every(key => (v.decision_counts as Record<string, unknown>)[key] === counts[key])
}
function validPayload(v: unknown): v is Payload {
  if (!object(v) || !keys(v, ['stage', 'text_version', 'target', 'student_reason', 'student_conclusion', 'visible_evidence', 'rubric']) || !stage(v.stage) || !text(v.text_version, 200) || !text(v.target, 80) || !text(v.student_reason, 2000) || !text(v.student_conclusion, 200)) return false
  for (const [name, content] of [['visible_evidence', 'text'], ['rubric', 'criterion']] as const) {
    const rows = v[name]
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 12) return false
    const seen = new Set()
    for (const row of rows) { if (!object(row) || !keys(row, ['id', content]) || !id(row.id) || seen.has(row.id) || !text(row[content], 2000)) return false; seen.add(row.id) }
  }
  return true
}
export function validReviewDetail(v: unknown): v is ReviewDetail {
  if (!object(v) || !keys(v, [...gateKeys, 'suite_version', 'suite_digest', 'case_id', 'source', 'input_digest', 'revision', 'notes', 'historical_note_count', 'payload', 'development_expectation']) || !header(v) || !id(v.case_id) || !text(v.source, 200) || !hash(v.input_digest) || !count(v.revision) || !count(v.historical_note_count, Number.MAX_SAFE_INTEGER) || !validPayload(v.payload) || !Array.isArray(v.notes) || v.notes.length !== v.revision) return false
  if (!v.notes.every((n, i) => validNote(n) && n.revision === i + 1 && n.case_id === v.case_id && n.suite_digest === v.suite_digest && n.input_digest === v.input_digest)) return false
  const draft = v.development_expectation
  if (!object(draft) || !keys(draft, ['labels', 'error', 'required_evidence', 'required_criteria', 'note', 'review_status']) || draft.review_status !== 'NOT_VERIFIED' || !labelList(draft.labels) || !text(draft.note, 4000) || !(draft.error === null || draft.error === 'SAFETY_BLOCKED')) return false
  return ([['required_evidence', 'visible_evidence'], ['required_criteria', 'rubric']] as const).every(([field, collection]) => { const ids = draft[field]; return unique(ids) && ids.length <= 12 && ids.every(item => (v.payload as Payload)[collection].some(row => row.id === item)) })
}
export function validReviewWrite(v: unknown): v is ReviewWrite {
  if (!object(v) || !keys(v, ['key', 'case_id', 'body']) || !token(v.key) || !id(v.case_id) || !object(v.body)) return false
  return keys(v.body, ['expected_suite_digest', 'expected_input_digest', 'expected_revision', 'fields']) && hash(v.body.expected_suite_digest) && hash(v.body.expected_input_digest) && count(v.body.expected_revision) && validReviewFields(v.body.fields)
}
export function validReviewReceipt(v: unknown, operation: ReviewWrite): v is ReviewReceipt {
  if (!object(v) || !keys(v, [...gateKeys, 'saved', 'replayed']) || !gates(v) || typeof v.replayed !== 'boolean' || !validNote(v.saved) || v.saved.id !== operation.key || v.saved.case_id !== operation.case_id || v.saved.suite_digest !== operation.body.expected_suite_digest || v.saved.input_digest !== operation.body.expected_input_digest || v.saved.revision !== operation.body.expected_revision + 1) return false
  const actual = normalizeReviewFields(v.saved.fields), expected = normalizeReviewFields(operation.body.fields)
  return (Object.keys(expected) as (keyof ReviewFields)[]).every(key => key === 'suggested_labels' ? JSON.stringify(actual[key]) === JSON.stringify(expected[key]) : actual[key] === expected[key])
}
