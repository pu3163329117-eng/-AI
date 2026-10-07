import { useEffect, useState } from 'react'
import { trainingApi } from '../api'
import { errorMessage } from '../http'
import { jumpTo } from '../navigation'
import type { CommandType, ContextSelection, ReasoningGraph, ReasoningRecord, TrainingSession } from '../types'

export function ReasoningPath({ graph }: { graph: ReasoningGraph }) {
  return <div className="reasoning-path"><p className="eyebrow">{graph.source} · {graph.stage === 'CORE' ? '核心判断' : '迁移判断'} · {graph.text_version}</p><ol>
    <li><b>目标词</b><p>{graph.target}</p></li>
    <li><b>原文证据</b><blockquote>{graph.evidence.token}</blockquote><small>第 {graph.evidence.paragraph_index + 1} 段 · 第 {graph.evidence.start + 1}–{graph.evidence.end} 字</small></li>
    <li><b>我的推断理由</b><p>{graph.reason}</p></li>
    <li><b>词义结论</b><p>{graph.conclusion}</p></li>
  </ol><p className="knowledge-note">{graph.evidence_rule_matched ? '原文包含课程预设线索' : '原文尚未覆盖课程预设线索'} · 理由待人工复核，不代表已验证其推理正确。</p></div>
}

export function ReasoningEditor({ session, answer, busy, onCommand, onDirtyChange }: {
  session: TrainingSession; answer: string | null; busy: boolean;
  onCommand: (type: CommandType, payload?: Record<string, unknown>) => void; onDirtyChange: (dirty: boolean) => void
}) {
  const graph = session.reasoning_graph
  const [evidence, setEvidence] = useState<ContextSelection | null>(graph?.evidence ?? null)
  const [reason, setReason] = useState(graph?.reason ?? '')
  const dirty = !!(reason || evidence) && (!graph || graph.reason !== reason.trim() || graph.conclusion !== answer ||
    graph.evidence.paragraph_index !== evidence?.paragraph_index || graph.evidence.start !== evidence?.start || graph.evidence.end !== evidence?.end)
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  const frozen = session.transfer_ready || session.summary_ready
  const selection = session.context_selection
  return <section className="reasoning-editor" aria-labelledby="reasoning-title">
    <h2 id="reasoning-title">把判断的依据写下来。</h2>
    <p>在下方原文选择证据的起止字，再回到这里；点读语境不会自动记为证据。</p>
    <fieldset disabled={busy || frozen}><legend>原文证据 → 推断理由 → 词义结论</legend>
      <div className="evidence-capture"><button type="button" className="knowledge-action" disabled={!selection} onClick={() => setEvidence(selection ?? null)}>将当前原文选段记为证据</button><button type="button" className="knowledge-action" onClick={() => jumpTo('fulltext-title')}>去原文选择证据 ↓</button></div>
      {evidence ? <blockquote>{evidence.token}<small>第 {evidence.paragraph_index + 1} 段 · 第 {evidence.start + 1}–{evidence.end} 字</small></blockquote> : <p className="knowledge-note">尚未选择证据。可用“选择任意词组”定位同段最多 80 字。</p>}
      <label>我的推断理由<textarea maxLength={2000} minLength={5} value={reason} onChange={event => setReason(event.target.value)} placeholder="这段原文中的哪些关系，支持你所选的词义？至少写 5 个字。" /></label>
      <p>当前词义结论：{answer ?? '请先在上方选择词义'}</p>
      <button type="button" className="button button-secondary" disabled={!evidence || !answer || Array.from(reason.trim()).length < 5 || !dirty} onClick={() => evidence && answer && onCommand('SAVE_REASONING', { paragraph_index: evidence.paragraph_index, start: evidence.start, end: evidence.end, reason: reason.trim(), conclusion: answer })}>保存证据与理由</button>
    </fieldset>
    {graph && <><p role="status">{dirty ? '有未保存改动，请保存后提交判断。' : '证据链已保存，可刷新恢复。'}</p><details><summary>查看已保存的证据链</summary><ReasoningPath graph={graph} /></details></>}
    <p className="knowledge-note">系统只核验选项和预设证据覆盖，不对开放理由作语义评分。保存证据链不发积分。</p>
  </section>
}

export function ReasoningHistory({ sessionId, version }: { sessionId: string; version: number }) {
  const [open, setOpen] = useState(false)
  const [records, setRecords] = useState<ReasoningRecord[] | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController(); setLoading(true); setError('')
    trainingApi.reasoning(sessionId, controller.signal).then(data => { if (!controller.signal.aborted) { setRecords(data.records); setLoading(false) } })
      .catch(reason => { if (!controller.signal.aborted) { setError(errorMessage(reason)); setLoading(false) } })
    return () => controller.abort()
  }, [open, sessionId, version, retry])
  return <details className="reasoning-history" onToggle={event => setOpen(event.currentTarget.open)}><summary>回看本次训练的证据与理由</summary>
    {loading ? <p role="status">正在读取推理记录…</p> : error ? <p role="alert">{error}<button className="knowledge-action" onClick={() => setRetry(value => value + 1)}>重试记录</button></p> : records && (records.length ? records.map(record => <article key={record.sequence_no}><p>记录 #{record.sequence_no} · {new Date(record.created_at).toLocaleString('zh-CN')}</p><ReasoningPath graph={record.graph} /></article>) : <p>这份历史训练尚未保存开放理由。保留旧记录，不补写或伪造推理路径。</p>)}
  </details>
}
