import { useEffect, useRef } from 'react'
import './inkScene.css'

export type InkSceneProps = {
  enabled: boolean
  compact?: boolean
  sceneKey?: string
}

const stillFrame = 'translate3d(-0.4%, -0.3%, 0) scale(1.06)'
const compactFrame = 'translate3d(-0.2%, -0.15%, 0) scale(1.03)'

/** One existing painting, viewed through a quiet, single-shot camera.
 *  This is decoration only; the owner must isolate and clip its container.
 *  A data rerender is not a new scene. Only the scalar scene identity or an
 *  explicit motion/layout preference can start another shot.
 */
export function InkScene({ enabled, compact = false, sceneKey = '' }: InkSceneProps) {
  const artRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const art = artRef.current
    // Unknown preference/API support is a static fallback, never permission
    // to animate. CSS independently enforces both disabled and reduced modes.
    if (!enabled || !art || typeof art.animate !== 'function'
      || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return

    let reduced: MediaQueryList
    let narrow: boolean
    try {
      reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
      narrow = window.matchMedia('(max-width: 44rem)').matches
    } catch { return }

    let disposed = false
    let running: Animation | null = null
    const stop = () => {
      const active = running
      running = null
      if (active) {
        active.onfinish = null
        active.oncancel = null
        active.cancel()
      }
    }
    // Opting back into motion does not unexpectedly replay the current scene.
    // The next explicit sceneKey/enable transition may start a new shot.
    const preferenceChanged = () => { if (!disposed && reduced.matches) stop() }
    const modern = typeof reduced.addEventListener === 'function'
    if (modern) reduced.addEventListener('change', preferenceChanged)
    else if (typeof reduced.addListener === 'function') reduced.addListener(preferenceChanged)

    if (!reduced.matches) {
      try {
        const animation = art.animate(
          [{ transform: 'translate3d(0, 0, 0) scale(1)' }, { transform: compact ? compactFrame : stillFrame }],
          { duration: compact || narrow ? 500 : 800, easing: 'cubic-bezier(.2,.75,.25,1)', iterations: 1, fill: 'none' },
        )
        running = animation
        const release = () => {
          animation.onfinish = null
          animation.oncancel = null
          if (!disposed && running === animation) running = null
        }
        animation.onfinish = release
        animation.oncancel = release
      } catch {
        // Unsupported/failed animation must never block the real reading UI.
      }
    }

    return () => {
      disposed = true
      if (modern) reduced.removeEventListener('change', preferenceChanged)
      else if (typeof reduced.removeListener === 'function') reduced.removeListener(preferenceChanged)
      stop()
    }
  }, [enabled, compact, sceneKey])

  return <span className={`ink-scene${compact ? ' ink-scene--compact' : ''}`} aria-hidden="true" data-motion={enabled ? 'on' : 'off'}>
    <span className="ink-scene__art" ref={artRef} />
  </span>
}
