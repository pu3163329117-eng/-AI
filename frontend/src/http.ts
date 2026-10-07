/** Shared transport: bounded requests, explicit cancellation, no silent retries. */
export class RequestError extends Error {
  constructor(code: string, public readonly status = 0) { super(code); this.name = 'RequestError' }
}

export function uncertainWrite(error: unknown) {
  return error instanceof RequestError && (error.status >= 500 || ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE'].includes(error.message))
}

const messages: Record<string, string> = {
  ANNOTATION_SOURCE_REQUIRED: '请先保存注释来源链接和实际核对的注释依据，再审核当前版本。',
  ANNOTATION_VERSION_CONFLICT: '注释版本已变化，本次未覆盖新版本。请保留自己的修改，再重新读取。',
  INVALID_REASONING_REASON: '推断理由须为 5–2000 个字，不能只填写空白。',
  REASONING_STAGE_VALIDATED: '这个阶段已完成核验，证据链已锁定；请继续迁移挑战或回看记录。',
  REASONING_RECORD_REQUIRED: '已经记录开放理由，请修改并保存证据链，不使用旧的预设证据快捷命令。',
  NETWORK_ERROR: '无法连接学习服务，请确认网络及本地后端是否运行。',
  REQUEST_TIMEOUT: '服务响应超时，请稍后重新读取。',
  INVALID_RESPONSE: '服务返回了无法读取的数据，请重新读取，记录未被清除。',
  REQUEST_FAILED: '请求未完成，请稍后重试。',
  SERVER_UNAVAILABLE: '学习服务暂时不可用，请稍后重试。',
}
export function errorMessage(error: unknown) {
  const code = error instanceof Error ? error.message : typeof error === 'string' ? error : 'REQUEST_FAILED'
  return messages[code] ?? code
}

export async function requestJson<T>(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
  const controller = new AbortController()
  const external = init.signal
  const abort = () => controller.abort(external?.reason)
  if (external?.aborted) abort()
  else external?.addEventListener('abort', abort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  try {
    if (external?.aborted) throw external.reason ?? new DOMException('Request cancelled', 'AbortError')
    const response = await fetch(url, { ...init, signal: controller.signal })
    const body = await response.json().catch(error => {
      if (controller.signal.aborted) throw error
      return null
    })
    if (!response.ok) throw new RequestError(body?.error?.code ?? (response.status >= 500 ? 'SERVER_UNAVAILABLE' : 'REQUEST_FAILED'), response.status)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('INVALID_RESPONSE', response.status)
    return body as T
  } catch (error) {
    if (external?.aborted) throw external.reason ?? new DOMException('Request cancelled', 'AbortError')
    if (timedOut) throw new RequestError('REQUEST_TIMEOUT')
    if (error instanceof RequestError) throw error
    throw new RequestError('NETWORK_ERROR')
  } finally { clearTimeout(timer); external?.removeEventListener('abort', abort) }
}
