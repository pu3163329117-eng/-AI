import { useEffect, useId, useRef, useState } from 'react'
import type { KnowledgeEvidence } from '../knowledgeEvidence'
import { readKnowledgeEvidence } from '../knowledgeEvidenceApi'
import { errorMessage } from '../http'
import './knowledgeEvidence.css'

type Document = { id: string; source: string }
type Read = { identity: string; data: KnowledgeEvidence | null; loading: boolean; error: string; notice: string; all: boolean }
const empty = (identity: string): Read => ({ identity, data: null, loading: false, error: '', notice: '', all: false })
function message(error: unknown) {
  if (error instanceof Error && error.message === 'EVIDENCE_TOO_LARGE') return '证据候选超过读取上限，本次不展示；请联系维护者。'
  if (error instanceof Error && error.message === 'EVIDENCE_INVALID_REQUEST') return '材料标识不符合读取要求，请重新选择原文。'
  return errorMessage(error)
}
/** Advisory original-text evidence only; never updates annotations or drafts. */
export function KnowledgeEvidencePanel({ document, disabled, refreshKey }: { document: Document | null; disabled: boolean; refreshKey: number }) {
  const titleId = useId(), helpId = useId()
  const identity = JSON.stringify([document?.id ?? null, document?.source ?? null, refreshKey])
  const [read, setRead] = useState<Read>(() => empty(identity))
  const latest = useRef({ identity, document, disabled })
  latest.current = { identity, document, disabled }
  const op = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null })
  const alive = useRef(true)
  const active = read.identity === identity && !disabled ? read : empty(identity)
  useEffect(() => { alive.current = true; return () => { alive.current = false; op.current.generation++; op.current.controller?.abort(); op.current.controller = null } }, [])
  useEffect(() => {
    op.current.generation++; op.current.controller?.abort(); op.current.controller = null
    setRead(empty(identity))
    return () => { op.current.generation++; op.current.controller?.abort(); op.current.controller = null }
  }, [identity, disabled])
  async function load(all: boolean) {
    const selected = latest.current
    if (!alive.current || selected.identity !== identity || selected.disabled || (!all && !selected.document) || op.current.controller) return
    const controller = new AbortController(), generation = ++op.current.generation
    op.current.controller = controller
    const current = () => alive.current && !controller.signal.aborted && op.current.generation === generation && latest.current.identity === selected.identity && !latest.current.disabled
    setRead({ ...empty(identity), loading: true, all })
    try {
      const data = await readKnowledgeEvidence(all ? null : selected.document!.id, controller.signal)
      if (current()) setRead({ ...empty(identity), data, all })
    } catch (error) { if (current()) setRead({ ...empty(identity), error: message(error), all }) }
    finally { if (current()) op.current.controller = null }
  }
  function cancel() {
    if (!op.current.controller) return
    op.current.generation++; op.current.controller.abort(); op.current.controller = null
    if (alive.current) setRead({ ...empty(latest.current.identity), notice: '已取消读取，编辑草稿保持不变。' })
  }
  return <section className="knowledge-evidence" aria-labelledby={titleId} aria-busy={active.loading}>
    <header><p className="eyebrow">原典案头 · 候选证据</p><h2 id={titleId}>先辨出处，再核释义。</h2></header>
    <p id={helpId}>当前材料：{document?.source ?? '尚未选择'}。仅显式读取已核对的八词、十六处原典语境，不自动填入编辑器、不修改注释或完成审核。</p>
    <p className="evidence-boundary">原典转写不是权威辞书释义。此批释义出处仍未提供；同字关联不代表同义，绑定可用不代表语义审定。</p>
    <div className="evidence-actions"><button type="button" className="knowledge-action" disabled={disabled || !document || active.loading} aria-describedby={helpId} onClick={() => void load(false)}>读取当前篇原典证据候选</button><button type="button" className="knowledge-action" disabled={disabled || active.loading} onClick={() => void load(true)}>读取八词全部候选</button></div>
    {disabled && <p role="status">请先处理未保存草稿、进行中的操作或未确认的提交；旧证据已失效，暂停新读取。</p>}
    {active.loading && <div className="evidence-actions"><p role="status">正在读取{active.all ? '八词全部' : '当前篇'}原典候选…</p><button type="button" className="knowledge-action" onClick={cancel}>取消证据读取</button></div>}
    {active.error && <p role="alert">证据暂不可用：{active.error} 不会自动重试。</p>}
    {active.notice && <p role="status">{active.notice}</p>}
    {active.data && <div className="evidence-results"><p role="status">{active.all ? '八词范围' : '当前篇范围'}：{active.data.summary.targets} 个字 · {active.data.summary.candidates} 处候选 · {active.data.summary.available} 处版本绑定可用 · {active.data.summary.unavailable} 处绑定不可用 · 释义出处 {active.data.summary.interpretation_sources} · 写入 {active.data.summary.applied}</p>
      {active.data.items.length === 0 && <p>此篇没有列入本批八词候选，不表示原文没有可补充的知识。</p>}
      {active.data.items.map(item => <details key={item.id}><summary>“{item.token}” · {item.source} · {item.availability === 'AVAILABLE' ? '绑定可用' : '绑定不可用，需核对'} · 原典候选</summary><div className="evidence-detail">
        <p>第 {item.paragraph_index + 1} 段 · 第 {item.start + 1}–{item.end} 字 · {item.extent === 'FULL' ? '全文' : item.extent === 'CHAPTER' ? '完整章' : '连续节选'}</p><blockquote>{item.sentence}</blockquote>
        <p>现有义项标签：{item.sense_key}；仅定位，不证明释义正确。已保存状态：{item.annotation_status === null ? '无法绑定' : item.annotation_status === 'APPROVED' ? 'APPROVED（已保存状态，非教师认证）' : '草稿待核对'}{item.annotation_version !== null ? ` · v${item.annotation_version}` : ''}。</p>
        <h3>{item.source_title}</h3><p>{item.source_locator}</p><blockquote>{item.source_quote}</blockquote>
        <p>原典链接：<a href={item.source_url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{item.source_url}</a></p>
        <p>核对日期：{item.source_checked_on}；释义出处：尚未提供。</p><p>版本与范围：{item.version_note}</p><p>本地原文版本：{item.text_version}</p>
        <p>同字跨篇候选：{item.related_ids.length} 处；仅为关联线索，需分别核对语义，不自动合并。</p>
      </div></details>)}
    </div>}
  </section>
}
