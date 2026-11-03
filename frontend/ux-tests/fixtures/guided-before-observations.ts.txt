export const observationStages = ['CORE', 'TRANSFER'] as const
export type ObservationStage = typeof observationStages[number]
export const assistanceKinds = ['WORD_MEANING', 'HINT', 'PRESET_EVIDENCE', 'FEEDBACK', 'RULE_CHECK'] as const
export type AssistanceKind = typeof assistanceKinds[number]
export type AssistanceStatus = 'NONE_RECORDED' | 'ASSISTED' | 'UNKNOWN'
export type MeaningMode = 'TRACKED' | 'LEGACY' | 'REVIEW'
export type FirstLearningAttempt = { answer: string; correct: boolean; evidence_rule_matched: boolean; assistance_status: 'NONE_RECORDED' | 'ASSISTED'; assistance_kinds: AssistanceKind[]; reason_review_status: 'UNREVIEWED'; source: string; text_version: string }
export type StageLearningTrace = { attempt_count: number; assistance_kinds: AssistanceKind[]; first_attempt: FirstLearningAttempt | null; validated: boolean }
export type LearningTrace = { schema_version: 1; stages: Record<ObservationStage, StageLearningTrace> }
export type AttemptGroup = { count: number; correct_count: number; evidence_matched_count: number; accuracy: number | null }
export type StageObservationTotals = { observed_stages: number; unknown_stages: number; validated_stages: number; retry_validated_stages: number; first_no_recorded_assistance: AttemptGroup; first_assisted: AttemptGroup }
export type ObservationTotals = StageObservationTotals & { new_sessions: number; legacy_sessions: number; CORE: StageObservationTotals; TRANSFER: StageObservationTotals }
export type ObservationTrend = { date: string; observed_stages: number; first_no_recorded_assistance_count: number; first_no_recorded_assistance_correct_count: number; first_assisted_count: number; first_assisted_correct_count: number; retry_validated_stages: number }
export type ObservationRecord = { session_id: string; stage: ObservationStage; first_answer: string | null; first_correct: boolean | null; first_evidence_rule_matched: boolean | null; assistance_status: AssistanceStatus; assistance_kinds: AssistanceKind[]; attempt_count: number; validated: boolean; retry_completed: boolean | null; reason_review_status: 'UNREVIEWED' | 'UNKNOWN'; lesson_id: string | null; source: string | null; text_version: string | null; first_submitted_at: string | null; validated_at: string | null }
export type ObservationReportData = { profile_id: string; schema_version: 1; scope: 'LEARNING_BEHAVIOR'; explanation: string; totals: ObservationTotals; trend: ObservationTrend[]; records: ObservationRecord[] }
export const observationStageLabels: Record<ObservationStage, string> = { CORE: '核心判断', TRANSFER: '迁移判断' }
export const assistanceLabels: Record<AssistanceKind, string> = { WORD_MEANING: '字词解释', HINT: '提示', PRESET_EVIDENCE: '预设证据', FEEDBACK: '判断反馈', RULE_CHECK: '证据覆盖规则反馈' }
export const assistanceStatusLabels: Record<AssistanceStatus, string> = { NONE_RECORDED: '首次判断前未记录辅助', ASSISTED: '首次判断前已记录辅助', UNKNOWN: '旧记录 · 辅助状态未知' }
export function meaningMayBeShown(mode: MeaningMode, confirmed: boolean) { return mode === 'LEGACY' || mode === 'REVIEW' || mode === 'TRACKED' && confirmed === true }
export function observationRate(value: number | null) { return value === null ? '暂无样本' : `${value.toFixed(1)}%` }

