import { useEffect, useState } from 'react'

/** Session-local visual preference only. No account, storage or routing writes. */
export function useInkMotion() {
  const [reduced, setReduced] = useState(false)
  const [systemReduced, setSystemReduced] = useState(() => typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)').matches : true)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    let disposed = false
    const change = () => { if (!disposed) setSystemReduced(media.matches) }
    change()
    const modern = typeof media.addEventListener === 'function'
    if (modern) media.addEventListener('change', change)
    else media.addListener?.(change)
    return () => {
      disposed = true
      if (modern) media.removeEventListener('change', change)
      else media.removeListener?.(change)
    }
  }, [])
  return { enabled: !reduced && !systemReduced, reduced, systemReduced, setReduced }
}

export function InkMotionControl({ reduced, systemReduced, onChange }: { reduced: boolean; systemReduced: boolean; onChange: (value: boolean) => void }) {
  return <div className="ink-motion-control">
    <span>入画·墨动 <small>本地交互样板</small></span>
    <label><input type="checkbox" checked={reduced || systemReduced} disabled={systemReduced} onChange={event => onChange(event.target.checked)} />减少动效</label>
    {systemReduced && <small>遵循系统设置</small>}
  </div>
}
