/** Shared transport: bounded requests, explicit cancellation, no silent retries. */
export class RequestError extends Error {
  constructor(code: string, public readonly status = 0) { super(code); this.name = 'RequestError' }
}

export function uncertainWrite(error: unknown) {
  return error instanceof RequestError && (error.status >= 500 || ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE'].includes(error.message))
}

// Session material never enters browser storage. A new identity invalidates old
// in-flight responses before they can repopulate the new learner's interface.
let csrfToken: string | null = null
let identityGeneration = 0
let privateWritesSuspended = false
let creationWritesBlocked = false
export function setCreationWritesBlocked(value: boolean) { creationWritesBlocked = value }
export function setPrivateWritesSuspended(value: boolean) { privateWritesSuspended = value }
export function privateWritesAreSuspended() { return privateWritesSuspended }
const expiredListeners = new Set<() => void>()
export function configureAuthTransport(token: string | null) { csrfToken = token; identityGeneration += 1 }
export function subscribeAuthExpiry(listener: () => void) { expiredListeners.add(listener); return () => { expiredListeners.delete(listener) } }
export function authResponseCheckpoint() {
  const generation = identityGeneration
  return (status?: number) => {
    if (generation !== identityGeneration) throw new RequestError('SESSION_CHANGED', 409)
    if (status === 401) for (const listener of expiredListeners) listener()
  }
}

const messages: Record<string, string> = {
  AUTH_REQUIRED: '登录已过期，请重新登录。已确认的学习记录仍保存在服务端。',
  SESSION_CHANGED: '登录身份已变化，请重新打开当前页面。',
  CREATION_OUTCOME_PENDING: '上一次创建结果尚未确认，请先完成核对。',
  AUTH_REVALIDATION_PENDING: '正在确认登录状态，请稍后再试；本次没有发送。',
  ADMIN_REQUIRED: '当前账号没有管理权限。',
  ADMIN_DISABLED: '此部署未开放管理后台。',
  CSRF_INVALID: '安全校验已失效，请刷新页面后重新登录；本次未自动重试。',
  AUTH_INVALID_INPUT: '请检查用户名、密码长度和邀请码格式。',
  ANNOTATION_SOURCE_REQUIRED: '请先保存注释来源链接和实际核对的注释依据，再审核当前版本。',
  ANNOTATION_VERSION_CONFLICT: '注释版本已变化，本次未覆盖新版本。请保留自己的修改，再重新读取。',
  INVALID_REASONING_REASON: '推断理由须为 5–2000 个字，不能只填写空白。',
  REASONING_STAGE_VALIDATED: '这个阶段已完成核验，证据链已锁定；请继续迁移挑战或回看记录。',
  REASONING_RECORD_REQUIRED: '已经记录开放理由，请修改并保存证据链，不使用旧的预设证据快捷命令。',
  NETWORK_ERROR: '无法连接学习服务，请检查网络后重试；仍有问题可通过反馈与帮助联系内测负责人。',
  REQUEST_TIMEOUT: '服务响应超时，请稍后重新读取。',
  INVALID_RESPONSE: '服务返回了无法读取的数据，请重新读取，记录未被清除。',
  REQUEST_FAILED: '请求未完成，请稍后重试。',
  SERVER_UNAVAILABLE: '学习服务暂时不可用，请稍后重试。',
  BETA_BUSY: '当前使用人数较多，请稍后再试。为避免重复提交，本次操作不会自动重试。',
}
export function errorMessage(error: unknown) {
  const code = error instanceof Error ? error.message : typeof error === 'string' ? error : 'REQUEST_FAILED'
  return messages[code] ?? code
}

export async function requestJson<T>(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
  const generation = identityGeneration
  const headers = new Headers(init.headers)
  const method = (init.method ?? 'GET').toUpperCase()
  const sameOrigin = typeof location === 'undefined' || new URL(url, location.href).origin === location.origin
  if (sameOrigin && csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('X-CSRF-Token', csrfToken)
  const contractPath = new URL(url, typeof location === 'undefined' ? 'http://localhost/' : location.href).pathname
  if (creationWritesBlocked && method === 'POST' && (/^\/api\/v1\/training\/sessions\/?$/.test(contractPath) || /^\/api\/v1\/profiles\/?$/.test(contractPath) || /^\/api\/v1\/profiles\/[^/]+\/recommendations\/[^/]+\/start\/?$/.test(contractPath))) {
    throw new RequestError('CREATION_OUTCOME_PENDING', 409)
  }
  // Do not start a new private mutation while the authenticated surface is sealed.
  // Session/login/logout requests remain available to reconcile identity.
  if (privateWritesSuspended && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !contractPath.startsWith('/api/v1/auth/')) {
    throw new RequestError('AUTH_REVALIDATION_PENDING', 409)
  }
  if (sameOrigin && (/^\/api\/v1\/training\/sessions(?:\/|$)/.test(contractPath) || /^\/api\/v1\/profiles\/[^/]+\/observations\/report$/.test(contractPath))) {
    headers.set('X-Wenyan-Training-Contract', 'guided-v1')
  }
  const controller = new AbortController()
  const external = init.signal
  const abort = () => controller.abort(external?.reason)
  if (external?.aborted) abort()
  else external?.addEventListener('abort', abort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  try {
    if (external?.aborted) throw external.reason ?? new DOMException('Request cancelled', 'AbortError')
    const response = await fetch(url, { ...init, headers, cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
    if (generation !== identityGeneration) throw new RequestError('SESSION_CHANGED', 409)
    // Hide the private surface immediately on 401, even if an error body stalls.
    if (response.status === 401 && !/\/auth\/(session|login|redeem|email\/(request|verify))(?:\?|$)/.test(url)) for (const listener of expiredListeners) listener()
    const body = await response.json().catch(error => {
      if (controller.signal.aborted) throw error
      return null
    })
    if (generation !== identityGeneration) throw new RequestError('SESSION_CHANGED', 409)
    if (!response.ok) {
      const detail = typeof body?.detail === 'string' && body.detail.length <= 300 ? body.detail : null
      throw new RequestError(body?.error?.code ?? detail ?? (response.status >= 500 ? 'SERVER_UNAVAILABLE' : 'REQUEST_FAILED'), response.status)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('INVALID_RESPONSE', response.status)
    return body as T
  } catch (error) {
    if (external?.aborted) throw external.reason ?? new DOMException('Request cancelled', 'AbortError')
    if (timedOut) throw new RequestError('REQUEST_TIMEOUT')
    if (error instanceof RequestError) throw error
    throw new RequestError('NETWORK_ERROR')
  } finally { clearTimeout(timer); external?.removeEventListener('abort', abort) }
}
