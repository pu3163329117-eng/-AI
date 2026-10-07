import { useEffect, useState } from 'react'
import { knowledgeApi } from '../api'
import type { ContextSelection, KnowledgeLookup } from '../types'

function safeUrl(url: string | null) {
  return url && /^https?:\/\//i.test(url) ? url : null
}

/** Read-only knowledge lookup. It does not submit answers or award mastery. */
export function WordKnowledge({ sessionId, selection, stage }: {
  sessionId: string
  selection: ContextSelection | null
  stage: string
}) {
  const [offset, setOffset] = useState(0)
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState<{ key: string; data: KnowledgeLookup | null; error: string | null }>({ key: '', data: null, error: null })
  const selectionKey = `${sessionId}:${stage}:${selection?.paragraph_index}:${selection?.start}:${selection?.end}`
  const [pageFor, setPageFor] = useState(selectionKey)
  const [expandedFor, setExpandedFor] = useState<{ key: string; open: boolean }>({ key: '', open: false })
  const currentOffset = pageFor === selectionKey ? offset : 0
  const queryKey = `${selectionKey}:${currentOffset}:${retry}`

  useEffect(() => {
    if (!selection) return
    const controller = new AbortController()
    knowledgeApi.lookup(sessionId, selection.paragraph_index, selection.start, selection.end, currentOffset, controller.signal)
      .then(data => { if (!controller.signal.aborted) setState({ key: queryKey, data, error: null }) })
      .catch(() => { if (!controller.signal.aborted) setState({ key: queryKey, data: null, error: '字词资料暂时未能加载，请重试。' }) })
    return () => controller.abort()
  }, [sessionId, selection?.paragraph_index, selection?.start, selection?.end, stage, currentOffset, queryKey])

  if (!selection) return null
  const ready = state.key === queryKey
  const data = ready ? state.data : null
  const loading = !ready
  const page = (next: number) => { setPageFor(selectionKey); setOffset(next) }

  return <section className="word-knowledge" aria-label={`“${selection.token}”的字词释义`} aria-busy={loading}>
    <h3>“{selection.token}”的本句释义</h3>
    <p className="knowledge-note">阅读资料 · 不自动作答或记为掌握</p>
    {loading && <p role="status">正在查找本句注释…</p>}
    {ready && state.error && <div role="alert"><p>{state.error}</p><button type="button" className="knowledge-action" onClick={() => setRetry(retry + 1)}>重新加载资料</button></div>}
    {data && <>
      {data.document && <p className="knowledge-coverage">本篇已释义 {data.document.annotated_positions} / {data.document.indexed_positions} 字位 · {data.document.total_annotations} 条注释</p>}
      {data.status === 'UNAVAILABLE' && <p>这个历史原文版本尚未建库。保留原有语境，不将新版注释套入旧文。</p>}
      {data.status === 'PENDING' && <p>这个位置的释义尚未补齐。已保留原文定位，暂不提供未经整理的猜测。</p>}
      {data.annotations.map(annotation => <article className="word-annotation" key={annotation.id}>
        <header><b>{annotation.token}</b><span>整理草稿 · 待教研核对</span></header>
        {(annotation.start !== selection.start || annotation.end !== selection.end) && <p className="knowledge-note">{annotation.start <= selection.start && annotation.end >= selection.end ? `所选字属于词组“${annotation.token}”，按词组解释。` : `所选范围内的词项 · 第 ${annotation.start + 1}–${annotation.end} 字`}</p>}
        <p className="word-meaning">{annotation.meaning}</p>
        <p>{annotation.part_of_speech}</p>
        <p className="word-variability">{annotation.variability === 'CONTEXTUAL' ? '变量 · 需结合语境辨义' : '无变量 · 本句相对确定'}</p>
        <p>{annotation.reasoning}</p>
      </article>)}
      {data.related.total > 0 && <details className="related-contexts" key={selectionKey}
        open={expandedFor.key === selectionKey && expandedFor.open}
        onToggle={event => setExpandedFor({ key: selectionKey, open: event.currentTarget.open })}>
        <summary>其他语境 · {data.related.total} 处</summary>
        <p className="knowledge-note">仅列现有语料中已注释的出现处；同义项不代表句意完全相同。</p>
        {data.related.items.map(item => <article key={`${item.source}:${item.paragraph_index}:${item.start}:${item.end}`}>
          <p className="related-relation">{item.relation === 'SAME_SENSE' ? '同义项例证' : '同字／词的其他用法'}</p>
          <blockquote>{item.sentence}</blockquote>
          <p>“{item.token}”：{item.meaning}</p>
          <p className="knowledge-note">{item.source} · 第 {item.paragraph_index + 1} 段 · 第 {item.start + 1}–{item.end} 字{safeUrl(item.source_url) && <> · <a href={safeUrl(item.source_url)!} target="_blank" rel="noreferrer">原典</a></>}</p>
        </article>)}
        <div className="related-pagination" aria-label="其他语境分页">
          <button type="button" className="knowledge-action" disabled={currentOffset === 0} onClick={() => page(Math.max(0, currentOffset - 5))}>上一页</button>
          <span>{currentOffset + 1}–{Math.min(currentOffset + 5, data.related.total)} / {data.related.total}</span>
          <button type="button" className="knowledge-action" disabled={currentOffset + 5 >= data.related.total} onClick={() => page(currentOffset + 5)}>下一页</button>
        </div>
      </details>}
      {data.status === 'ANNOTATED' && data.related.total === 0 && <p className="knowledge-note">现有已注释语料暂未收录其他相关语境。</p>}
    </>}
  </section>
}
