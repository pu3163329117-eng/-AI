import { requestJson, RequestError } from './http'
import { validFeedbackDetail, validFeedbackId, validFeedbackReceipt, type FeedbackPayload, type FeedbackReceipt } from './feedback'
const root = import.meta.env.VITE_API_ROOT ?? ''
export const feedbackApi = {
  async detail(id: string, signal?: AbortSignal) {
    if (!validFeedbackId(id)) throw new RequestError('RESOURCE_NOT_FOUND', 404)
    const detail = await requestJson<unknown>(`${root}/api/v1/support/feedback/${encodeURIComponent(id)}`, { signal })
    if (!validFeedbackDetail(detail) || detail.receipt.id !== id) throw new RequestError('INVALID_RESPONSE', 200)
    return detail
  },
  async submit(payload: FeedbackPayload, signal?: AbortSignal) {
    const receipt = await requestJson<unknown>(`${root}/api/v1/support/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal })
    if (!validFeedbackReceipt(receipt) || receipt.kind !== payload.kind) throw new RequestError('INVALID_RESPONSE', 200)
    return receipt
  },
  async list(signal?: AbortSignal): Promise<FeedbackReceipt[]> {
    const data = await requestJson<{ items: unknown[] } | null>(`${root}/api/v1/support/feedback?limit=20`, { signal })
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => key !== 'items') || !Array.isArray(data.items) || data.items.length > 20 || !data.items.every(validFeedbackReceipt)
      || new Set(data.items.map(item => item.id)).size !== data.items.length) throw new RequestError('INVALID_RESPONSE', 200)
    return data.items
  },
}
