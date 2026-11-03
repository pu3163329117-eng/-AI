import { requestJson, RequestError } from './http'
import { validAnnotationQuality } from './annotationQuality'

/** Existing same-origin transport, one cancellable GET, no retries or writes. */
export async function readAnnotationQuality(signal: AbortSignal) {
  const root = import.meta.env.VITE_API_ROOT ?? ''
  const result = await requestJson<unknown>(`${root}/api/v1/admin/knowledge/quality`, { signal })
  if (!validAnnotationQuality(result)) throw new RequestError('INVALID_RESPONSE', 200)
  return result
}
