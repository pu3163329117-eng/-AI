import { useEffect, useId, useRef, useState } from 'react'
import { downloadAnnotationPacket, packetFieldBlank, type AnnotationPacket } from '../annotationPacket'
import { readAnnotationPacket } from '../annotationPacketApi'
import { errorMessage } from '../http'
import './annotationPacket.css'

type PacketDocument = { id: string; source: string }
type PacketRead = { identity: string; data: AnnotationPacket | null; loading: boolean; error: string; notice: string }
const emptyRead = (identity: string): PacketRead => ({ identity, data: null, loading: false, error: '', notice: '' })
const extentNames = { FULL: '全文', CHAPTER: '完整章', EXCERPT: '连续节选', PROMPT: '题干材料' }
function packetError(reason: unknown) {
  const messages: Record<string, string> = {
    ANNOTATION_PACKET_TOO_LARGE: '单篇资料超过 2000 条或 8 MiB 限制，本次不展示或下载；请联系维护者核对。',
    ANNOTATION_PACKET_UNAVAILABLE: '该篇资料当前不可用，请核对所选材料后再主动读取。',
    ANNOTATION_PACKET_INVALID_DATA: '已保存资料存在结构或定位问题，本次不展示或下载；请联系维护者核对。',
    ANNOTATION_PACKET_INVALID_REQUEST: '材料标识不符合读取要求，请重新选择已入库原文。',
  }
  return reason instanceof Error && messages[reason.message] || errorMessage(reason)
}

