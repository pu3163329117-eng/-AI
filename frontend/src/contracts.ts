/** Runtime guards for the data rendered by this client. Extra server fields are
 * allowed; missing historical optional fields are allowed, invalid values aren't. */
import { validLearningTrace } from './observations'
type Check = (value: unknown) => boolean
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text: Check = value => typeof value === 'string'
const id: Check = value => text(value) && (value as string).trim().length > 0
const number: Check = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const count: Check = value => number(value) && Number.isSafeInteger(value)
const bool: Check = value => typeof value === 'boolean'
const oneOf = (...values: string[]): Check => value => typeof value === 'string' && values.includes(value)
const optional = (check: Check): Check => value => value === undefined || check(value)
const nullable = (check: Check): Check => value => value === null || check(value)
const list = (check: Check, minimum = 0): Check => value => Array.isArray(value) && value.length >= minimum && value.every(check)
const shape = (fields: Record<string, Check>): Check => value => record(value) && Object.entries(fields).every(([key, check]) => check(value[key]))
const school = oneOf('JUNIOR', 'SENIOR')
const stage = oneOf('CORE', 'TRANSFER')
const extent = oneOf('FULL', 'CHAPTER', 'EXCERPT', 'PROMPT')
const scope = oneOf('WORD', 'SENTENCE', 'PARAGRAPH', 'WORK', 'ERA')
const reviewStatus = oneOf('UNREVIEWED', 'APPROVED', 'STALE')
const strings = list(text)
const profile = shape({ id, display_name: id, school_stage: school, total_points: count, completed_levels: count })
const lesson = shape({ id, title: text, source: text, difficulty: text, estimated_minutes: number, summary: text })
const review = shape({ status: reviewStatus, content_version: id, reviewer: nullable(text), note: nullable(text), reviewed_at: nullable(text), issues: strings })
const adminLesson: Check = value => lesson(value) && shape({ school_stage: school, status: oneOf('DRAFT', 'PUBLISHED'), textbook_tags: strings,
  theme: text, accumulation_points: strings, reasoning_points: strings, reasoning_level: text, content: optional(record), review: optional(review) })(value)
const editorialVersion: Check = value => typeof value === 'string' && /^[0-9a-f]{12}$/.test(value)
const editorialContent: Check = value => record(value) && Object.values(value).every(record)
const reviewedAt: Check = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
const createdEditorial: Check = value => adminLesson(value) && shape({ status: oneOf('DRAFT'), content: editorialContent, review: shape({ status: oneOf('UNREVIEWED'),
  content_version: editorialVersion, reviewer: value => value === null, note: value => value === null, reviewed_at: value => value === null, issues: strings }) })(value)
const signedEditorial: Check = value => adminLesson(value) && shape({ content: editorialContent, review: shape({ status: oneOf('APPROVED'), content_version: editorialVersion,
  reviewer: id, note: text, reviewed_at: reviewedAt, issues: strings }) })(value)
const position: Check = value => shape({ paragraph_index: count, start: count, end: count })(value) && record(value) && (value.end as number) > (value.start as number)
const selection: Check = value => position(value) && shape({ token: text, sentence: text, paragraph: text, scope })(value)
const annotationBasis: Check = value => position(value) && shape({ id, version: count, document_id: id,
  source: text, token: id, meaning: id, status: oneOf('DRAFT', 'APPROVED'), source_url: nullable(text), citation: text })(value)
const ruleEvidence: Check = value => selection(value) && shape({ source_kind: oneOf('ANNOTATION_SENTENCE') })(value)
const graphFields = shape({ schema_version: value => value === 1, stage, source: text, text_version: text, target: id,
  evidence: selection, reason: text, conclusion: id, evidence_rule_matched: bool,
  reason_review_status: oneOf('UNREVIEWED', 'NOT_PROVIDED'), reason_provided: optional(bool),
  basis_kind: optional(oneOf('CONTEXT', 'ANNOTATION')), annotation: optional(annotationBasis), rule_evidence: optional(ruleEvidence) })
