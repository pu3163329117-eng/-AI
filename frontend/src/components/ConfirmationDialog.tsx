import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { createConfirmationController, type ConfirmationRequest } from './confirmation'
import './confirmationDialog.css'

type ActiveConfirmation = {
  token: number
  identity: string | null
  request: ConfirmationRequest
  trigger: HTMLElement | null
  intent: boolean | null
}

/** Confirmation stays synchronous; only a harmless cancellation exit is animated. */
export function useConfirmationDialog(resetKey: string | null) {
  const [request, setRequest] = useState<ActiveConfirmation | null>(null)
  const [phase, setPhase] = useState<'closed' | 'open' | 'closing'>('closed')
  const controller = useRef(createConfirmationController())
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const active = useRef<ActiveConfirmation | null>(null)
  const sequence = useRef(0)
  const identity = useRef(resetKey)
  identity.current = resetKey
  const mounted = useRef(true)
  const timer = useRef<number | null>(null)
  const ownCloseEvents = useRef(0)
  const titleId = useId(), messageId = useId()

  function clearTimer() {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }
  function closeNative() {
    if (!dialog.current?.open) return
    ownCloseEvents.current++
    dialog.current.close()
  }
  function restoreFocus(entry: ActiveConfirmation | null) {
    const target = entry?.trigger
    if (!target?.isConnected || document.querySelector('dialog[open]')) return
    const focused = document.activeElement
    // A new route, identity or dialog may already own focus. Never steal it.
    if (focused !== document.body && focused !== dialog.current && !dialog.current?.contains(focused)) return
    target.focus({ preventScroll: true })
  }
  function invalidate(updateView: boolean) {
    clearTimer()
    const entry = active.current
    active.current = null
    closeNative()
    if (updateView) { setRequest(null); setPhase('closed') }
    restoreFocus(entry)
    if (entry && entry.intent === null) controller.current.resolve(false)
  }
  function finish(accepted: boolean, token: number | undefined) {
    const entry = active.current
    if (!entry || entry.token !== token || entry.intent !== null) return
    if (!mounted.current || identity.current !== entry.identity) { invalidate(mounted.current); return }
    entry.intent = accepted // Synchronous latch: duplicate pointer/keyboard events cannot resolve twice.
    if (accepted) {
      // Business callbacks keep their original synchronous timing. Close the
      // native modal before navigation/writes or a callback that asks again.
      clearTimer()
      active.current = null
      closeNative()
      setRequest(null)
      setPhase('closed')
      restoreFocus(entry)
      controller.current.resolve(true)
      return
    }
    controller.current.resolve(false) // Consume cancellation exactly once, before its visual exit.
    setPhase('closing')
    const complete = () => {
      if (active.current !== entry) return // An obsolete timer must not touch a newer ask.
      if (!mounted.current || identity.current !== entry.identity) { invalidate(mounted.current); return }
      timer.current = null
      active.current = null
      closeNative()
      setRequest(null)
      setPhase('closed')
      restoreFocus(entry)
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) complete()
    else timer.current = window.setTimeout(complete, 180)
  }
  useEffect(() => {
    if (!request || !dialog.current || active.current !== request || identity.current !== request.identity) return
    if (!dialog.current.open) dialog.current.showModal()
    cancel.current?.focus({ preventScroll: true })
  }, [request?.token])
  useEffect(() => {
    mounted.current = true
    invalidate(true)
    return () => {
      mounted.current = false
      invalidate(false) // Identity reset/unmount cancels immediately, never after an animation.
    }
  }, [resetKey])

  const ask = useCallback((next: ConfirmationRequest) => {
    if (!mounted.current || active.current) return
    if (!controller.current.request(next)) return
    const entry: ActiveConfirmation = {
      token: ++sequence.current, identity: identity.current, request: next, intent: null,
      trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    }
    active.current = entry
    setRequest(entry)
    setPhase('open')
  }, [])
  function trapKeyboard(event: KeyboardEvent<HTMLDialogElement>) {
    if (active.current && active.current.intent !== null) { event.preventDefault(); return }
    if (event.key !== 'Tab' || !dialog.current) return
    const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'))
      .filter(element => element.getClientRects().length > 0)
    const first = controls[0], last = controls[controls.length - 1]
    if (!first) { event.preventDefault(); return }
    const focused = document.activeElement
    if (event.shiftKey && (focused === first || !controls.includes(focused as HTMLElement))) {
      event.preventDefault(); last.focus({ preventScroll: true })
    } else if (!event.shiftKey && (focused === last || !controls.includes(focused as HTMLElement))) {
      event.preventDefault(); first.focus({ preventScroll: true })
    }
  }
  const modal = <dialog ref={dialog} className="confirmation-dialog" data-phase={phase}
    aria-labelledby={titleId} aria-describedby={messageId}
    onKeyDown={trapKeyboard}
    onCancel={event => { event.preventDefault(); finish(false, request?.token) }}
    onClose={() => {
      if (ownCloseEvents.current > 0) { ownCloseEvents.current--; return }
      if (!dialog.current?.open) invalidate(true)
    }}>
    <div className="confirmation-content"><span className="confirmation-eyebrow">文言 · 推理</span>
      <h2 id={titleId}>{request?.request.title}</h2><p id={messageId}>{request?.request.message}</p>
      <div className="confirmation-actions"><button ref={cancel} type="button" autoFocus disabled={phase === 'closing'} onClick={() => finish(false, request?.token)}>取消，保留当前状态</button>
        <button type="button" className="confirmation-accept" disabled={phase === 'closing'} onClick={() => finish(true, request?.token)}>{request?.request.confirmLabel ?? '确认'}</button></div>
    </div>
  </dialog>
  return { ask, modal }
}
