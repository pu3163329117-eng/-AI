import type { MouseEvent } from 'react'
import { pageLabels, routeHash, type Page } from '../navigation'

type GuardedNavigation = { onNavigate: (page: Page) => void }
const entries: Array<{ page: Page; label: string; path: string }> = [
  { page: 'home', label: '今日', path: 'M3 10 12 3l9 7v11h-6v-7H9v7H3Z' },
  { page: 'practice', label: '练习', path: 'M12 5C8 2 4 3 2 4v15c4-2 7-1 10 1 3-2 6-3 10-1V4c-3-2-7-2-10 1Zm0 0v15' },
  { page: 'review', label: '复习', path: 'M6 3h12v18H6ZM9 8h6M9 12h6M9 16h4' },
  { page: 'profile', label: '我的', path: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2' },
]

function follow(event: MouseEvent<HTMLAnchorElement>, page: Page, navigate: GuardedNavigation['onNavigate'], disabled = false) {
  if (disabled) { event.preventDefault(); return }
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  navigate(page) // Always retain the existing dirty / uncertain-write route guard.
}

export function WaterinkMobileNavigation({ page, hasProfile, onNavigate }: GuardedNavigation & { page: Page; hasProfile: boolean }) {
  const group = page === 'training' || page === 'onboarding' ? 'home' : ['home', 'practice', 'review'].includes(page) ? page : 'profile'
  return <nav className="waterink-mobile-nav" aria-label="手机主导航" data-focused={page === 'training' || page === 'assessment' ? 'true' : 'false'}>
    {entries.map(entry => {
      const disabled = !hasProfile && entry.page !== 'home'
      return <a key={entry.page} href={routeHash({ page: entry.page })} aria-current={group === entry.page ? 'location' : undefined}
        aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined}
        onClick={event => follow(event, entry.page, onNavigate, disabled)}>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={entry.path} /></svg><span>{entry.label}</span>
      </a>
    })}
  </nav>
}

export function WaterinkProfileLinks({ onNavigate, adminAllowed, adminLabel = '教研工作台' }: GuardedNavigation & { adminAllowed: boolean; adminLabel?: '教研工作台' | '用户反馈' }) {
  const pages: Page[] = ['skills', 'assessment', 'report', 'about', ...(adminAllowed ? ['admin' as Page] : [])]
  return <section className="waterink-profile-links" aria-label="我的学习与产品入口">
    <div><p className="eyebrow">我的书房</p><h2>把阅读，慢慢读深。</h2></div>
    <nav aria-label="档案与更多功能">{pages.map(page => <a key={page} href={routeHash({ page })} onClick={event => follow(event, page, onNavigate)}>
      <span>{page === 'admin' ? adminLabel : pageLabels[page]}</span><span aria-hidden="true">↗</span>
    </a>)}</nav>
  </section>
}
