import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { pageLabels, routeHash, type Page } from '../navigation'
import type { LearnerProfile } from '../types'
import './appHeader.css'

type AppHeaderProps = {
  page: Page
  profile: LearnerProfile | null
  onNavigate: (page: Page) => void
  adminAllowed: boolean
  supportOnly?: boolean
}

const primaryPages: Page[] = ['home', 'practice', 'review']
const morePages: Page[] = ['skills', 'assessment', 'report', 'profile', 'about', 'admin']
const labelFor = (page: Page) => page === 'profile' ? '我的' : page === 'admin' ? '内容管理' : pageLabels[page]

/** Compact navigation uses the existing guarded router; the disclosure owns no route state. */
export function AppHeader({ page, profile, onNavigate, adminAllowed, supportOnly = false }: AppHeaderProps) {
  const [expanded, setExpanded] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const activePage = page === 'training' ? 'home' : page
  const moreActive = morePages.includes(activePage) && (activePage !== 'admin' || adminAllowed)

  useEffect(() => { setExpanded(false) }, [page, profile?.id, adminAllowed])

  useEffect(() => {
    if (!expanded) return
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target) && !toggleRef.current?.contains(event.target)) setExpanded(false)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setExpanded(false)
      toggleRef.current?.focus({ preventScroll: true })
    }
    const dismissOnResize = () => {
      if (panelRef.current?.contains(document.activeElement)) toggleRef.current?.focus({ preventScroll: true })
      setExpanded(false)
    }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('focusin', dismissOutside)
    document.addEventListener('keydown', dismissOnEscape)
    window.addEventListener('resize', dismissOnResize)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('focusin', dismissOutside)
      document.removeEventListener('keydown', dismissOnEscape)
      window.removeEventListener('resize', dismissOnResize)
    }
  }, [expanded])

  function navigate(target: Page, fromPanel = false) {
    // Restore focus before calling the router: a blocked/confirmed navigation may
    // focus its own dialog or page, and the header must not steal that focus later.
    if (fromPanel) toggleRef.current?.focus({ preventScroll: true })
    setExpanded(false)
    onNavigate(target)
  }

  function link(target: Page, fromPanel = false) {
    const disabled = !profile && !['home', 'skills', 'about', 'admin'].includes(target)
    const active = activePage === target
    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      if (disabled) { event.preventDefault(); return }
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      navigate(target, fromPanel)
    }
    return <a key={target} href={routeHash({ page: target })} className={active ? 'is-active' : undefined}
      aria-current={active ? 'page' : undefined} aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : undefined} onClick={handleClick}>
      {target === 'admin' && supportOnly ? '用户反馈' : labelFor(target)}
    </a>
  }

  return <header className="app-header compact-app-header">
    <button type="button" className="brand" onClick={() => navigate('home')} aria-label="返回首页">
      文言 <span>·</span> 推理
    </button>
    <nav className="compact-header-nav" aria-label="主导航">
      {primaryPages.map(target => link(target))}
      <button type="button" ref={toggleRef} className={`header-more-toggle${moreActive ? ' is-current' : ''}`}
        aria-expanded={expanded} aria-controls="app-more-navigation"
        aria-label={moreActive ? `更多导航，当前：${labelFor(activePage)}` : '更多导航'}
        onClick={() => setExpanded(value => !value)}>
        更多 <span className="header-more-chevron" aria-hidden="true">⌄</span>
        {moreActive && <span className="header-current-dot" aria-hidden="true" />}
      </button>
      {expanded && <div id="app-more-navigation" className="header-more-panel" ref={panelRef}>
        <p className="header-more-title">探索与了解</p>
        <div className="header-more-links">{morePages.filter(target => target !== 'admin' || adminAllowed).map(target => link(target, true))}</div>
        {!profile && <p className="header-more-hint">建立学习档案后，即可使用练习、试测与学习报告。</p>}
      </div>}
    </nav>
    <button type="button" className="account" aria-label="查看学习档案" onClick={() => profile && navigate('profile')}
      disabled={!profile}>{profile?.display_name.slice(0, 1) ?? '—'}</button>
  </header>
}