/** Explicit read, then explicit download. Never edits the workbench or persists its draft. */
export function AnnotationPacketPanel({ document, disabled, refreshKey }: { document: PacketDocument | null; disabled: boolean; refreshKey: number }) {
  const titleId = useId(), helpId = useId()
  const identity = JSON.stringify([document?.id ?? null, document?.source ?? null, refreshKey])
  const [read, setRead] = useState<PacketRead>(() => emptyRead(identity))
  const latest = useRef({ identity, disabled, document })
  latest.current = { identity, disabled, document }
  const operation = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null })
  const alive = useRef(true)
  const active = read.identity === identity && !disabled ? read : emptyRead(identity)
  const latestSnapshot = useRef(active.data)
  latestSnapshot.current = active.data

  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current.generation++; operation.current.controller?.abort(); operation.current.controller = null } }, [])
  useEffect(() => {
    operation.current.generation++; operation.current.controller?.abort(); operation.current.controller = null
    setRead(emptyRead(identity))
    return () => { operation.current.generation++; operation.current.controller?.abort(); operation.current.controller = null }
  }, [identity, disabled])

  async function load() {
    const selected = latest.current
    if (!alive.current || selected.disabled || !selected.document || selected.identity !== identity || operation.current.controller) return
    const controller = new AbortController(), generation = ++operation.current.generation
    operation.current.controller = controller
    const current = () => alive.current && !controller.signal.aborted && operation.current.generation === generation && latest.current.identity === selected.identity && !latest.current.disabled
    setRead({ ...emptyRead(identity), loading: true })
    try {
      const data = await readAnnotationPacket(selected.document.id, controller.signal)
      if (!current()) return
      if (data.document.id !== selected.document.id) throw new Error('INVALID_RESPONSE')
      setRead({ ...emptyRead(identity), data })
    } catch (reason) {
      if (current()) setRead({ ...emptyRead(identity), error: packetError(reason) })
    } finally { if (current()) operation.current.controller = null }
  }
  function cancel() {
    if (!operation.current.controller) return
    operation.current.generation++; operation.current.controller.abort(); operation.current.controller = null
    if (alive.current) setRead({ ...emptyRead(latest.current.identity), notice: '读取已取消，未下载文件；编辑草稿保持不变。' })
  }
  function download() {
    if (!alive.current || latest.current.disabled || latest.current.identity !== identity || operation.current.controller || !active.data || latestSnapshot.current !== active.data) return
    try {
      downloadAnnotationPacket(active.data)
      setRead({ ...active, notice: '已发起本机 JSON 下载。文件是刚才读取的已保存快照，不保证反映后续修订；转交前请检查内容。', error: '' })
    } catch (reason) { setRead({ ...active, error: packetError(reason), notice: '' }) }
  }

  return <section className="annotation-packet" aria-labelledby={titleId} aria-busy={active.loading}>
    <header><div><p className="eyebrow">只读资料 · 单篇审校</p><h2 id={titleId}>把一篇注释带到案头核对。</h2></div>
      <button type="button" className="knowledge-action" disabled={disabled || !document || active.loading} aria-describedby={helpId} onClick={() => void load()}>{active.data ? '重新读取单篇审校资料' : '读取单篇审校资料'}</button></header>
    <p id={helpId}>当前材料：{document?.source ?? '尚未选择原文'}。不会自动读取整篇或下载，不包含未保存草稿、署名历史或学习记录；读取和下载均不修改注释。</p>
    <p className="packet-boundary">释义与登记状态只供人工核对，不证明语义正确或教师身份。原典链接不能替代释义出处。缺出处与缺链接可能重叠，“任一缺口”按注释去重，不能直接相加。</p>
    {disabled && <p role="status">当前有未保存草稿、进行中的操作或结果未确认的提交。请先处理主编辑器；新读取与下载暂停，旧资料包已失效。</p>}
    {active.loading && <div className="packet-actions"><p role="status">正在读取当前篇已保存的审校快照，尚未下载…</p><button type="button" className="knowledge-action" onClick={cancel}>取消资料包读取</button></div>}
    {active.error && <p role="alert">资料包暂不可用：{active.error} 可主动重新读取，不会自动重试或下载。</p>}
    {active.notice && <p role="status">{active.notice}</p>}
    {active.data && <div className="packet-preview">
      <h3>{active.data.document.source} · {extentNames[active.data.document.extent]}</h3>
      <p>{active.data.document.author} · {active.data.document.era} · 原文版本：{active.data.document.text_version}</p>
      <p>{active.data.document.work_note}</p>
      <p>范围：{active.data.document.paragraphs.length} 段已登记原文；{active.data.document.extent === 'EXCERPT' || active.data.document.extent === 'PROMPT' ? '本材料不是整篇全文。' : '只对本资料声明的材料范围负责。'}</p>
      <dl className="packet-counts">{([
        ['annotations', '注释条目'], ['draft', '草稿待核对'], ['approved', '已署名（身份未认证）'], ['missing_citation', '缺注释出处'], ['missing_source_url', '缺来源链接'], ['missing_either', '任一缺口（去重）'],
      ] as const).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{active.data!.summary[key]}</dd></div>)}</dl>
      {active.data.items.length === 0 ? <p>该篇当前没有已保存注释，不表示审校已完成。</p> : <details className="packet-samples"><summary>预览前 {Math.min(3, active.data.items.length)} 条注释</summary><p>仅预览前三条；完整定位、原文与全部注释包含在 JSON 中，不自动填入编辑器。</p>{active.data.items.slice(0, 3).map(item => <article key={item.id}><h4>“{item.token}” · 第 {item.paragraph_index + 1} 段 · 第 {item.start + 1}–{item.end} 字 · v{item.version}</h4><blockquote>{item.sentence}</blockquote><p>本句释义：{item.meaning}</p><p>词性：{item.part_of_speech} · {item.variability === 'CONTEXTUAL' ? '变量 · 随语境推断' : '无变量 · 本句相对确定'}</p><p>语境依据：{item.reasoning}</p><p>注释出处：{packetFieldBlank(item.citation) ? '尚未登记' : item.citation}</p><p>来源链接：{packetFieldBlank(item.source_url) ? '尚未登记' : item.source_url}</p><p>{item.status === 'APPROVED' ? '已署名审核（身份未认证）' : '草稿 · 待人工核对'}</p></article>)}</details>}
      <p className="packet-digest">快照 SHA-256：<code>{active.data.snapshot_sha256}</code></p>
      <div className="packet-actions"><button type="button" className="knowledge-action" disabled={disabled || active.loading} onClick={download}>下载已读取的审校资料 JSON</button></div>
      <p>仅下载此刻页面持有的已保存快照；不认证署名、不完成审核、不发布，也不自动发送给外部服务。</p>
    </div>}
  </section>
}
