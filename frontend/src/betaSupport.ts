export type SupportKind = 'feedback' | 'privacy' | 'deletion'
export type SupportChannel = { email: string | null; feedbackUrl: string | null }

function placeholderHost(host: string) { return /(^|\.)(localhost|invalid|test|example)$|(^|\.)example\.(com|net|org)$/i.test(host) }

/** Deployment-owned destinations only; no query strings, credentials or guessed addresses. */
export function supportChannel(emailValue = '', urlValue = '', originValue = ''): SupportChannel {
  const email = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(emailValue)
    && emailValue.length <= 254 && !emailValue.includes('..') && !placeholderHost(emailValue.split('@')[1]) ? emailValue : null
  let feedbackUrl: string | null = null
  try {
    const url = new URL(urlValue)
    const allowed = new URL(originValue)
    if (url.protocol === 'https:' && allowed.protocol === 'https:' && url.origin === allowed.origin
      && allowed.href === `${allowed.origin}/` && !url.username && !url.password && !url.search && !url.hash
      && !allowed.username && !allowed.password && !allowed.search && !allowed.hash
      && url.href.length <= 512 && !placeholderHost(url.hostname) && !/^(localhost|127\.|\[|0\.)/i.test(url.hostname)) feedbackUrl = url.href
  } catch { /* An absent or invalid destination stays unconfigured. */ }
  return { email, feedbackUrl }
}

const supportPages = new Set(['home', 'training', 'skills', 'assessment', 'practice', 'review', 'profile', 'report', 'admin', 'onboarding', 'about'])
export function supportRoute(hash: string) {
  const page = /^#\/([a-z]+)(?:\/[^/?#]+)?(?:[?#].*)?$/.exec(hash)?.[1]
  return page && supportPages.has(page) ? `#/${page}` : '#/home'
}
export function supportVersion(value: string) { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) ? value : '开发预览' }

export function supportTemplate(hash: string, version: string, kind: SupportKind = 'feedback') {
  const heading = kind === 'deletion' ? '文言·推理：数据删除申请' : kind === 'privacy' ? '文言·推理：隐私与数据咨询' : '文言·推理：内测反馈'
  return `${heading}\n页面：${supportRoute(hash)}\n版本：${supportVersion(version)}\n设备与浏览器（选填，请自行填写）：\n${kind === 'feedback' ? '现象与复现步骤（请自行填写）：\n预期表现（选填）：' : '希望了解或处理的事项（请自行填写）：'}\n截图：自行决定是否附上；请先遮盖个人信息。\n\n请勿发送 API Key、验证码、邀请码、Cookie、学习原文或其他人的记录。`
}

export function supportMailto(email: string | null, template: string) {
  if (!email || supportChannel(email).email !== email) return null
  return `mailto:${email}?subject=${encodeURIComponent(template.split('\n')[0])}&body=${encodeURIComponent(template)}`
}

/** An existing profile must not be offered a second onboarding form. */
export function shouldLeaveOnboarding(page: string, hasProfile: boolean) { return page === 'onboarding' && hasProfile }
