import { useEffect, useState } from 'react'
import { connectionTransition, observeConnectivity, type ConnectionState } from '../connectivity'
import './connectionStatus.css'

/** Browser connectivity is a hint, not a probe of the local API. */
export function ConnectionStatus() {
  const [state, setState] = useState<ConnectionState>(() => navigator.onLine === false ? 'offline' : 'online')
  useEffect(() => observeConnectivity(window, () => navigator.onLine !== false,
    online => setState(previous => connectionTransition(previous, online))), [])
  if (state === 'online') return null
  return <aside className="connection-status" aria-label="浏览器网络提示">
    <div role="status" aria-live="polite" aria-atomic="true">
      <strong>{state === 'offline' ? '浏览器报告网络已断开' : '浏览器报告网络已恢复'}</strong>
      <p>{state === 'offline'
        ? '已显示的内容可继续阅读。先保留当前页面和未保存的输入；恢复网络后再按页面提示读取或核对，操作不会自动重试。'
        : '这不代表提交已经保存或学习服务已恢复。若页面提示结果尚未确认，请使用原操作的“核对”入口；没有自动重发任何操作。'}</p>
    </div>
    {state === 'reconnected' && <button type="button" onClick={() => setState('online')}>收起网络提示</button>}
  </aside>
}
