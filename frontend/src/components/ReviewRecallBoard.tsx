import { useId, useMemo, useState } from 'react'
import type { Mistake } from '../types'
import { reviewAttemptLabel, reviewContentKey, selectReviewItems, type ReviewOrder } from '../reviewRecall'
import './reviewRecall.css'

function RecallCard({ item, busy, onStart }: { item: Mistake; busy: boolean; onStart: (id: string) => void }) {
  const [revealed, setRevealed] = useState(false)
  const hintId = useId()
  return <article className="recall-card">
    <div className="recall-card-heading"><p>{item.source} · {reviewAttemptLabel(item.latest_attempt_at)}</p><span>累计错答 {item.wrong_attempts} 次</span></div>
    <h3>{item.title}</h3>
    <blockquote>{item.passage}</blockquote>
    <p className="recall-question">试着回忆：<strong>“{item.variable}”</strong>在这里是什么意思？哪处上下文支持你的判断？</p>
    <div className="recall-actions">
      <button type="button" className="button button-secondary" aria-expanded={revealed} aria-controls={hintId} onClick={() => setRevealed(value => !value)}>{revealed ? '收起回看提示' : '回忆后，查看提示'} <span aria-hidden="true">{revealed ? '−' : '+'}</span></button>
      <button type="button" className="button button-primary" disabled={busy} onClick={() => onStart(item.lesson_id)}>{busy ? '正在进入…' : '回到语境重练'} <span aria-hidden="true">→</span></button>
    </div>
    <div id={hintId}>{revealed && <aside className="recall-hint"><p className="eyebrow">回看线索 · 不是作答评分</p><p>{item.review_hint.trim() || '这道题暂未配置回看提示，可以回到原关卡重新寻找上下文证据。'}</p></aside>}</div>
  </article>
}

export function ReviewRecallBoard({ items, busy, onStart }: { items: Mistake[]; busy: boolean; onStart: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const [order, setOrder] = useState<ReviewOrder>('recent')
  const [limit, setLimit] = useState(10)
  const inputId = useId(), orderId = useId()
  const selected = useMemo(() => selectReviewItems(items, query, order), [items, query, order])
  function clearSearch() { setQuery(''); setLimit(10) }
  return <div className="recall-board">
    <div className="recall-guide"><span aria-hidden="true">01 / 02</span><div><h3>先回忆，再对照。</h3><p>先读原句，说出词义与证据，再展开提示。这里只帮助回忆；查看提示不计分、不代表掌握，重练沿用原关卡的作答规则。</p></div></div>
    <div className="recall-toolbar">
      <label htmlFor={inputId}>查找当前错题<input id={inputId} type="search" value={query} onChange={event => { setQuery(event.target.value); setLimit(10) }} placeholder="篇目、字词或原句" maxLength={120} /></label>
      <label htmlFor={orderId}>排列方式<select id={orderId} value={order} onChange={event => { setOrder(event.target.value as ReviewOrder); setLimit(10) }}><option value="recent">最近作答优先</option><option value="frequent">累计错答较多优先</option><option value="oldest">较久未作答优先</option></select></label>
    </div>
    <p className="recall-result-count" role="status">当前错题本共 {items.length} 项，匹配 {selected.length} 项{selected.length > limit ? `，先展示 ${limit} 项` : ''}。排序不代表记忆强度或到期安排。</p>
    {selected.length === 0 ? <div className="review-state"><b>没有找到匹配的错题。</b><p>试试篇目名或原句中的字词。</p><button type="button" className="text-button" onClick={clearSearch}>清空搜索 →</button></div>
      : <div className="recall-list">{selected.slice(0, limit).map(item => <RecallCard key={reviewContentKey(item)} item={item} busy={busy} onStart={onStart} />)}</div>}
    {selected.length > limit && <button type="button" className="button button-secondary recall-more" onClick={() => setLimit(value => value + 10)}>再展示 {Math.min(10, selected.length - limit)} 项 <span aria-hidden="true">↓</span></button>}
  </div>
}
