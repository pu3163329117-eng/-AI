import { authResponseCheckpoint, RequestError } from './http'
import { ANNOTATION_PACKET_MAX_BYTES, validPacketDocumentId, verifyAnnotationPacket } from './annotationPacket'

/** Count the actual UTF8 stream, not an optional/untrusted Content-Length. */
async function boundedJson(response: Response, signal: AbortSignal, limit: number): Promise<unknown> {
  if (Number(response.headers.get('Content-Length')) > limit) {
    void response.body?.cancel().catch(() => {})
    throw new RequestError('ANNOTATION_PACKET_TOO_LARGE', response.status)
  }
  if (!response.body) throw new RequestError('INVALID_RESPONSE', response.status)
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      if (signal.aborted) throw signal.reason
      const part = await reader.read()
      if (signal.aborted) throw signal.reason
      if (part.done) break
      size += part.value.byteLength
      if (size > limit) { abort(); throw new RequestError('ANNOTATION_PACKET_TOO_LARGE', response.status) }
      chunks.push(part.value)
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new RequestError('INVALID_RESPONSE', response.status) }
}

/** One explicit same-origin admin GET; no retries, writes or query text. */
export async function readAnnotationPacket(documentId: string, signal: AbortSignal) {
  if (!validPacketDocumentId(documentId)) throw new RequestError('ANNOTATION_PACKET_INVALID_REQUEST')
  const checkpoint = authResponseCheckpoint(), controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, 20_000)
  try {
    if (signal.aborted) throw signal.reason ?? new DOMException('Request cancelled', 'AbortError')
    const root = import.meta.env.VITE_API_ROOT ?? ''
    const response = await fetch(`${root}/api/v1/admin/knowledge/documents/${encodeURIComponent(documentId)}/review-packet`,
      { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
    if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw controller.signal.reason }
    try { checkpoint(response.status) } catch (error) { void response.body?.cancel().catch(() => {}); throw error }
    if (!response.ok) {
      const fallback = response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'ADMIN_REQUIRED'
        : response.status === 413 ? 'ANNOTATION_PACKET_TOO_LARGE' : response.status >= 500 ? 'SERVER_UNAVAILABLE' : 'REQUEST_FAILED'
      if ([401, 403, 413].includes(response.status)) { void response.body?.cancel().catch(() => {}); throw new RequestError(fallback, response.status) }
      const body = await boundedJson(response, controller.signal, 8192).catch(() => null) as { error?: { code?: string }; detail?: { code?: string } } | null
      checkpoint()
      const code = body?.error?.code ?? body?.detail?.code
      const allowed = ['ANNOTATION_PACKET_UNAVAILABLE', 'ANNOTATION_PACKET_INVALID_REQUEST', 'ANNOTATION_PACKET_INVALID_DATA', 'BETA_BUSY']
      throw new RequestError(typeof code === 'string' && allowed.includes(code) ? code : fallback, response.status)
    }
    const body = await boundedJson(response, controller.signal, ANNOTATION_PACKET_MAX_BYTES)
    const packet = await verifyAnnotationPacket(body)
    checkpoint()
    if (controller.signal.aborted) throw controller.signal.reason
    if (!packet || packet.document.id !== documentId) throw new RequestError('INVALID_RESPONSE', 200)
    return packet
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? new DOMException('Request cancelled', 'AbortError')
    if (timedOut) throw new RequestError('REQUEST_TIMEOUT')
    if (error instanceof RequestError) throw error
    throw new RequestError('NETWORK_ERROR')
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
}
