export type ConnectionState = 'online' | 'offline' | 'reconnected'

/** Browser hints cannot establish that the API is reachable or a write saved. */
export function connectionTransition(previous: ConnectionState, online: boolean): ConnectionState {
  return !online ? 'offline' : previous === 'offline' ? 'reconnected' : previous
}

/** Recheck after a mobile tab returns, without probes, polling or request replay. */
export function observeConnectivity(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, readOnline: () => boolean, changed: (online: boolean) => void) {
  const update = () => changed(readOnline())
  const events = ['online', 'offline', 'pageshow', 'focus'] as const
  for (const event of events) target.addEventListener(event, update)
  update()
  return () => { for (const event of events) target.removeEventListener(event, update) }
}
