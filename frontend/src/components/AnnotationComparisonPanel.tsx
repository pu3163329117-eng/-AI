import { useEffect, useId, useRef, useState } from 'react'
import { safeComparisonUrl, type AnnotationComparison, type ComparisonAnchor, type ComparisonItem } from '../annotationComparison'
import { readAnnotationComparisons } from '../annotationComparisonApi'
import { errorMessage, RequestError } from '../http'
import './annotationComparison.css'

const anchorKey = (anchor: ComparisonAnchor) => JSON.stringify([anchor.id, anchor.document_id, anchor.version, anchor.token, anchor.sense_key])

function ComparisonEntry({ item }: { item: ComparisonItem }) {
  const href = safeComparisonUrl(item.source_url)
  return <article className="annotation-comparison-entry">
    <header><p className="comparison-match">{item.match === 'SAME_KEY' ? '同义项键候选（待人工对照）' : '同字词其他用法'}</p><h4>“{item.token}” · {item.source}</h4>
      <p className="comparison-location">第 {item.paragraph_index + 1} 段 · 第 {item.start + 1}–{item.end} 字 · v{item.version}</p></header>
    <blockquote>{item.sentence}</blockquote>
    <dl><div><dt>本句释义</dt><dd>{item.meaning}</dd></div>
      <div><dt>词性与变量</dt><dd>{item.part_of_speech} · {item.variability === 'CONTEXTUAL' ? '变量 · 随本句语境推断' : '无变量 · 本句相对确定'}</dd></div>
      <div><dt>语境依据</dt><dd>{item.reasoning}</dd></div>
      <div><dt>注释依据／出处</dt><dd>{item.citation.trim() ? item.citation : '尚未登记注释出处'}</dd></div>
      <div><dt>登记的来源链接</dt><dd>{href ? <a href={href} target="_blank" rel="noreferrer">打开登记的来源（新窗口）</a> : item.source_url?.trim() ? '来源链接不符合安全格式，不提供跳转' : '尚未登记来源链接'}</dd></div>
      <div><dt>当前登记状态</dt><dd>{item.status === 'APPROVED' ? '已署名审核（身份未认证）' : '草稿 · 待人工核对'}</dd></div>
    </dl>
  </article>
}

