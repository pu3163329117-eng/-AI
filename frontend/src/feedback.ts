import type { SupportKind } from './betaSupport'

export type FeedbackCategory = 'bug' | 'suggestion' | 'other'
export type FeedbackStatus = 'received' | 'in_progress' | 'resolved' | 'withdrawn'
export type FeedbackDraft = { message: string; device: string; category: FeedbackCategory; consent: boolean }
export type FeedbackPayload = { request_id: string; kind: SupportKind; category: FeedbackCategory; message: string; device: string; page: string; build_version: string }
export type FeedbackReceipt = { id: string; reference: string; kind: SupportKind; status: FeedbackStatus; created_at: string }
export type FeedbackReply = { id: string; message: string; created_at: string }
export type FeedbackDetail = { receipt: FeedbackReceipt; category: FeedbackCategory; message: string; page: string; build_version: string; updated_at: string; replies: FeedbackReply[] }
export const feedbackStatuses: Record<FeedbackStatus, string> = { received: '已收到', in_progress: '处理中', resolved: '已处理', withdrawn: '已撤回' }
export const feedbackKinds: Record<SupportKind, string> = { feedback: '使用反馈', privacy: '隐私与数据', deletion: '申请删除数据' }
export function feedbackRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128
  const text = Array.from(b, value => value.toString(16).padStart(2, '0')).join('')
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function validFeedbackId(value: unknown): value is string { return typeof value === 'string' && uuid.test(value) }
function utcDate(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) && Number.isFinite(Date.parse(value)) }
function boundedText(value: unknown, minimum: number, maximum: number): value is string { return typeof value === 'string' && Array.from(value.trim()).length >= minimum && Array.from(value).length <= maximum }
const pages = new Set(['home', 'training', 'skills', 'assessment', 'practice', 'review', 'profile', 'report', 'admin', 'onboarding', 'about'])
// Historical server records have a wider contract than the deliberately
// conservative metadata attached to new frontend submissions.
const detailPages = new Set(['#/home', '#/onboarding', '#/tour', '#/training', '#/assessment', '#/practice', '#/review', '#/profile', '#/report', '#/ability', '#/skills', '#/admin', '#/login', '#/other', '#/about'])
export function feedbackPage(hash: string) {
  const page = /^#\/([a-z]+)(?:\/[^/?#]+)?(?:[?#].*)?$/.exec(hash)?.[1]
  return page && pages.has(page) ? `#/${page}` : '#/home'
}
export function feedbackBuild(value: string) { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) ? value : 'development-preview' }
/** A best-effort guard, not a claim that arbitrary free text is anonymized. */
export function containsFeedbackSecret(value: string) {
  return /\b(?:sk|re)_[A-Za-z0-9_-]{12,}|\bsk-[A-Za-z0-9_-]{12,}|(?:验证码|邀请码|password|cookie|authorization|api[ _-]?key)\s*[:：=]\s*\S{4,}|\bBearer\s+[A-Za-z0-9._-]{8,}|\b[A-Za-z0-9_-]{40,}\b|(?<![0-9])[0-9]{6}(?![0-9])/i.test(value)
}
export function feedbackDraftError(draft: FeedbackDraft): string | null {
  const length = Array.from(draft.message.trim()).length
  if (length < 10 || length > 3000) return '请用 10–3000 个字描述问题或建议。'
  if (Array.from(draft.device.trim()).length > 120) return '设备与浏览器说明请控制在 120 个字以内。'
  if (containsFeedbackSecret(`${draft.message}\n${draft.device}`)) return '内容可能包含验证码、邀请码或密钥。请去掉这些信息，再提交。'
  if (!draft.consent) return '请先确认内容及提交范围。'
  return null
}
/** Explain readiness locally; never silently disable an editable draft. */
export function feedbackDraftHint(draft: FeedbackDraft): string {
  const length = Array.from(draft.message.trim()).length
  if (length < 10) return `还差 ${10 - length} 个字。请至少填写 10 个字，例如在哪个页面、点了什么、发生了什么。`
  if (length > 3000) return `内容超出 ${length - 3000} 个字，请精简到 3000 个字以内。`
  if (Array.from(draft.device.trim()).length > 120) return '设备与浏览器说明最多 120 个字，也可以留空。'
  if (containsFeedbackSecret(`${draft.message}\n${draft.device}`)) return '内容可能含验证码、邀请码或密钥，请移除后再提交。'
  if (!draft.consent) return '内容已达到长度要求。请勾选上方确认项，再提交。'
  return '可以提交了。提交后会显示受理编号；请不要重复点击。'
}
export function validFeedbackReceipt(value: unknown): value is FeedbackReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as FeedbackReceipt
  return Object.keys(v).every(k => ['id', 'reference', 'kind', 'status', 'created_at'].includes(k))
    && validFeedbackId(v.id) && typeof v.reference === 'string' && /^WY-[A-Z0-9-]{6,40}$/.test(v.reference)
    && Object.hasOwn(feedbackKinds, v.kind) && Object.hasOwn(feedbackStatuses, v.status)
    && utcDate(v.created_at)
}
export function validFeedbackDetail(value: unknown): value is FeedbackDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as FeedbackDetail
  if (Object.keys(v).some(key => !['receipt', 'category', 'message', 'page', 'build_version', 'updated_at', 'replies'].includes(key))
    || !validFeedbackReceipt(v.receipt) || !['bug', 'suggestion', 'other'].includes(v.category)
    || !boundedText(v.message, 10, 3000) || typeof v.page !== 'string' || !detailPages.has(v.page)
    || typeof v.build_version !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(v.build_version) || !utcDate(v.updated_at)
    || !Array.isArray(v.replies) || v.replies.length > 20) return false
  return v.replies.every(reply => !!reply && typeof reply === 'object' && !Array.isArray(reply)
    && Object.keys(reply).every(key => ['id', 'message', 'created_at'].includes(key))
    && validFeedbackId(reply.id) && boundedText(reply.message, 10, 2000) && utcDate(reply.created_at))
    && new Set(v.replies.map(reply => reply.id)).size === v.replies.length
}

/** Cancellation plus generation protects against transports resolving after abort. */
export function createFeedbackReadGuard() {
  let generation = 0
  let active: AbortController | null = null
  return {
    begin() {
      active?.abort()
      const controller = new AbortController()
      active = controller
      const currentGeneration = ++generation
      return { signal: controller.signal, isCurrent: () => currentGeneration === generation && !controller.signal.aborted }
    },
    cancel() { generation += 1; active?.abort(); active = null },
  }
}
export function feedbackDate(value: string) { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) }
