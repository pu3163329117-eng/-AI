import { useEffect, useId, useRef, useState } from 'react'
import { readAnnotationQuality } from '../annotationQualityApi'
import { errorMessage } from '../http'
import type { AnnotationQuality } from '../annotationQuality'
import './annotationQuality.css'

export function AnnotationQualityPanel({ refreshKey, onChooseDocument, onChooseGap, disabled = false }: {
  refreshKey: number; onChooseDocument: (id: string) => void; onChooseGap?: (id: string, gap: 'MISSING_CITATION' | 'MISSING_SOURCE_URL') => void; disabled?: boolean
}) {
  const titleId = useId()
  const [data, setData] = useState<AnnotationQuality | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)
  useEffect(() => {
    const controller = new AbortController(), current = ++generation.current
    setLoading(true); setError(''); setData(null)
    readAnnotationQuality(controller.signal).then(result => {
      if (!controller.signal.aborted && generation.current === current) setData(result)
    }).catch(reason => {
      if (!controller.signal.aborted && generation.current === current) setError(errorMessage(reason))
    }).finally(() => {
      if (!controller.signal.aborted && generation.current === current) setLoading(false)
    })
    return () => { generation.current++; controller.abort() }
  }, [refreshKey, retry])

  return <section className="annotation-quality" aria-labelledby={titleId} aria-busy={loading}>
    <header><div><p className="eyebrow">当前材料 · 字词审核待办</p><h2 id={titleId}>先补出处，再逐条核对。</h2></div>
      <button type="button" className="knowledge-action" disabled={disabled || loading} onClick={() => { if (!disabled && !loading) setRetry(value => value + 1) }}>刷新概览</button></header>
    <p className="quality-boundary">这里只统计当前材料版本的登记与署名状态，不评判注释真伪，也不认证审核人身份。已有链接可能仅指向原典，不能替代释义出处。缺出处与缺链接可能是同一条注释，不能相加当作条目总数。</p>
    {loading ? <p role="status">正在读取当前版本的审核待办…</p> : error ? <p role="alert">概览暂不可用：{error}。可用上方按钮重新读取，原编辑内容不会被更改。</p>
      : data && data.documents.length === 0 ? <p className="quality-empty">当前还没有已入库的材料版本。没有数据不表示已经完成审核。</p>
      : data && <>
        <dl className="quality-totals">
          <div><dt>注释条目</dt><dd>{data.totals.annotations}</dd></div>
          <div><dt>待人工核对</dt><dd>{data.totals.draft}</dd></div>
          <div><dt>已署名审核</dt><dd>{data.totals.approved}</dd></div>
          <div><dt>未登记注释出处</dt><dd>{data.totals.missing_citation}</dd></div>
          <div><dt>未登记来源链接</dt><dd>{data.totals.missing_source_url}</dd></div>
        </dl>
        <p className="quality-table-hint">可左右滑动表格，或用键盘聚焦后滚动。查看待审只筛待审条目；点击缺口数量则定位该篇全部登记状态中的对应缺失项，已署名条目也可能缺资料。</p>
        <div className="quality-table-scroll" role="region" aria-label="按篇审核待办表格，可横向滚动" tabIndex={0}>
          <table><caption>当前已入库材料 · {data.totals.documents} 篇</caption><thead><tr><th scope="col">材料</th><th scope="col">注释条目</th><th scope="col">待核对</th><th scope="col">已署名</th><th scope="col">缺注释出处</th><th scope="col">缺来源链接</th><th scope="col">下一步</th></tr></thead>
            <tbody>{data.documents.map(item => <tr key={item.id}><th scope="row">{item.source}</th><td>{item.annotations}</td><td>{item.draft}</td><td>{item.approved}</td>
              <td>{onChooseGap ? <button type="button" className="knowledge-action quality-gap-action" disabled={disabled || item.missing_citation === 0} aria-label={`查看${item.source}缺注释出处的${item.missing_citation}条注释`} onClick={() => { if (!disabled && item.missing_citation > 0) onChooseGap(item.id, 'MISSING_CITATION') }}>{item.missing_citation} 条 · 定位</button> : item.missing_citation}</td>
              <td>{onChooseGap ? <button type="button" className="knowledge-action quality-gap-action" disabled={disabled || item.missing_source_url === 0} aria-label={`查看${item.source}缺来源链接的${item.missing_source_url}条注释`} onClick={() => { if (!disabled && item.missing_source_url > 0) onChooseGap(item.id, 'MISSING_SOURCE_URL') }}>{item.missing_source_url} 条 · 定位</button> : item.missing_source_url}</td>
              <td><button type="button" className="knowledge-action" disabled={disabled || item.draft === 0} aria-label={`查看${item.source}的待审注释`} onClick={() => { if (!disabled && item.draft > 0) onChooseDocument(item.id) }}>查看待审</button></td></tr>)}</tbody>
          </table>
        </div>
      </>}
  </section>
}
