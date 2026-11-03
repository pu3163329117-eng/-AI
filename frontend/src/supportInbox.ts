import { RequestError, errorMessage } from './http'

export type InboxStatus = 'received' | 'in_progress' | 'resolved' | 'withdrawn'
export type InboxKind = 'feedback' | 'privacy' | 'deletion'
export type InboxMeta = { id: string; reference: string; kind: InboxKind; category: 'bug' | 'suggestion' | 'other'; page: string; build_version: string; status: InboxStatus; created_at: string; updated_at: string }
export type InboxReply = { id: string; message: string; created_at: string }
export type InboxDetail = { item: InboxMeta; message: string; device: string; replies: InboxReply[] }
export type InboxQuery = { reference: string; status: InboxStatus | ''; kind: InboxKind | ''; offset: number }
export type InboxPage = { items: InboxMeta[]; total: number; offset: number; limit: number }
export type InboxStatusPayload = { status: InboxStatus; expected_updated_at: string }
export type InboxReplyPayload = { request_id: string; message: string; expected_updated_at: string; status?: InboxStatus }
export const inboxStatuses: Record<InboxStatus, string> = { received: '已收到', in_progress: '处理中', resolved: '已处理', withdrawn: '已撤回' }
export const inboxKinds: Record<InboxKind, string> = { feedback: '使用反馈', privacy: '隐私与数据', deletion: '申请删除数据' }
export const inboxLimit = 20
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const reference = /^WY-[0-9A-F]{16}$/
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key))
const text = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && Array.from(trimInboxText(v)).length >= min && Array.from(v).length <= max
export const validInboxDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19)
export const inboxTimeKey = (value: string) => `${value.slice(0, 19)}.${(value.match(/\.(\d+)Z$/)?.[1] ?? '').padEnd(6, '0')}Z`
// Match Python's strip(), including NEL/information separators, not JS trim().
export const trimInboxText = (value: string) => value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, '')
export const validInboxId = (v: unknown): v is string => typeof v === 'string' && uuid.test(v)
export const validInboxReference = (v: string) => v === '' || (typeof v === 'string' && reference.test(v))
export const validInboxStatus = (v: unknown): v is InboxStatus => typeof v === 'string' && Object.hasOwn(inboxStatuses, v)
export const validInboxKind = (v: unknown): v is InboxKind => typeof v === 'string' && Object.hasOwn(inboxKinds, v)
export function validInboxQuery(q: InboxQuery) {
  return object(q) && exact(q, ['reference','status','kind','offset']) && validInboxReference(q.reference) && (q.status === '' || validInboxStatus(q.status)) && (q.kind === '' || validInboxKind(q.kind)) && Number.isInteger(q.offset) && q.offset >= 0 && q.offset <= 10000
}
export function validInboxMeta(v: unknown): v is InboxMeta {
  return object(v) && exact(v, ['id','reference','kind','category','page','build_version','status','created_at','updated_at'])
    && validInboxId(v.id) && typeof v.reference === 'string' && reference.test(v.reference)
    && validInboxKind(v.kind) && validInboxStatus(v.status) && ['bug','suggestion','other'].includes(v.category as string)
    && typeof v.page === 'string' && /^#\/(?:home|onboarding|tour|training|assessment|practice|review|profile|report|ability|skills|admin|login|other|about)$/.test(v.page)
    && typeof v.build_version === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(v.build_version)
    && validInboxDate(v.created_at) && validInboxDate(v.updated_at) && inboxTimeKey(v.updated_at) >= inboxTimeKey(v.created_at)
}
export function validInboxDetail(v: unknown): v is InboxDetail {
  if (!object(v) || !exact(v, ['item','message','device','replies']) || !validInboxMeta(v.item)) return false
  const item = v.item
  return text(v.message, 10, 3000)
    && text(v.device, 0, 120) && Array.isArray(v.replies) && v.replies.length <= 20
    && v.replies.every(r => object(r) && exact(r, ['id','message','created_at']) && validInboxId(r.id) && text(r.message, 10, 2000) && validInboxDate(r.created_at) && inboxTimeKey(r.created_at) >= inboxTimeKey(item.created_at) && inboxTimeKey(r.created_at) <= inboxTimeKey(item.updated_at))
    && new Set(v.replies.map(r => r.id)).size === v.replies.length
}
export function validInboxPage(v: unknown, q: InboxQuery): v is InboxPage {
  return object(v) && exact(v, ['items','total','offset','limit']) && Array.isArray(v.items) && v.items.length <= inboxLimit
    && Number.isSafeInteger(v.total) && (v.total as number) >= 0 && v.offset === q.offset && v.limit === inboxLimit
    && v.items.length <= Math.max(0, (v.total as number) - q.offset)
    && v.items.every(row => validInboxMeta(row) && (!q.reference || row.reference === q.reference) && (!q.status || row.status === q.status) && (!q.kind || row.kind === q.kind))
    && new Set(v.items.map(row => row.id)).size === v.items.length
}
export function replyProblem(message: string) {
  const length = Array.from(trimInboxText(message)).length
  return length < 10 || length > 2000 ? '站内公开回复须为 10–2000 个字，不能只填空白。' : ''
}
export function inboxError(reason: unknown) {
  const code = reason instanceof Error ? reason.message : ''
  return ({ SUPPORT_ADMIN_INVALID_INPUT: '请检查编号、筛选项和回复内容的格式。', SUPPORT_NOT_FOUND: '此反馈不存在或当前不可访问，请重新读取列表。', SUPPORT_CASE_CHANGED_REFRESH_REQUIRED: '记录已被更新。本次未覆盖，请保留或复制草稿，再明确重新读取。', SUPPORT_REPLY_IDEMPOTENCY_CONFLICT: '原提交编号对应的内容不一致，不能换内容重试。请保留草稿并人工核对。', SUPPORT_REPLY_CASE_LIMIT: '这份反馈已达 20 条回复上限；没有自动发送本次回复。', SUPPORT_REPLY_SENSITIVE_CONTENT: '回复可能包含密钥、验证码或邀请码，请移除敏感内容再提交。', BETA_BUSY: '服务繁忙，本次结果可能尚未确认；不会自动重试。' } as Record<string,string>)[code] ?? errorMessage(reason)
}
export function requireInbox(value: boolean): asserts value { if (!value) throw new RequestError('INVALID_RESPONSE') }
