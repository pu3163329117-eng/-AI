import { authResponseCheckpoint, RequestError } from './http'
import { EVIDENCE_MAX_BYTES, validEvidenceDocument, verifyKnowledgeEvidence } from './knowledgeEvidence'

async function boundedJson(response: Response, signal: AbortSignal, limit: number): Promise<unknown> {
  if (Number(response.headers.get('Content-Length')) > limit) {
    void response.body?.cancel().catch(() => {})
    throw new RequestError('EVIDENCE_TOO_LARGE', response.status)
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
      if (size > limit) { abort(); throw new RequestError('EVIDENCE_TOO_LARGE', response.status) }
      chunks.push(part.value)
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new RequestError('INVALID_RESPONSE', response.status) }
}

/** Explicit admin GET, bounded body/deadline; no writes or retries. */
export async function readKnowledgeEvidence(document: string | null, signal: AbortSignal) {
  if (document !== null && !validEvidenceDocument(document)) throw new RequestError('EVIDENCE_INVALID_REQUEST')
  const checkpoint = authResponseCheckpoint(), controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, 20_000)
  try {
    if (signal.aborted) throw signal.reason ?? new DOMException('Request cancelled', 'AbortError')
    const root = import.meta.env.VITE_API_ROOT ?? ''
    const query = document === null ? '' : `?document=${encodeURIComponent(document)}`
    const response = await fetch(`${root}/api/v1/admin/knowledge/evidence-candidates${query}`,
      { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
    if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw controller.signal.reason }
    try { checkpoint(response.status) } catch (error) { void response.body?.cancel().catch(() => {}); throw error }
    if (!response.ok) {
      const fallback = response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'ADMIN_REQUIRED'
        : response.status >= 500 ? 'SERVER_UNAVAILABLE' : 'REQUEST_FAILED'
      if ([401, 403].includes(response.status)) { void response.body?.cancel().catch(() => {}); throw new RequestError(fallback, response.status) }
      const body = await boundedJson(response, controller.signal, 8192).catch(() => null) as { detail?: { code?: unknown } } | null
      checkpoint()
      throw new RequestError(body?.detail?.code === 'EVIDENCE_CANDIDATES_INVALID_REQUEST' ? 'EVIDENCE_INVALID_REQUEST' : fallback, response.status)
    }
    const body = await boundedJson(response, controller.signal, EVIDENCE_MAX_BYTES)
    checkpoint()
    if (controller.signal.aborted) throw controller.signal.reason
    const verified = verifyKnowledgeEvidence(body, document)
    if (!verified) throw new RequestError('INVALID_RESPONSE', 200)
    return verified
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? new DOMException('Request cancelled', 'AbortError')
    if (timedOut) throw new RequestError('REQUEST_TIMEOUT')
    if (error instanceof RequestError) throw error
    throw new RequestError('NETWORK_ERROR')
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
}
