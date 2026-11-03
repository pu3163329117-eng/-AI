import { useLayoutEffect, useMemo, useRef } from 'react'
import { segmentTitle, titleRepulsion, TITLE_RETURN_MS } from './repellingTitleMath'
import './repellingTitle.css'

type Props = { text: string; id?: string; enabled: boolean; className?: string }
type Baseline = { left: number; top: number; right: number; x: number; y: number }

/** One semantic/selectable h1. Empty pseudo-glyphs are only a local paint layer. */
export function RepellingTitle({ text, id, enabled, className = '' }: Props) {
  const title = useRef<HTMLHeadingElement>(null)
  const realText = useRef<HTMLSpanElement>(null)
  const decoration = useRef<HTMLSpanElement>(null)
  const segments = useMemo(() => segmentTitle(text), [text])

  useLayoutEffect(() => {
    const heading = title.current, original = realText.current, overlay = decoration.current
    if (!heading || !original || !overlay || !enabled || !segments.length || typeof window.matchMedia !== 'function') return
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)')
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    // Older MediaQueryList implementations use addListener. If neither API is
    // present, keep the complete static heading instead of failing mount.
    if ([fine, reduced].some(query => !query || (typeof query.addEventListener !== 'function' && typeof query.addListener !== 'function'))) return
    const glyphs = Array.from(overlay.querySelectorAll<HTMLElement>('[data-title-glyph]'))
    let alive = true, frame: number | null = null, returning: number | null = null, returnEpoch = 0
    let point: { x: number; y: number } | null = null, baseline: Baseline[] | null = null
    let measuredBox: { left: number; top: number; width: number; height: number } | null = null
    let pressed = false, selecting = false

    function cancelFrame() {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = null
    }
    function cancelReturn() {
      returnEpoch++
      if (returning !== null) window.clearTimeout(returning)
      returning = null
    }
    function reset(immediate = true) {
      cancelFrame(); cancelReturn(); point = null
      if (immediate || heading!.dataset.motionActive !== 'true') {
        heading!.dataset.motionActive = 'false'
        heading!.dataset.motionResting = 'false'
        glyphs.forEach(glyph => { glyph.style.transform = 'none' })
        return
      }
      heading!.dataset.motionResting = 'true'
      glyphs.forEach(glyph => { glyph.style.transform = 'translate3d(0, 0, 0)' })
      const epoch = returnEpoch
      returning = window.setTimeout(() => {
        if (!alive || point || epoch !== returnEpoch) return
        returning = null
        heading!.dataset.motionActive = 'false'
        heading!.dataset.motionResting = 'false'
      }, TITLE_RETURN_MS)
    }
    function hasSelection() {
      const selection = window.getSelection?.()
      return Boolean(selection && !selection.isCollapsed)
    }
    function allowed() {
      return alive && fine.matches && !reduced.matches && !document.hidden && !pressed && !selecting && !hasSelection()
    }
    function measure(): Baseline[] | null {
      const node = original!.firstChild
      if (!node || node.nodeType !== 3 || glyphs.length !== segments.length) return null
      const headingBox = heading!.getBoundingClientRect(), overlayBox = overlay!.getBoundingClientRect()
      measuredBox = { left: headingBox.left, top: headingBox.top, width: headingBox.width, height: headingBox.height }
      const computed = window.getComputedStyle(heading!)
      const lineTop = headingBox.top + heading!.clientTop + (parseFloat(computed.paddingTop) || 0)
      // Read every DOM Range before writing positions; transformed paint spans
      // are NEVER the geometry input for a subsequent frame.
      const boxes = segments.map(segment => {
        const range = document.createRange()
        range.setStart(node, segment.start); range.setEnd(node, segment.end)
        const box = range.getBoundingClientRect()
        range.detach()
        return box
      })
      if (!boxes.length || boxes[0].height <= 0 || boxes.some(box => !Number.isFinite(box.left) || box.height <= 0)) return null
      const leading = boxes[0].top - lineTop
      const positions = boxes.map(box => ({ left: box.left, right: box.right,
        top: box.top - leading - overlayBox.top, x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 }))
      positions.forEach((position, index) => {
        glyphs[index].style.left = `${position.left - overlayBox.left}px`
        glyphs[index].style.top = `${position.top}px`
      })
      return positions
    }
    function paint() {
      if (!alive) return // An obsolete cancelled frame cannot reset a new effect.
      frame = null
      if (!allowed() || !point) { reset(); return }
      if (baseline && measuredBox) {
        const box = heading!.getBoundingClientRect()
        if (box.left !== measuredBox.left || box.top !== measuredBox.top || box.width !== measuredBox.width || box.height !== measuredBox.height) baseline = null
      }
      baseline ??= measure()
      if (!baseline) { reset(); return }
      const target = point
      const offsets = baseline.map(center => titleRepulsion(center, target))
      if (!offsets.some(offset => offset.x || offset.y)) { reset(false); return }
      cancelReturn()
      heading!.dataset.motionResting = 'false'
      heading!.dataset.motionActive = 'true'
      const viewport = document.documentElement.clientWidth
      offsets.forEach((offset, index) => {
        // Decoration must not introduce horizontal viewport overflow at an edge.
        const center = baseline![index]
        const x = Math.max(-Math.max(0, center.left), Math.min(offset.x, Math.max(0, viewport - center.right)))
        glyphs[index].style.transform = `translate3d(${x.toFixed(3)}px, ${offset.y.toFixed(3)}px, 0)`
      })
    }
    function pointerMove(event: PointerEvent) {
      if (event.pointerType !== 'mouse' || event.buttons !== 0 || !allowed()) { reset(); return }
      // A single pending rAF absorbs arbitrarily many pointer events. No React
      // state setter, rerender, timer loop, or global preference write per frame.
      point = { x: event.clientX, y: event.clientY }
      if (frame === null) frame = window.requestAnimationFrame(paint)
    }
    function down() { pressed = true; reset() }
    function up() { pressed = false; selecting = false; reset() }
    function selectionStart() { selecting = true; reset() }
    function selectionChange() { if (hasSelection()) reset() }
    function suspend() { pressed = false; selecting = false; baseline = null; reset() }
    function invalidateLayout() { baseline = null; reset() }
    function pointerOut(event: PointerEvent) { if (event.relatedTarget === null) reset(false) }
    function preferenceChange() { baseline = null; reset() }
    function watchPreference(query: MediaQueryList) {
      if (typeof query.addEventListener === 'function') {
        query.addEventListener('change', preferenceChange)
        return () => query.removeEventListener('change', preferenceChange)
      }
      query.addListener(preferenceChange)
      return () => query.removeListener(preferenceChange)
    }
    const unwatchFine = watchPreference(fine), unwatchReduced = watchPreference(reduced)
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(invalidateLayout) : null
    resize?.observe(heading)
    heading.addEventListener('pointermove', pointerMove, { passive: true })
    heading.addEventListener('pointerenter', pointerMove, { passive: true })
    const leave = () => reset(false)
    heading.addEventListener('pointerleave', leave, { passive: true })
    window.addEventListener('pointerdown', down, { passive: true })
    window.addEventListener('pointerup', up, { passive: true })
    window.addEventListener('pointercancel', up, { passive: true })
    window.addEventListener('pointerout', pointerOut, { passive: true })
    window.addEventListener('blur', suspend)
    window.addEventListener('resize', invalidateLayout, { passive: true })
    window.addEventListener('scroll', invalidateLayout, { capture: true, passive: true })
    window.addEventListener('keydown', suspend)
    document.addEventListener('visibilitychange', suspend)
    document.addEventListener('selectstart', selectionStart)
    document.addEventListener('selectionchange', selectionChange)
    document.fonts?.addEventListener?.('loadingdone', invalidateLayout)
    document.fonts?.addEventListener?.('loadingerror', invalidateLayout)
    return () => {
      alive = false; reset()
      resize?.disconnect()
      heading.removeEventListener('pointermove', pointerMove)
      heading.removeEventListener('pointerenter', pointerMove)
      heading.removeEventListener('pointerleave', leave)
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('pointerout', pointerOut)
      window.removeEventListener('blur', suspend)
      window.removeEventListener('resize', invalidateLayout)
      window.removeEventListener('scroll', invalidateLayout, true)
      window.removeEventListener('keydown', suspend)
      document.removeEventListener('visibilitychange', suspend)
      document.removeEventListener('selectstart', selectionStart)
      document.removeEventListener('selectionchange', selectionChange)
      document.fonts?.removeEventListener?.('loadingdone', invalidateLayout)
      document.fonts?.removeEventListener?.('loadingerror', invalidateLayout)
      unwatchFine(); unwatchReduced()
    }
  }, [enabled, segments])

  return <h1 id={id} ref={title} data-motion-enabled={enabled ? 'true' : 'false'} className={`repelling-title ${className}`.trim()}>
    <span ref={realText} className="repelling-title__text">{text}</span>
    <span ref={decoration} className="repelling-title__decoration" aria-hidden="true">
      {segments.map((segment, index) => <span key={index} data-title-glyph={segment.text} className="repelling-title__glyph" />)}
    </span>
  </h1>
}
