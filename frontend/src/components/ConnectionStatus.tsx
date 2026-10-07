import { useEffect, useState } from 'react'

/** Browser connectivity is a hint, not a probe of the local API. */
export function ConnectionStatus() {
  const [offline, setOffline] = useState(!navigator.onLine)
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine)
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  return offline ? <p className="connection-status" role="status">浏览器报告网络已断开。当前内容可继续阅读；本地服务是否可用以实际请求为准，操作不会自动重试。</p> : null
}
