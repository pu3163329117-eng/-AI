import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { configureAuthTransport, errorMessage, requestJson, RequestError, setPrivateWritesSuspended, subscribeAuthExpiry } from './http'
import { clearPrivateBrowserState, secondsUntil, validAuthSession, validEmail, validEmailChallenge, validUsername, type AuthSession } from './auth'
import './auth.css'

const root = import.meta.env.VITE_API_ROOT ?? ''
async function sessionRequest(path = '/session', payload?: object, signal?: AbortSignal) {
  const value = await requestJson<unknown>(`${root}/api/v1/auth${path}`, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal } : { signal })
  if (!validAuthSession(value)) throw new RequestError('INVALID_RESPONSE')
  return value
}
function clearBrowserState() { try { clearPrivateBrowserState(localStorage, sessionStorage) } catch { /* Server identity, not storage, controls access. */ } }
function uncertainAuthResult(error: unknown) {
  return error instanceof RequestError && (error.status >= 500 || ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE'].includes(error.message))
}
function authError(error: unknown) {
  const code = error instanceof Error ? error.message : ''
  const messages: Record<string, string> = {
    AUTH_INVALID_CREDENTIALS: '用户名或密码不正确，请检查后重试。',
    INVALID_CREDENTIALS: '用户名或密码不正确，请检查后重试。',
    INVITE_INVALID: '邀请码无效、已使用或已过期，请向内测负责人申请新的邀请码。',
    AUTH_INVITE_INVALID: '邀请码无效、已使用或已过期，请向内测负责人申请新的邀请码。',
    USERNAME_TAKEN: '这个用户名已被使用，请换一个。',
    AUTH_USERNAME_TAKEN: '这个用户名已被使用，请换一个。',
    AUTH_RATE_LIMITED: '尝试次数较多，请稍后再试。',
    RATE_LIMITED: '尝试次数较多，请稍后再试。',
    AUTH_EMAIL_CODE_INVALID: '验证码不正确或已失效，请检查最新一封邮件；仍无法登录时请重新获取。',
    AUTH_EMAIL_CODE_EXPIRED: '验证码已过期，请重新获取。',
    AUTH_EMAIL_RATE_LIMITED: '发送或验证次数较多，请稍后再试。',
    AUTH_EMAIL_UNAVAILABLE: '邮件服务暂时不可用，请稍后再试或联系内测负责人。',
    AUTH_EMAIL_DELIVERY_FAILED: '邮件服务暂时不可用，请稍后再试或联系内测负责人。',
    AUTH_EMAIL_INVALID_INPUT: '请检查邮箱、6 位验证码和邀请码格式。',
    AUTH_INVALID_INPUT: '请检查输入格式和长度，再重新提交。',
  }
  return messages[code] ?? errorMessage(error)
}

export function AuthBoundary({ children, fallbackFooter }: { children: (session: AuthSession, onLogout: () => Promise<void>) => ReactNode; fallbackFooter?: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null)
  const current = useRef<AuthSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [suspended, setSuspended] = useState(false)
  const [identityEpoch, setIdentityEpoch] = useState(0)
  const privateSurface = useRef<HTMLDivElement | null>(null)
  const seal = useCallback(() => {
    setPrivateWritesSuspended(true)
    if (privateSurface.current) {
      privateSurface.current.hidden = true
      privateSurface.current.inert = true
      privateSurface.current.setAttribute('aria-hidden', 'true')
    }
    setSuspended(true)
  }, [])
  const sequence = useRef(0)
  const authentication = useRef<number | null>(null)
  const channel = useRef<BroadcastChannel | null>(null)
  useEffect(() => { if (!session || (session.mode === 'invite' && !session.authenticated)) document.title = '内测登录 · 文言·推理' }, [session])
  const apply = useCallback((next: AuthSession) => {
    const old = current.current
    const changed = !old || old.mode !== next.mode || old.authenticated !== next.authenticated || old.user?.id !== next.user?.id || old.csrf_token !== next.csrf_token
    if (changed) {
      configureAuthTransport(next.csrf_token)
      if (next.mode === 'invite') clearBrowserState()
      if (old) setIdentityEpoch(value => value + 1)
    }
    current.current = next; setSession(next); setError(null); setLoading(false)
    setPrivateWritesSuspended(false); setSuspended(false)
  }, [])
  const load = useCallback(async () => {
    const request = ++sequence.current
    const hadPrivateSession = current.current?.mode === 'invite' && current.current.authenticated
    if (hadPrivateSession) { seal(); setLoading(true) }
    try { const next = await sessionRequest(); if (sequence.current === request) apply(next) }
    catch (reason) {
      if (sequence.current !== request) return
      if (hadPrivateSession && uncertainAuthResult(reason)) {
        // The private tree remains mounted and sealed until the same session is verified.
        setError(authError(reason)); setLoading(false); return
      }
      // A confirmed rejection or invalid identity must destroy the old private tree.
      setPrivateWritesSuspended(true); clearBrowserState(); current.current = null
      configureAuthTransport(null); setIdentityEpoch(value => value + 1); setSession(null); setError(authError(reason)); setLoading(false); setSuspended(false)
    }
  }, [apply, seal])
  useEffect(() => {
    void load()
    const expire = () => {
      sequence.current += 1; seal(); configureAuthTransport(null); clearBrowserState(); current.current = null; setIdentityEpoch(value => value + 1); setSession(null); setLoading(true)
      setNotice('登录已失效，请重新登录。已确认的记录仍保存在服务端；未保存的输入不会自动提交。')
      void load()
    }
    const unsubscribe = subscribeAuthExpiry(expire)
    // Returning from the mail app must not let a session read supersede the
    // explicit verification already in flight. Expiry and cross-tab sign-out
    // still invalidate it through the independent sequence/transport guards.
    // An explicitly signed-out form has no private surface to revalidate. A
    // failed background read must not unmount its mailbox/code draft.
    const focus = () => { if (current.current?.mode === 'invite' && current.current.authenticated && authentication.current === null) void load() }
    window.addEventListener('focus', focus)
    if (typeof BroadcastChannel !== 'undefined') { channel.current = new BroadcastChannel('wenyan-auth'); channel.current.onmessage = expire }
    return () => { sequence.current += 1; unsubscribe(); window.removeEventListener('focus', focus); channel.current?.close() }
  }, [load])
  const authenticate = async (path: string, payload: object, signal?: AbortSignal) => {
    const request = ++sequence.current
    const address = (payload as { email?: unknown }).email
    const attemptedEmail = typeof address === 'string' ? address.trim().toLowerCase() : null
    authentication.current = request
    try {
      let next: AuthSession
      try { next = await sessionRequest(path, payload, signal) }
      catch (reason) {
        // A one-use code may already have established the cookie before its
        // response was lost. Reconcile once with a read, never replay the write.
        if (path !== '/email/verify' || !uncertainAuthResult(reason) || signal?.aborted || sequence.current !== request) throw reason
        try { next = await sessionRequest('/session', undefined, signal) }
        catch { throw reason }
        if (signal?.aborted) throw reason
        if (sequence.current !== request) throw new RequestError('SESSION_CHANGED', 409)
        // Only the same attempt's email may recover this ambiguous result.
        if (!next.authenticated || !next.user || !attemptedEmail || next.user.email?.toLowerCase() !== attemptedEmail) throw reason
      }
      if (sequence.current !== request) throw new RequestError('SESSION_CHANGED', 409)
      if (!next.authenticated || !next.user) throw new RequestError('INVALID_RESPONSE')
      apply(next); setNotice(''); channel.current?.postMessage('identity-changed')
    } finally { if (authentication.current === request) authentication.current = null }
  }
  const logout = async () => {
    const response = await requestJson<{ ok: boolean }>(`${root}/api/v1/auth/logout`, { method: 'POST' })
    if (response.ok !== true) throw new RequestError('INVALID_RESPONSE')
    sequence.current += 1; seal(); configureAuthTransport(null); clearBrowserState(); setIdentityEpoch(value => value + 1)
    const next: AuthSession = { mode: 'invite', authenticated: false, user: null, profile_id: null, csrf_token: null, admin_enabled: false, login_method: current.current?.login_method }
    current.current = next; setSession(next); setSuspended(false); channel.current?.postMessage('signed-out')
  }
  if (!session) return <><main className="auth-state" aria-busy={loading}><p className="eyebrow">文言 · 推理 / 内测</p><h1>{loading ? '正在确认登录状态…' : '暂时无法确认登录状态。'}</h1>{error && <p role="alert">{error}</p>}{notice && <p>{notice}</p>}{!loading && <button className="button button-primary" onClick={() => { setLoading(true); void load() }}>重新连接</button>}</main>{fallbackFooter}</>
  if (session.mode === 'invite' && !session.authenticated) return <>{session.login_method === 'email_code' ? <EmailLoginScreen key={`email:${notice}`} notice={notice} onAuthenticate={authenticate} /> : <LoginScreen key={notice} notice={notice} onAuthenticate={authenticate} />}{fallbackFooter}</>
  return <><div key={`${session.mode}:${session.user?.id ?? 'local'}:${identityEpoch}`} ref={node => { privateSurface.current = node; if (node) node.inert = suspended }} hidden={suspended} aria-hidden={suspended || undefined}>{children(session, logout)}</div>{suspended && <dialog className="auth-state auth-recovery-dialog" aria-busy={loading} aria-label="登录状态确认" tabIndex={-1} onCancel={event => event.preventDefault()} ref={node => { if (node && !node.open) { node.showModal(); node.focus() } }}><p className="eyebrow">文言 · 推理 / 内测</p><h1>{loading ? '正在确认登录状态…' : '暂时无法确认登录状态。'}</h1>{error && <p role="alert">{error}</p>}<p>当前页面已暂时锁定，未保存的输入仍保留在本页。</p>{!loading && <button className="button button-primary" onClick={() => { setLoading(true); void load() }}>重新连接</button>}</dialog>}</>
}

type Authenticate = (path: string, payload: object, signal?: AbortSignal) => Promise<void>

function EmailLoginScreen({ notice, onAuthenticate }: { notice: string; onAuthenticate: Authenticate }) {
  const [register, setRegister] = useState(false)
  const [email, setEmail] = useState('')
  const [invite, setInvite] = useState('')
  const [code, setCode] = useState('')
  const [challenge, setChallenge] = useState<{ id: string; expiresAt: number } | null>(null)
  const [resendAt, setResendAt] = useState(0)
  const [now, setNow] = useState(Date.now)
  const [busy, setBusy] = useState<'request' | 'verify' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const pending = useRef<AbortController | null>(null)
  const lock = useRef(false)
  const emailInput = useRef<HTMLInputElement>(null)
  const codeInput = useRef<HTMLInputElement>(null)
  const remaining = secondsUntil(resendAt, now)
  const expired = !!challenge && secondsUntil(challenge.expiresAt, now) === 0

  useEffect(() => {
    const tick = () => setNow(Date.now())
    const timer = window.setInterval(tick, 1000)
    window.addEventListener('focus', tick)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', tick); generation.current += 1; pending.current?.abort() }
  }, [])
  useEffect(() => { if (challenge) codeInput.current?.focus() }, [challenge])
  const discardChallenge = () => {
    generation.current += 1; pending.current?.abort(); pending.current = null
    lock.current = false; setBusy(null); setChallenge(null); setCode(''); setError(null)
    // A local edit must not bypass the resend cooldown for the last request.
  }
  const requestCode = async () => {
    if (lock.current || secondsUntil(resendAt) > 0) return
    const address = email.trim()
    if (!validEmail(address)) { setError('请输入完整有效的邮箱地址。'); return }
    if (register && (invite.trim().length < 16 || invite.trim().length > 256)) { setError('请填写内测负责人提供的完整邀请码（16–256 个字符）。'); return }
    const request = ++generation.current
    const controller = new AbortController(); pending.current = controller
    lock.current = true; setBusy('request'); setError(null); setCode('')
    try {
      const value = await requestJson<unknown>(`${root}/api/v1/auth/email/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ email: address, purpose: register ? 'register' : 'login', ...(register ? { invite_code: invite.trim() } : {}) }) })
      if (request !== generation.current) return
      if (!validEmailChallenge(value)) throw new RequestError('INVALID_RESPONSE')
      const receivedAt = Date.now()
      setNow(receivedAt); setResendAt(receivedAt + value.resend_after_seconds * 1000)
      setChallenge({ id: value.challenge_id, expiresAt: receivedAt + value.expires_in_seconds * 1000 })
    } catch (reason) {
      if (request === generation.current && !controller.signal.aborted) setError(uncertainAuthResult(reason)
        ? '暂时无法确认验证码是否已发送。本页不会自动重发；请稍后手动重新获取，并只使用最新一封邮件中的验证码。'
        : authError(reason))
    } finally {
      if (request === generation.current) { lock.current = false; setBusy(null); pending.current = null }
    }
  }
  const verifyCode = async () => {
    if (lock.current || !challenge) return
    if (secondsUntil(challenge.expiresAt) === 0) { setNow(Date.now()); setError('验证码已过期，请重新获取。'); return }
    if (!/^\d{6}$/.test(code)) { setError('请输入邮件中的 6 位数字验证码。'); return }
    const request = ++generation.current
    const controller = new AbortController(); pending.current = controller
    lock.current = true; setBusy('verify'); setError(null)
    try { await onAuthenticate('/email/verify', { email: email.trim(), challenge_id: challenge.id, code, ...(register ? { invite_code: invite.trim() } : {}) }, controller.signal) }
    catch (reason) { if (request === generation.current && !controller.signal.aborted) setError(uncertainAuthResult(reason)
      ? '暂时无法确认是否登录成功。本页没有重复验证或重发验证码；请网络恢复后刷新页面确认，仍未登录时再重新获取验证码。'
      : authError(reason)) }
    finally { if (request === generation.current) { lock.current = false; setBusy(null); pending.current = null } }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void (challenge ? verifyCode() : requestCode()) }
  return <main className="auth-page">
    <header className="auth-brand">文言 <span>·</span> 推理 <small>邀请制内测</small></header>
    <section className="auth-layout" aria-labelledby="auth-title">
      <div className="auth-intro"><p className="eyebrow">从原文出发，留下自己的推理。</p><h1 id="auth-title">{register ? '建立你的\n阅读起点。' : '回到你的\n阅读现场。'}</h1><p>每一次判断、证据和复习，都保存在你自己的账号下。</p><p className="auth-note">当前为内测版本，反馈仅供学习参考，不作为正式能力认证。首次加入需使用邀请码，之后用邮箱验证码登录，无需设置密码。</p></div>
      <form className="auth-form" onSubmit={submit} aria-busy={!!busy}>
        <h2>{register ? '邮箱验证 · 首次加入' : '邮箱验证码登录'}</h2>
        {notice && <p className="auth-notice" role="status">{notice}</p>}
        <label htmlFor="auth-email">邮箱<input ref={emailInput} id="auth-email" name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} required maxLength={254} value={email} readOnly={!!challenge} disabled={!!busy} onChange={event => { discardChallenge(); setEmail(event.target.value) }} /><small>请使用你能接收邮件的个人邮箱。</small></label>
        {register && <label htmlFor="auth-invite">邀请码<input id="auth-invite" name="invite_code" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={invite} required minLength={16} maxLength={256} readOnly={!!challenge} disabled={!!busy} onChange={event => { discardChallenge(); setInvite(event.target.value) }} /><small>仅首次加入需要。请勿公开或转发。</small></label>}
        {challenge && <>
          <p className="auth-notice" role="status">如果邮箱与邀请信息符合要求，你将收到验证码邮件。请同时检查垃圾邮件，只使用最新一封中的验证码。</p>
          <label htmlFor="auth-code">邮箱验证码<input ref={codeInput} id="auth-code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required maxLength={6} value={code} disabled={!!busy || expired} aria-describedby="auth-code-help" onChange={event => { setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6)); setError(null) }} /><small id="auth-code-help">{expired ? '本次验证码已过期，请手动重新获取。' : `6 位数字，${Math.ceil(secondsUntil(challenge.expiresAt, now) / 60)} 分钟内有效。验证码只可使用一次。`}</small></label>
        </>}
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="button button-primary" disabled={!!busy || (challenge ? expired : remaining > 0)}>{busy === 'request' ? '正在请求验证码…' : busy === 'verify' ? '正在验证…' : challenge ? register ? '验证并加入内测' : '验证并继续' : remaining > 0 ? `${remaining} 秒后可获取验证码` : '获取邮箱验证码'}</button>
        {challenge && <div className="auth-code-actions"><button className="auth-switch" type="button" disabled={!!busy || remaining > 0} onClick={() => void requestCode()}>{remaining > 0 ? `${remaining} 秒后可重新获取` : '重新获取验证码'}</button><button className="auth-switch" type="button" disabled={!!busy} onClick={() => { discardChallenge(); emailInput.current?.focus() }}>修改邮箱{register ? '或邀请码' : ''}</button></div>}
        <button type="button" className="auth-switch" disabled={!!busy} onClick={() => { discardChallenge(); setRegister(value => !value); setEmail(''); setInvite('') }}>{register ? '已有账号？返回登录' : '首次体验？使用邀请码加入'}</button>
        <p className="auth-help">邮箱和邀请码仅用于验证内测资格。未收到邮件可在冷却结束后重试；仍有问题请联系内测负责人。不要在反馈中发送验证码或邀请码。</p>
      </form>
    </section>
  </main>
}

function LoginScreen({ notice, onAuthenticate }: { notice: string; onAuthenticate: Authenticate }) {
  const [redeem, setRedeem] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [invite, setInvite] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (lock.current) return
    if (!validUsername(username.trim())) { setError('用户名为 3–40 位英文字母、数字、点、下划线或短横线。'); return }
    if (redeem && (Array.from(password).length < 12 || Array.from(password).length > 128)) { setError('请使用 12–128 个字符的密码。'); return }
    lock.current = true; setBusy(true); setError(null)
    try { await onAuthenticate(redeem ? '/redeem' : '/login', { username: username.trim(), password, ...(redeem ? { invite_code: invite.trim() } : {}) }) }
    catch (reason) { setError(authError(reason)) }
    finally { lock.current = false; setBusy(false) }
  }
  return <main className="auth-page">
    <header className="auth-brand">文言 <span>·</span> 推理 <small>邀请制内测</small></header>
    <section className="auth-layout" aria-labelledby="auth-title">
      <div className="auth-intro"><p className="eyebrow">从原文出发，留下自己的推理。</p><h1 id="auth-title">{redeem ? '建立你的\n阅读起点。' : '回到你的\n阅读现场。'}</h1><p>每一次判断、证据和复习，都保存在你自己的账号下。</p><p className="auth-note">当前为内测版本，反馈仅供学习参考，不作为正式能力认证。请勿使用真实姓名作为用户名。</p></div>
      <form className="auth-form" onSubmit={event => void submit(event)}>
        <h2>{redeem ? '使用邀请加入' : '登录学习账号'}</h2>
        {notice && <p className="auth-notice" role="status">{notice}</p>}
        {redeem && <label htmlFor="auth-invite">邀请码<input id="auth-invite" name="invite_code" autoComplete="off" value={invite} required maxLength={256} disabled={busy} onChange={event => setInvite(event.target.value)} /><small>由内测负责人提供，不是你的登录密码。</small></label>}
        <label htmlFor="auth-username">用户名<input id="auth-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={40} value={username} disabled={busy} onChange={event => setUsername(event.target.value)} /><small>3–40 位字母、数字、点、下划线或短横线。</small></label>
        <label htmlFor="auth-password">密码<input id="auth-password" name="password" type="password" autoComplete={redeem ? 'new-password' : 'current-password'} required maxLength={128} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} />{redeem && <small>至少 12 个字符，可粘贴密码管理器生成的密码。</small>}</label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="button button-primary" disabled={busy}>{busy ? '正在确认…' : redeem ? '创建账号并进入' : '登录并继续'}</button>
        <button type="button" className="auth-switch" disabled={busy} onClick={() => { setRedeem(value => !value); setError(null); setPassword('') }}>{redeem ? '已有账号？返回登录' : '首次体验？使用邀请码加入'}</button>
        <p className="auth-help">忘记密码或邀请失效，请联系内测负责人。不要在反馈中发送密码或邀请码。</p>
      </form>
    </section>
  </main>
}