const graph: Check = value => {
  if (!graphFields(value) || !record(value)) return false
  const length = Array.from((value.reason as string).trim()).length
  if (length > 2000 || (value.reason_review_status === 'NOT_PROVIDED') !== (length === 0)) return false
  if (value.reason_provided !== undefined && value.reason_provided !== (length > 0)) return false
  return value.basis_kind !== 'ANNOTATION' || annotationBasis(value.annotation) && ruleEvidence(value.rule_evidence)
}
const reading = shape({ paragraphs: list(text, 1), full_text: text, author: text, era: text, work_note: text,
  extent: optional(extent), text_version: optional(text), source_url: optional(text), terms: optional(strings) })
const summary = shape({ accumulation: text, reasoning: text, earned_points: count })
const trainingFields = shape({ stage, state: oneOf('AWAITING_INITIAL_ATTEMPT', 'VARIABLE_DEFERRED', 'VARIABLE_REVISITED', 'HINT_PRESENTED',
  'AWAITING_REASONING', 'ANSWER_VALIDATED', 'AWAITING_TRANSFER_ATTEMPT', 'AWAITING_TRANSFER_REASONING', 'TRANSFER_VALIDATED', 'SESSION_COMPLETED'),
  state_version: count, source: text, passage: text, variable: id, question: text, choices: list(id, 2), evidence: text,
  selected_answer: nullable(text), evidence_selected: bool, deferred: bool, hint_level: count, hint: nullable(text), feedback: text,
  transfer_ready: bool, summary_ready: bool, completed: bool, summary: nullable(summary), reading_context: optional(reading),
  context_selection: optional(nullable(selection)), reasoning_graph: optional(nullable(graph)), learning_trace: optional(validLearningTrace), profile_id: optional(id),
  lesson: optional(shape({ id, title: text, school_stage: optional(school), difficulty: optional(text), content_version: optional(text),
    review_status: optional(reviewStatus), reviewer: optional(nullable(text)), reviewed_at: optional(nullable(text)) })) })
const training: Check = value => trainingFields(value) && record(value) && (!value.completed || summary(value.summary))
const sessionEnvelope = shape({ session: training })
const createdSession = shape({ session_id: id, session: training })
const commandFields = shape({ session_id: id, session: training, state: text, state_version: count, profile: optional(profile) })
const command: Check = value => commandFields(value) && record(value) && record(value.session)
  && value.state_version === value.session.state_version && value.state === value.session.state
const skill = shape({ label: text, attempts: count, accuracy: number })
const learning = shape({ total_points: count, completed_lessons: count, completed_sessions: count, current_streak_days: count,
  weak_skills: list(skill), skill_statistics: optional(list(skill)), recent_activity: list(shape({ date: text, points: count, completed_sessions: count })) })
const achievements = shape({ achievements: list(shape({ id, label: text, description: text, unlocked: bool, current: number, target: number })),
  review_recommendation: nullable(shape({ kind: text, title: text, description: text, action_label: text })) })
const mission = shape({ mission_date: text, target_completed_sessions: number, completed_sessions_today: count, completed: bool, recommended_lesson: nullable(lesson) })
const plans = shape({ group_by: oneOf('theme', 'textbook_tag', 'reasoning_point'), plans: list(shape({ id, label: text, lesson_count: count, lessons: list(lesson) })) })
const document = shape({ id, source: text, extent: optional(extent), indexed_positions: count, annotated_positions: count, total_annotations: count, approved_annotations: optional(count) })
const annotation: Check = value => shape({ id, token: text, start: count, end: count, meaning: text, part_of_speech: text,
  variability: oneOf('CONTEXTUAL', 'STABLE'), reasoning: text, sense_key: text, status: oneOf('DRAFT', 'APPROVED'), source_url: nullable(text),
  version: optional(count), reviewer: optional(nullable(text)), reviewed_at: optional(nullable(text)), citation: optional(text) })(value)
  && record(value) && (value.end as number) > (value.start as number)
const related: Check = value => position(value) && shape({ source: text, token: text, meaning: text, sentence: text, source_url: nullable(text), relation: oneOf('SAME_SENSE', 'OTHER_SENSE') })(value)
const lookup = shape({ document: nullable(document), selection: nullable(value => position(value) && shape({ token: text, sentence: text })(value)),
  annotations: list(annotation), related: shape({ total: count, items: list(related) }), status: oneOf('ANNOTATED', 'PENDING', 'UNAVAILABLE') })
