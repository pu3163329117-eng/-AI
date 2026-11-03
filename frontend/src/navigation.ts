export type Page = 'home' | 'training' | 'skills' | 'assessment' | 'practice' | 'review' | 'profile' | 'report' | 'admin' | 'onboarding' | 'about'
export type PageRoute = { page: Page; sessionId?: string }
export const pageLabels: Record<Page, string> = { home: '今日训练', training: '原文训练', skills: '能力地图', assessment: '能力试测', practice: '专项练习', review: '复习', profile: '学习档案', report: '学习报告', admin: '教研工作台', onboarding: '建立档案', about: '关于我们' }
const pages = new Set(Object.keys(pageLabels))
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Hash routes work with the existing static host and LAN preview. */
export function readRoute(hash: string): PageRoute {
  const match = /^#\/([a-z]+)(?:\/([^/]+))?$/.exec(hash)
  if (!match || !pages.has(match[1])) return { page: 'home' }
  const page = match[1] as Page
  if (page === 'training') return match[2] && uuid.test(match[2]) ? { page, sessionId: match[2] } : { page: 'review' }
  return match[2] ? { page: 'home' } : { page }
}

export function routeHash(route: PageRoute): string {
  return route.page === 'training' && route.sessionId && uuid.test(route.sessionId)
    ? `#/training/${route.sessionId}` : `#/${route.page === 'training' ? 'review' : route.page}`
}

export function optionIndex(key: string, current: number, count: number): number | null {
  if (count < 1) return null
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowRight' || key === 'ArrowDown') return (current + 1) % count
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (current + count - 1) % count
  return null
}

export function jumpTo(id: string) {
  const target = document.getElementById(id)
  if (!target) return
  target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
  target.focus({ preventScroll: true })
}

/** Reveal the current route inside the horizontal navigation, not the page. */
export function revealCurrentNavigation(nav: HTMLElement | null) {
  const active = nav?.querySelector<HTMLElement>('[aria-current="page"]')
  if (!nav || !active || !nav.clientWidth) return
  const container = nav.getBoundingClientRect()
  const item = active.getBoundingClientRect()
  const delta = item.left < container.left ? item.left - container.left
    : item.right > container.right ? item.right - container.right : 0
  if (!delta) return
  nav.scrollTo({ left: Math.max(0, Math.min(nav.scrollWidth - nav.clientWidth, nav.scrollLeft + delta)), behavior: 'auto' })
}
