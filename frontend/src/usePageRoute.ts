import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { readRoute, routeHash, type Page, type PageRoute } from './navigation'

export type ExitRisk = 'dirty' | 'working' | 'uncertain' | null

export function usePageRoute(risk: MutableRefObject<ExitRisk>) {
  const [route, updateRoute] = useState<PageRoute>(() => readRoute(location.hash))
  const current = useRef(route)
  const index = useRef(Number.isInteger(history.state?.wenyanIndex) ? history.state.wenyanIndex as number : 0)
  const restoring = useRef(false)
  const mayLeave = useCallback(() => {
    if (risk.current === 'working') { window.alert('操作正在进行，请等待结果返回后再离开。'); return false }
    if (risk.current === 'uncertain') return window.confirm('上次操作的结果尚未确认。离开后请返回对应页面重新读取进度，系统不会自动重试。确定离开吗？')
    return risk.current !== 'dirty' || window.confirm('当前有未保存的修改或作答，确定放弃并离开吗？')
  }, [risk])
  const setPage = useCallback((page: Page, sessionId?: string, replace = false) => {
    const next = readRoute(routeHash({ page, sessionId }))
    const hash = routeHash(next)
    if (hash === routeHash(current.current) && hash === location.hash) return true
    if (!replace && !mayLeave()) return false
    if (!replace) index.current += 1
    history[replace ? 'replaceState' : 'pushState']({ ...history.state, wenyanIndex: index.current }, '', hash)
    current.current = next; updateRoute(next)
    return true
  }, [mayLeave])
  useEffect(() => {
    history.replaceState({ ...history.state, wenyanIndex: index.current }, '', location.hash ? routeHash(current.current) : location.href)
    const changed = () => {
      if (restoring.current) { restoring.current = false; return }
      const next = readRoute(location.hash)
      if (routeHash(next) === routeHash(current.current)) {
        if (location.hash !== routeHash(next)) history.replaceState(history.state, '', routeHash(next))
        return
      }
      const nextIndex = history.state?.wenyanIndex
      if (!mayLeave()) {
        if (Number.isInteger(nextIndex) && nextIndex !== index.current) { restoring.current = true; history.go(index.current - nextIndex) }
        else history.pushState({ ...history.state, wenyanIndex: index.current }, '', routeHash(current.current))
        return
      }
      index.current = Number.isInteger(nextIndex) ? nextIndex : index.current + 1
      history.replaceState({ ...history.state, wenyanIndex: index.current }, '', routeHash(next))
      current.current = next; updateRoute(next)
    }
    const unloading = (event: BeforeUnloadEvent) => { if (risk.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('popstate', changed); window.addEventListener('hashchange', changed)
    window.addEventListener('beforeunload', unloading)
    return () => { window.removeEventListener('popstate', changed); window.removeEventListener('hashchange', changed); window.removeEventListener('beforeunload', unloading) }
  }, [mayLeave, risk])
  return { route, page: route.page, setPage }
}
