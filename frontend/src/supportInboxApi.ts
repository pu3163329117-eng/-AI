import { requestJson, RequestError } from './http'
import { inboxLimit, requireInbox, validInboxDate, validInboxDetail, validInboxId, validInboxPage, validInboxQuery, validInboxStatus, replyProblem, type InboxDetail, type InboxPage, type InboxQuery, type InboxReplyPayload, type InboxStatusPayload } from './supportInbox'

const root = '/api/v1/admin/support/feedback'
const invalid = () => { throw new RequestError('SUPPORT_ADMIN_INVALID_INPUT', 422) }
const checkedId = (id: string) => { if (!validInboxId(id)) invalid(); return id }
async function detail(url: string, id: string, init: RequestInit): Promise<InboxDetail> {
  const result = await requestJson<unknown>(url, init)
  requireInbox(validInboxDetail(result) && result.item.id === id)
  return result
}
export const supportInboxApi = {
  async list(query: InboxQuery, signal: AbortSignal): Promise<InboxPage> {
    if (!validInboxQuery(query)) invalid()
    const expected = { ...query }
    const params = new URLSearchParams({ ...expected, offset: String(expected.offset), limit: String(inboxLimit) })
    const result = await requestJson<unknown>(`${root}?${params}`, { signal, cache: 'no-store' })
    requireInbox(validInboxPage(result, expected)); return result
  },
  async detail(id: string, signal: AbortSignal) { return detail(`${root}/${checkedId(id)}`, id, { signal, cache: 'no-store' }) },
  async status(id: string, payload: InboxStatusPayload, signal: AbortSignal) {
    if (Object.keys(payload).some(k => !['status','expected_updated_at'].includes(k)) || !validInboxStatus(payload.status) || !validInboxDate(payload.expected_updated_at)) invalid()
    return detail(`${root}/${checkedId(id)}/status`, id, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  },
  async reply(id: string, payload: InboxReplyPayload, signal: AbortSignal) {
    if (Object.keys(payload).some(k => !['request_id','message','expected_updated_at','status'].includes(k)) || !validInboxId(payload.request_id) || typeof payload.message !== 'string' || replyProblem(payload.message) || !validInboxDate(payload.expected_updated_at) || (payload.status !== undefined && !validInboxStatus(payload.status))) invalid()
    return detail(`${root}/${checkedId(id)}/reply`, id, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  },
}