const coverage = shape({ documents: list(document), totals: shape({ documents: count, indexed_positions: count, annotated_positions: count, annotations: count, approved_annotations: optional(count) }) })
const managedAnnotation: Check = value => annotation(value) && position(value) && shape({ document_id: id, source: text, sentence: text, version: count, citation: text })(value)
const annotationDetail = shape({ annotation: managedAnnotation, history: list(shape({ version: count, action: oneOf('EDIT', 'REVIEW', 'SEED'), actor: id, note: id, created_at: text,
  payload: shape({ meaning: id, part_of_speech: id, variability: oneOf('CONTEXTUAL', 'STABLE'), reasoning: id, citation: text, source_url: text, status: oneOf('DRAFT', 'APPROVED') }) })) })
const sessions = shape({ sessions: list(shape({ session_id: id, source: text, stage, completed: bool, feedback: text, updated_at: nullable(text) })) })
const mistakes = shape({ mistakes: list(shape({ lesson_id: id, title: text, source: text, variable: text, passage: text, wrong_attempts: count, latest_attempt_at: nullable(text), review_hint: text })) })

/** Dispatch is fail-closed for unknown API contracts, not for extra JSON fields.
 * Never coerce invalid data to a success/empty state or change a saved snapshot. */
export function validateResponse(path: string, value: unknown, method = 'GET'): boolean {
  const endpoint = path.split('?')[0]
  const action = method.toUpperCase()
  if (endpoint === '/api/v1/admin/knowledge/annotations') return shape({ total: count, items: list(managedAnnotation) })(value)
  if (/^\/api\/v1\/admin\/knowledge\/annotations\/[^/]+(?:\/review)?$/.test(endpoint)) return annotationDetail(value)
  if (/^\/api\/v1\/training\/sessions\/[^/]+\/reasoning$/.test(endpoint)) return shape({ records: list(shape({ sequence_no: count, created_at: text, graph })) })(value)
  if (endpoint === '/api/knowledge/lookup') return lookup(value)
  if (endpoint === '/api/knowledge/coverage') return coverage(value)
  if (endpoint === '/api/v1/lessons') return shape({ lessons: list(lesson) })(value)
  if (endpoint === '/api/v1/training/sessions') return createdSession(value)
  if (/^\/api\/v1\/training\/sessions\/[^/]+\/commands$/.test(endpoint)) return command(value)
  if (/^\/api\/v1\/training\/sessions\/[^/]+$/.test(endpoint)) return sessionEnvelope(value)
  if (endpoint === '/api/v1/profiles' || /^\/api\/v1\/profiles\/[^/]+$/.test(endpoint)) return shape({ profile })(value)
  if (/^\/api\/v1\/profiles\/[^/]+\/sessions$/.test(endpoint)) return sessions(value)
  if (/^\/api\/v1\/profiles\/[^/]+\/mistakes$/.test(endpoint)) return mistakes(value)
  if (/^\/api\/v1\/profiles\/[^/]+\/learning-summary$/.test(endpoint)) return shape({ summary: learning })(value)
  if (/^\/api\/v1\/profiles\/[^/]+\/daily-mission$/.test(endpoint)) return shape({ mission })(value)
  if (/^\/api\/v1\/profiles\/[^/]+\/achievements$/.test(endpoint)) return achievements(value)
  if (/^\/api\/v1\/profiles\/[^/]+\/practice-plans$/.test(endpoint)) return plans(value)
  if (endpoint === '/api/v1/admin/lessons') return action === 'POST' ? shape({ lesson: createdEditorial })(value) : shape({ lessons: list(adminLesson) })(value)
  if (/^\/api\/v1\/admin\/lessons\/[^/]+\/review$/.test(endpoint) && action === 'POST') return shape({ lesson: signedEditorial })(value)
  if (/^\/api\/v1\/admin\/lessons\/[^/]+(?:\/(?:publish|review))?$/.test(endpoint)) return shape({ lesson: adminLesson })(value)
  return false
}