/** Deliberately read-only: comparisons cannot change the editor or approve words. */
export function AnnotationComparisonPanel({ anchor, disabled = false }: { anchor: ComparisonAnchor; disabled?: boolean }) {
  const titleId = useId(), bodyId = useId()
  const identity = anchorKey(anchor)
  const [view, setView] = useState({ identity, open: false, offset: 0, retry: 0 })
  const active = view.identity === identity ? view : { identity, open: false, offset: 0, retry: 0 }
  const readKey = JSON.stringify([identity, active.offset, active.retry])
  const [read, setRead] = useState<{ key: string; data: AnnotationComparison | null; error: string; loading: boolean; conflict: boolean }>({ key: '', data: null, error: '', loading: false, conflict: false })
  const generation = useRef(0), alive = useRef(true)
  const latestKey = useRef(readKey), currentDisabled = useRef(disabled)
  latestKey.current = readKey; currentDisabled.current = disabled
  const conflictIdentity = useRef<string | null>(null)
  const conflict = conflictIdentity.current === identity
  const loading = active.open && (read.key !== readKey || read.loading)
  const data = active.open && read.key === readKey ? read.data : null
  const error = active.open && read.key === readKey ? read.error : ''
  const emptyPage = !!data && data.items.length === 0 && data.offset > 0
  const previousOffset = data ? Math.min(Math.max(0, active.offset - 5), Math.floor(Math.max(0, data.total - 1) / 5) * 5) : 0

  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++ } }, [])
  useEffect(() => {
    if (view.identity !== identity) setView({ identity, open: false, offset: 0, retry: 0 })
  }, [identity, view.identity])
  useEffect(() => {
    if (!active.open || conflictIdentity.current === identity) return
    const controller = new AbortController(), attempt = ++generation.current
    const selectedAnchor = { ...anchor }
    const current = () => alive.current && !controller.signal.aborted && generation.current === attempt && latestKey.current === readKey
    setRead({ key: readKey, data: null, error: '', loading: true, conflict: false })
    readAnnotationComparisons(selectedAnchor, active.offset, controller.signal).then(result => {
      if (!current()) return
      if (anchorKey(result.anchor) !== identity || result.offset !== active.offset || result.limit !== 5) throw new RequestError('INVALID_RESPONSE')
      setRead({ key: readKey, data: result, error: '', loading: false, conflict: false })
    }).catch(reason => {
      if (!current()) return
      const changed = reason instanceof RequestError && reason.status === 409 || reason instanceof Error && reason.message === 'ANNOTATION_VERSION_CONFLICT'
      if (changed) conflictIdentity.current = identity
      setRead({ key: readKey, data: null, error: errorMessage(reason), loading: false, conflict: changed })
    })
    return () => { generation.current++; controller.abort() }
  }, [identity, active.open, readKey])

  const toggle = () => {
    if (active.open) { setView({ ...active, open: false }); return }
    if (currentDisabled.current || conflictIdentity.current === identity) return
    setView({ identity, open: true, offset: 0, retry: active.retry + 1 })
  }
  const move = (offset: number) => {
    if (currentDisabled.current || loading || conflictIdentity.current === identity || !data || offset < 0 || offset !== 0 && offset >= data.total) return
    setView({ ...active, offset })
  }
  const retry = () => {
    if (currentDisabled.current || loading || conflictIdentity.current === identity) return
    setView({ ...active, retry: active.retry + 1 })
  }
  return <section className="annotation-comparison" aria-labelledby={titleId}>
    <header className="annotation-comparison-heading"><div><p className="eyebrow">只读资料对照</p><h3 id={titleId}>把“{anchor.token}”放回其他句子里看。</h3></div>
      <button type="button" className="knowledge-action" aria-expanded={active.open} aria-controls={bodyId} disabled={!active.open && (disabled || conflict)} onClick={toggle}>{active.open ? '收起注释对照' : '展开注释对照'}</button></header>
    <p className="annotation-comparison-boundary">只按义项键或字词登记寻找候选，不认定语义相同，也不认证审核人身份。原典链接不能替代释义出处。这里不会写入、填充或审核当前注释。</p>
    {conflict && <p role="alert" className="comparison-conflict">当前注释版本已变化。请回主编辑器保留或复制草稿，并确认重新读取当前版本后再对照；这里不会自动拉取新版本或丢弃草稿。</p>}
    {active.open && <div id={bodyId} aria-busy={loading} className="annotation-comparison-body">
      <p className="comparison-anchor">当前对照锚点：{anchor.token} · v{anchor.version} · 每页最多 5 条</p>
      {loading ? <p role="status">正在读取此版本的注释对照…</p> : !conflict && error ? <p role="alert">对照暂不可用：{error}。请主动重新读取，不会自动重试。</p> : null}
      {!conflict && data && <>
        <p role="status">{emptyPage ? '本页暂无候选，候选列表可能已变化；请返回第一页或上一页核对当前列表。' : data.total === 0 ? '当前登记中没有其他候选，不表示这个词只有一种用法。' : `共 ${data.total} 条候选 · 第 ${data.offset + 1}–${data.offset + data.items.length} 条`}</p>
        <div className="annotation-comparison-list">{data.items.map(item => <ComparisonEntry key={item.id} item={item} />)}</div>
      </>}
      <div className="annotation-comparison-actions">
        <button type="button" className="knowledge-action" disabled={disabled || loading || conflict} onClick={retry}>重新读取本页对照</button>
        {emptyPage && <button type="button" className="knowledge-action" disabled={disabled || loading || conflict} onClick={() => move(0)}>返回第一页对照</button>}
        <button type="button" className="knowledge-action" disabled={disabled || loading || conflict || !data || data.offset === 0} onClick={() => move(previousOffset)}>上一页对照</button>
        <button type="button" className="knowledge-action" disabled={disabled || loading || conflict || !data || data.offset + 5 >= data.total} onClick={() => move(active.offset + 5)}>下一页对照</button>
      </div>
      {disabled && <p role="status">主编辑器正在操作或核对未确认提交，暂不展开新读取、翻页或重读；已显示内容仍可手动复制。</p>}
    </div>}
  </section>
}
