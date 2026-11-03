import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { readRoute, routeHash, type Page, type PageRoute } from './navigation'
import { useConfirmationDialog } from './components/ConfirmationDialog'

export type ExitRisk = 'dirty' | 'working' | 'uncertain' | null

export function usePageRoute(risk: MutableRefObject<ExitRisk>) {
  const [route, updateRoute] = useState<PageRoute>(() => readRoute(location.hash))
  const current = useRef(route)
  const index = useRef(Number.isInteger(history.state?.wenyanIndex) ? history.state.wenyanIndex as number : 0)
  const restoring = useRef(false)
  const afterRestoring = useRef<(() => void) | null>(null)
  const acceptedHistory = useRef<{ hash: string; index: number } | null>(null)
  const confirmation = useConfirmationDialog(routeHash(route))
  const mayLeave = useCallback((onConfirm: () => void) => {
    if (!risk.current) return true
    const origin = routeHash(current.current)
    const working = risk.current === 'working', uncertain = risk.current === 'uncertain'
    confirmation.ask({
      title: working ? '操作仍在进行' : uncertain ? '提交结果尚未确认' : '放弃未保存的修改？',
      message: working ? '请等待结果返回后再离开。当前操作不会重复提交。' : uncertain ? '离开后请返回对应页面重新读取进度。已确认记录保留，系统不会自动重试尚未确认的提交。' : '当前选项或理由还未保存。取消可继续编辑；确认离开只保留服务端已确认的记录。',
      confirmLabel: working ? '留在当前页面' : '确认离开',
      onConfirm: () => { if (!working && risk.current !== 'working' && routeHash(current.current) === origin) onConfirm() },
    })
    return false
  }, [risk, confirmation.ask])
  const commit = useCallback((next: PageRoute, replace: boolean) => {
    const hash = routeHash(next)
    if (hash === routeHash(current.current) && hash === location.hash) return true
    if (!replace) index.current += 1
    history[replace ? 'replaceState' : 'pushState']({ ...history.state, wenyanIndex: index.current }, '', hash)
    current.current = next; updateRoute(next)
    // pushState/replaceState do not emit hashchange. Notify ancillary UI only
    // after an accepted commit; no session identifier is included in the event.
    window.dispatchEvent(new Event('wenyan:route-change'))
    return true
  }, [])
  const setPage = useCallback((page: Page, sessionId?: string, replace = false) => {
    const next = readRoute(routeHash({ page, sessionId }))
    if (routeHash(next) === routeHash(current.current)) return true
    if (!replace && !mayLeave(() => { commit(next, false) })) return false
    return commit(next, replace)
  }, [commit, mayLeave])
  useEffect(() => {
    history.replaceState({ ...history.state, wenyanIndex: index.current }, '', location.hash ? routeHash(current.current) : location.href)
    const changed = () => {
      const next = readRoute(location.hash)
      if (restoring.current) {
        if (routeHash(next) === routeHash(current.current)) {
          restoring.current = false
          const queued = afterRestoring.current; afterRestoring.current = null; queued?.()
        }
        return
      }
      if (routeHash(next) === routeHash(current.current)) {
        if (location.hash !== routeHash(next)) history.replaceState(history.state, '', routeHash(next))
        return
      }
      const nextIndex = history.state?.wenyanIndex
      const accepted = acceptedHistory.current?.hash === routeHash(next) && acceptedHistory.current.index === nextIndex
      acceptedHistory.current = null
      const travel = () => {
        const resume = () => {
          if (Number.isInteger(nextIndex) && nextIndex !== index.current) {
            acceptedHistory.current = { hash: routeHash(next), index: nextIndex }
            history.go(nextIndex - index.current)
          } else commit(next, false)
        }
        if (restoring.current) afterRestoring.current = resume
        else resume()
      }
      if (!accepted && !mayLeave(travel)) {
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
  }, [commit, mayLeave, risk])
  return { route, page: route.page, setPage, navigationModal: confirmation.modal }
}
