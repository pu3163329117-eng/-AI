import { RequestError, requestJson } from './http'
import { validReviewDetail, validReviewQueue, validReviewReceipt, validReviewWrite, type ReviewWrite } from './aiReasonReview'
import { readReviewBundle } from './aiReasonReviewExport'

const root = import.meta.env.VITE_API_ROOT ?? ''
const path = '/api/v1/admin/ai-reason-review/cases'
export const aiReasonReviewApi = {
  async exportBundle(signal?: AbortSignal) {
    const controller = new AbortController(), external = signal
    const abort = () => controller.abort(external?.reason)
    let timedOut = false
    if (external?.aborted) abort(); else external?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 20_000)
    try {
      if (external?.aborted) throw external.reason ?? new DOMException('Request cancelled', 'AbortError')
      const response = await fetch(`${root}/api/v1/admin/ai-reason-review/export`, { signal: controller.signal })
      if (controller.signal.aborted) { await response.body?.cancel(); throw controller.signal.reason ?? new DOMException('Request cancelled', 'AbortError') }
      if (!response.ok) { await response.body?.cancel(); throw new RequestError(response.status === 413 ? 'AI_REVIEW_EXPORT_TOO_LARGE' : response.status === 403 ? 'AI_LOCAL_PREVIEW_ONLY' : response.status >= 500 ? 'SERVER_UNAVAILABLE' : 'REQUEST_FAILED', response.status) }
      const bundle = await readReviewBundle(response)
      if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException('Request cancelled', 'AbortError')
      return bundle
    } catch (reason) {
      if (external?.aborted) throw external.reason ?? new DOMException('Request cancelled', 'AbortError')
      if (timedOut) throw new RequestError('REQUEST_TIMEOUT')
      if (reason instanceof RequestError) throw reason
      if (reason instanceof Error && ['INVALID_RESPONSE', 'AI_REVIEW_EXPORT_TOO_LARGE'].includes(reason.message)) throw new RequestError(reason.message, 200)
      throw new RequestError('NETWORK_ERROR')
    } finally { clearTimeout(timer); external?.removeEventListener('abort', abort) }
  },
  async list(signal?: AbortSignal) {
    const data = await requestJson<unknown>(root + path, { signal })
    if (!validReviewQueue(data)) throw new RequestError('INVALID_RESPONSE', 200)
    return data
  },
  async get(id: string, signal?: AbortSignal) {
    const data = await requestJson<unknown>(`${root}${path}/${encodeURIComponent(id)}`, { signal })
    if (!validReviewDetail(data) || data.case_id !== id) throw new RequestError('INVALID_RESPONSE', 200)
    return data
  },
  async write(operation: ReviewWrite) {
    if (!validReviewWrite(operation)) throw new RequestError('AI_REVIEW_INVALID', 400)
    const data = await requestJson<unknown>(`${root}${path}/${encodeURIComponent(operation.case_id)}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operation.key }, body: JSON.stringify(operation.body) })
    if (!validReviewReceipt(data, operation)) throw new RequestError('INVALID_RESPONSE', 200)
    return data
  },
}
