import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import './trainingReaderDialog.css'

type Props = { open: boolean; onClose: () => void; children: ReactNode; identity: string; busy?: boolean }
type ScrollLease = { count: number; restore: () => void }
const scrollLeases = new WeakMap<Document, ScrollLease>()

// Native showModal supplies background inertness; this lease only prevents the
// document behind it from scrolling. Nested readers cannot release each other.
function lockDocumentScroll(doc: Document) {
  let lease = scrollLeases.get(doc)
  if (!lease) {
    const originals = [doc.documentElement, doc.body].map(element => ({
      element, value: element.style.getPropertyValue('overflow'), priority: element.style.getPropertyPriority('overflow'),
    }))
    for (const { element } of originals) element.style.setProperty('overflow', 'hidden')
    lease = { count: 0, restore: () => {
      for (const { element, value, priority } of originals) {
        // A later owner may intentionally have changed the style while open.
        if (element.style.getPropertyValue('overflow') !== 'hidden') continue
        if (value) element.style.setProperty('overflow', value, priority)
        else element.style.removeProperty('overflow')
      }
    } }
    scrollLeases.set(doc, lease)
  }
  lease.count += 1
  let released = false
  return () => {
    if (released) return
    released = true
    if (--lease.count === 0) { lease.restore(); scrollLeases.delete(doc) }
  }
}

/** A reading surface only: it never saves, clears, or submits a training draft. */
export function TrainingReaderDialog({ open, onClose, children, identity, busy = false }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const previousIdentity = useRef(identity)
  const latest = useRef({ identity, busy, onClose })
  latest.current = { identity, busy, onClose }
  const [identityBlocked, setIdentityBlocked] = useState(false)
  const identityChanged = previousIdentity.current !== identity
  const titleId = useId(), helpId = useId()
  const ownCloseEvents = useRef(0)

  useLayoutEffect(() => {
    if (previousIdentity.current !== identity) {
      previousIdentity.current = identity
      setIdentityBlocked(open)
      if (open) latest.current.onClose()
      return
    }
    if (!open) { setIdentityBlocked(false); return }
    if (identityBlocked || !dialog.current) return
    const node = dialog.current, doc = node.ownerDocument
    const trigger = doc.activeElement instanceof HTMLElement ? doc.activeElement : null
    if (!node.open) node.showModal()
    const unlock = lockDocumentScroll(doc)
    heading.current?.focus({ preventScroll: true })
    return () => {
      const focused = doc.activeElement
      const mayRestore = focused === doc.body || focused === node || node.contains(focused)
      if (node.open) { ownCloseEvents.current += 1; node.close() }
      unlock()
      // Never return focus across a user/session/stage change or over a newer
      // modal/route destination. The parent owns the next screen's focus.
      if (latest.current.identity !== identity || !mayRestore || !trigger?.isConnected || trigger.closest('[inert], [hidden]') || doc.querySelector('dialog[open]')) return
      if (doc.activeElement === doc.body || doc.activeElement === trigger || doc.activeElement === node || node.contains(doc.activeElement)) trigger.focus({ preventScroll: true })
    }
  }, [open, identity, identityBlocked])

  function requestClose() {
    if (!open || latest.current.busy || latest.current.identity !== identity || identityBlocked || identityChanged) return
    latest.current.onClose()
  }
  function trapTab(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.defaultPrevented || event.key !== 'Tab' || !dialog.current) return
    const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'))
      .filter(element => element.tabIndex >= 0 && !element.closest('[inert], [hidden]') && element.getClientRects().length > 0)
    const first = controls[0], last = controls[controls.length - 1]
    const focused = dialog.current.ownerDocument.activeElement
    if (!first) { event.preventDefault(); heading.current?.focus({ preventScroll: true }); return }
    if (event.shiftKey && (focused === first || !controls.includes(focused as HTMLElement))) { event.preventDefault(); last.focus({ preventScroll: true }) }
    else if (!event.shiftKey && (focused === last || !controls.includes(focused as HTMLElement))) { event.preventDefault(); first.focus({ preventScroll: true }) }
  }

  return <dialog ref={dialog} className="training-reader-dialog" aria-labelledby={titleId} aria-describedby={helpId}
    onKeyDown={trapTab} onCancel={event => { event.preventDefault(); requestClose() }}
    onClose={() => {
      if (ownCloseEvents.current) { ownCloseEvents.current -= 1; return }
      if (!dialog.current?.open) requestClose()
    }}>
    <header className="training-reader-header">
      <div><p className="training-reader-eyebrow">原文与语境</p><h2 ref={heading} id={titleId} tabIndex={-1}>带着问题读原文。</h2></div>
      <button type="button" className="training-reader-close" disabled={busy} onClick={requestClose}>返回题目</button>
      <p id={helpId} className="training-reader-help" role="status">{busy ? '正在等待确认，请稍候再返回；当前内容不会自动提交。' : '点字读语境；选好依据后返回题目。关闭阅读面板不会清除当前草稿。'}</p>
    </header>
    <div className="training-reader-scroll" tabIndex={0} aria-label="原文与五层语境阅读区">{!identityChanged && !identityBlocked ? children : null}</div>
  </dialog>
}
