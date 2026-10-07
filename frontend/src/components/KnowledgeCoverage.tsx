import { useEffect, useState } from 'react'
import { knowledgeApi } from '../api'
import type { KnowledgeCoverage as Coverage } from '../types'

export function KnowledgeCoverage() {
  const [open, setOpen] = useState(false)
  const [retry, setRetry] = useState(0)
  const [data, setData] = useState<Coverage | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true); setError(false)
    knowledgeApi.coverage(controller.signal)
      .then(next => { if (!controller.signal.aborted) { setData(next); setLoading(false) } })
      .catch(() => { if (!controller.signal.aborted) { setError(true); setLoading(false) } })
    return () => controller.abort()
  }, [open, retry])
  return <details className="knowledge-overview" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>知识库收录与注释进度</summary>
    <div aria-busy={loading}>
      {loading && <p role="status">正在读取知识库进度…</p>}
      {error && <p role="alert">进度暂时未能加载。<button type="button" className="knowledge-action" onClick={() => setRetry(retry + 1)}>重试</button></p>}
      {!loading && !error && data && <>
        <p>{data.totals.documents} 个原文单元 · {data.totals.annotations} 条注释草稿 · 已覆盖 {data.totals.annotated_positions} / {data.totals.indexed_positions} 正文字位</p>
        <p>字位不含标点。词组可覆盖其中各字，但不等于每字都有独立字典义项。全部为整理草稿，尚未教师审定；其他语境仅指当前已收录语料。</p>
        <div className="knowledge-coverage-list">
          {data.documents.map(document => <div key={document.id}>
            <b>{document.source}</b>
            <span>{document.annotated_positions} / {document.indexed_positions} 字位 · {document.total_annotations} 条</span>
          </div>)}
        </div>
        {data.documents.length === 0 && <p>暂未收录原文单元。</p>}
      </>}
    </div>
  </details>
}
