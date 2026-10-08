/** Read-only shadow presentation. No AI output can become a training command. */
export type FeedbackPreview = {
  mode: 'SHADOW_PREVIEW'; state_version: number; stage: 'CORE' | 'TRANSFER'; text_version: string;
  rubric_version: 'reason-preview-v1'; rubric_review_status: 'NOT_VERIFIED'; may_update_learning: false;
  status: 'OK' | 'FALLBACK'; error_code: string | null; simulated: false; cached: boolean;
  summary: string; next_step: string; matched_criteria: string[]; cited_evidence: { id: string; text: string }[]; trace_id: string;
}
const errors = ['PROVIDER_TIMEOUT', 'RATE_LIMITED', 'INVALID_OUTPUT', 'SAFETY_BLOCKED', 'PROVIDER_UNAVAILABLE']
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 2000): value is string => typeof value === 'string' && value.trim().length > 0 && Array.from(value).length <= max
const unique = (values: unknown[], key: (item: unknown) => unknown) => new Set(values.map(key)).size === values.length
const keys = ['mode', 'state_version', 'stage', 'text_version', 'rubric_version', 'rubric_review_status', 'may_update_learning', 'status', 'error_code', 'simulated', 'cached', 'summary', 'next_step', 'matched_criteria', 'cited_evidence', 'trace_id']

export function validFeedbackPreview(value: unknown): value is { feedback: FeedbackPreview } {
  if (!record(value) || !record(value.feedback)) return false
  const f = value.feedback
  if (Object.keys(f).length !== keys.length || !keys.every(key => Object.hasOwn(f, key))) return false
  if (f.mode !== 'SHADOW_PREVIEW' || f.rubric_version !== 'reason-preview-v1' || f.rubric_review_status !== 'NOT_VERIFIED' || f.may_update_learning !== false || f.simulated !== false) return false
  if (!Number.isSafeInteger(f.state_version) || (f.state_version as number) < 1 || !['CORE', 'TRANSFER'].includes(f.stage as string)) return false
  if (!text(f.text_version, 200) || !text(f.trace_id, 100) || typeof f.cached !== 'boolean' || !text(f.summary, 500) || !text(f.next_step, 500)) return false
  if (!Array.isArray(f.matched_criteria) || f.matched_criteria.length > 3 || !f.matched_criteria.every(item => text(item, 200)) || !unique(f.matched_criteria, item => item)) return false
  if (!Array.isArray(f.cited_evidence) || f.cited_evidence.length > 2 || !f.cited_evidence.every(item => record(item) && Object.keys(item).length === 2 && text(item.id, 100) && text(item.text)) || !unique(f.cited_evidence, item => (item as { id: string }).id)) return false
  return f.status === 'OK' ? f.error_code === null : f.status === 'FALLBACK' && errors.includes(f.error_code as string) && f.matched_criteria.length === 0 && f.cited_evidence.length === 0
}

export const previewMessages: Record<string, string> = {
  AI_CONFIGURATION_INVALID: '本机模型配置无效，请检查后端配置，不要分享 Key。',
  AI_PREVIEW_DISABLED: '本机影子试用尚未启用，正常训练仍可继续。',
  AI_LOCAL_PREVIEW_ONLY: '目前只允许在本机试用模型反馈，内网同事仍可使用正常训练。',
  AI_FIRST_ATTEMPT_REQUIRED: '请先提交本阶段首次词义判断，再保存理由并试用反馈。',
  AI_REASONING_REQUIRED: '请先保存本阶段有效的证据与理由。',
  AI_FEEDBACK_STALE: '训练进度已变化，这次反馈不再适用。请核对当前保存的理由后重新请求。',
  AI_FEEDBACK_BUSY: '本机正在处理另一条反馈，请稍后手动重试。',
}

export function previewRequest(version: number) {
  return { expected_state_version: version, send_minimal_data: true }
}

export function previewMatches(feedback: FeedbackPreview, version: number, stage: string, textVersion?: string) {
  return feedback.state_version === version && feedback.stage === stage && feedback.text_version === textVersion
}