type Row = Record<string, unknown>
const row = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const boolean = (value: unknown): value is boolean => typeof value === 'boolean'
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
const dayString = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
const nullable = (value: unknown, check: (value: unknown) => boolean) => value === null || check(value)
const kinds = (value: unknown): value is AssistanceKind[] => Array.isArray(value) && value.every(item => assistanceKinds.includes(item)) && new Set(value).size === value.length
function validFirst(value: unknown): value is FirstLearningAttempt {
  if (!row(value) || !id(value.answer) || !boolean(value.correct) || !boolean(value.evidence_rule_matched) || !['NONE_RECORDED', 'ASSISTED'].includes(value.assistance_status as string) || !kinds(value.assistance_kinds) || value.reason_review_status !== 'UNREVIEWED' || !id(value.source) || !id(value.text_version)) return false
  return value.assistance_status === 'NONE_RECORDED' ? value.assistance_kinds.length === 0 : value.assistance_kinds.length > 0
}
export function validLearningTrace(value: unknown): value is LearningTrace {
  if (!row(value) || value.schema_version !== 1 || !row(value.stages)) return false
  const stages = value.stages
  return observationStages.every(stage => {
    const entry = stages[stage]
    if (!row(entry) || !count(entry.attempt_count) || !kinds(entry.assistance_kinds) || !boolean(entry.validated) || !nullable(entry.first_attempt, validFirst)) return false
    const recordedKinds = entry.assistance_kinds
    if ((entry.first_attempt === null) !== (entry.attempt_count === 0)) return false
    if (entry.first_attempt && (entry.first_attempt as FirstLearningAttempt).assistance_kinds.some(kind => !recordedKinds.includes(kind))) return false
    return !entry.validated || entry.attempt_count > 0
  })
}
function validAttemptGroup(value: unknown): value is AttemptGroup {
  if (!row(value) || !count(value.count) || !count(value.correct_count) || !count(value.evidence_matched_count) || value.correct_count > value.count || value.evidence_matched_count > value.count) return false
  if (value.count === 0) return value.accuracy === null
  return typeof value.accuracy === 'number' && Number.isFinite(value.accuracy) && value.accuracy >= 0 && value.accuracy <= 100 && Math.abs(value.accuracy - value.correct_count / value.count * 100) <= .011
}
function validStageTotals(value: unknown): value is StageObservationTotals {
  if (!row(value) || !['observed_stages', 'unknown_stages', 'validated_stages', 'retry_validated_stages'].every(key => count(value[key])) || !validAttemptGroup(value.first_no_recorded_assistance) || !validAttemptGroup(value.first_assisted)) return false
  return value.observed_stages === value.first_no_recorded_assistance.count + value.first_assisted.count && (value.retry_validated_stages as number) <= (value.validated_stages as number) && (value.validated_stages as number) <= (value.observed_stages as number) + (value.unknown_stages as number)
}
function validRecord(value: unknown): value is ObservationRecord {
  if (!row(value) || !id(value.session_id) || !observationStages.includes(value.stage as ObservationStage) || !nullable(value.first_answer, id) || !nullable(value.first_correct, boolean) || !nullable(value.first_evidence_rule_matched, boolean) || !['NONE_RECORDED', 'ASSISTED', 'UNKNOWN'].includes(value.assistance_status as string) || !kinds(value.assistance_kinds) || !count(value.attempt_count) || !boolean(value.validated) || !nullable(value.retry_completed, boolean) || !['UNREVIEWED', 'UNKNOWN'].includes(value.reason_review_status as string) || !nullable(value.lesson_id, id) || !nullable(value.source, id) || !nullable(value.text_version, id) || !nullable(value.first_submitted_at, id) || !nullable(value.validated_at, id)) return false
  if (!nullable(value.validated_at, timestamp) || value.validated !== (value.validated_at !== null)) return false
  if (value.assistance_status === 'UNKNOWN') return [value.first_answer, value.first_correct, value.first_evidence_rule_matched, value.first_submitted_at, value.source, value.text_version, value.retry_completed].every(value => value === null) && value.assistance_kinds.length === 0 && value.reason_review_status === 'UNKNOWN'
  if ([value.first_answer, value.first_correct, value.first_evidence_rule_matched, value.first_submitted_at, value.source, value.text_version, value.retry_completed].some(value => value === null) || value.reason_review_status !== 'UNREVIEWED' || value.attempt_count < 1) return false
  if (value.retry_completed && (!value.validated || value.attempt_count < 2)) return false
  if (!timestamp(value.first_submitted_at) || !nullable(value.validated_at, timestamp) || value.validated !== (value.validated_at !== null)) return false
  return value.assistance_status === 'NONE_RECORDED' ? value.assistance_kinds.length === 0 : value.assistance_kinds.length > 0
}
export function validObservationReport(value: unknown): value is { report: ObservationReportData } {
  if (!row(value) || !row(value.report)) return false
  const report = value.report
  if (!id(report.profile_id) || report.schema_version !== 1 || report.scope !== 'LEARNING_BEHAVIOR' || typeof report.explanation !== 'string' || !row(report.totals) || !Array.isArray(report.trend) || !Array.isArray(report.records) || report.records.length > 50 || !report.records.every(validRecord)) return false
  const totals = report.totals
  if (!count(totals.new_sessions) || !count(totals.legacy_sessions) || !validStageTotals(totals.CORE) || !validStageTotals(totals.TRANSFER) || !validStageTotals(totals)) return false
  const allTotals = totals as ObservationTotals
  for (const key of ['observed_stages', 'unknown_stages', 'validated_stages', 'retry_validated_stages'] as const) if (allTotals[key] !== allTotals.CORE[key] + allTotals.TRANSFER[key]) return false
  for (const key of ['first_no_recorded_assistance', 'first_assisted'] as const) for (const counter of ['count', 'correct_count', 'evidence_matched_count'] as const) if (allTotals[key][counter] !== allTotals.CORE[key][counter] + allTotals.TRANSFER[key][counter]) return false
  if (new Set(report.records.map(record => `${record.session_id}:${record.stage}`)).size !== report.records.length) return false
  return report.trend.every(day => row(day) && dayString(day.date) && ['observed_stages', 'first_no_recorded_assistance_count', 'first_no_recorded_assistance_correct_count', 'first_assisted_count', 'first_assisted_correct_count', 'retry_validated_stages'].every(key => count(day[key])) && (day.first_no_recorded_assistance_correct_count as number) <= (day.first_no_recorded_assistance_count as number) && (day.first_assisted_correct_count as number) <= (day.first_assisted_count as number) && day.observed_stages === (day.first_no_recorded_assistance_count as number) + (day.first_assisted_count as number)) && new Set(report.trend.map(day => day.date)).size === report.trend.length
}
