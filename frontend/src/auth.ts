export type AuthSession = {
  mode: 'local' | 'invite'
  authenticated: boolean
  login_method?: 'password' | 'email_code'
  user: { id: string; username: string; email?: string | null; role: 'learner' | 'admin' } | null
  profile_id: string | null
  csrf_token: string | null
  admin_enabled: boolean
  support_admin_enabled?: boolean
}

export function validAuthSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== 'object') return false
  const s = value as AuthSession
  if (!['local', 'invite'].includes(s.mode) || typeof s.authenticated !== 'boolean' || typeof s.admin_enabled !== 'boolean') return false
  if (s.support_admin_enabled !== undefined && typeof s.support_admin_enabled !== 'boolean') return false
  if (s.login_method !== undefined && !['password', 'email_code'].includes(s.login_method)) return false
  if (s.profile_id !== null && (typeof s.profile_id !== 'string' || !s.profile_id)) return false
  if (s.csrf_token !== null && (typeof s.csrf_token !== 'string' || !s.csrf_token)) return false
  if (s.user !== null && (!s.user || typeof s.user.id !== 'string' || !s.user.id || typeof s.user.username !== 'string' || !s.user.username || !['learner', 'admin'].includes(s.user.role))) return false
  if (s.user?.email !== undefined && s.user.email !== null && typeof s.user.email !== 'string') return false
  return s.mode === 'local' || (s.authenticated ? !!s.user && !!s.csrf_token : s.user === null && s.profile_id === null && s.csrf_token === null)
}

export function canManageSupport(session: AuthSession) { return session.mode === 'invite' && session.authenticated && session.user?.role === 'admin' && session.support_admin_enabled === true }
export function canManage(session: AuthSession) { return session.admin_enabled && (session.mode === 'local' || session.user?.role === 'admin') }
export function validUsername(value: string) { return /^[A-Za-z0-9][A-Za-z0-9_.-]{2,39}$/.test(value) }
export function validEmail(value: string) {
  if (value.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value)) return false
  const [local, domain] = value.split('@')
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') && domain.split('.').every(label => label.length <= 63)
}
export type EmailChallenge = { ok: true; challenge_id: string; expires_in_seconds: number; resend_after_seconds: number }
export function validEmailChallenge(value: unknown): value is EmailChallenge {
  if (!value || typeof value !== 'object') return false
  const c = value as EmailChallenge
  return c.ok === true && typeof c.challenge_id === 'string' && c.challenge_id.length > 0 && c.challenge_id.length <= 512 && Number.isInteger(c.expires_in_seconds) && c.expires_in_seconds > 0 && c.expires_in_seconds <= 3600 && Number.isInteger(c.resend_after_seconds) && c.resend_after_seconds >= 0 && c.resend_after_seconds <= 3600
}
export function secondsUntil(deadline: number, now = Date.now()) { return Math.max(0, Math.ceil((deadline - now) / 1000)) }

// Remove only this product's private browser entries, never unrelated app data.
export function clearPrivateBrowserState(local: Storage, session: Storage) {
  for (let i = local.length - 1; i >= 0; i -= 1) {
    const key = local.key(i)
    if (key && (['wenyan.profile-id', 'wenyan.active-session'].includes(key) || key.startsWith('wenyan-assessment:') || key.startsWith('wenyan-assessment-survey:'))) local.removeItem(key)
  }
  session.removeItem('wenyan-ai-review-pending-v1')
  session.removeItem('wenyan-assessment-editorial-pending-v1')
}
