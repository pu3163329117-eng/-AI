import { useEffect, useState } from 'react'
import { trainingApi } from '../api'
import { errorMessage } from '../http'
import { jumpTo } from '../navigation'
import { annotationSelectionIsCurrent, contextBasisSelectionIsCurrent, basisMatchesGraph, evidencePayload, savedBasis, type AnnotationBasisSelection, type ContextBasisSelection, type EvidenceBasis } from '../evidenceBasis'
import './readerInteraction.css'
import './evidenceBasis.css'
import type { CommandType, ReasoningGraph, ReasoningRecord, TrainingSession } from '../types'

export function ReasoningPath({ graph }: { graph: ReasoningGraph }) {
  return <div className="reasoning-path"><p className="eyebrow">{graph.source} · {graph.stage === 'CORE' ? '核心判断' : '迁移判断'} · {graph.text_version}</p><ol>
    <li><b>目标词</b><p>{graph.target}</p></li>
    <li><b>{graph.basis_kind === 'ANNOTATION' ? '字词注释依据' : '原文证据'}</b><blockquote>{graph.evidence.token}</blockquote><small>第 {graph.evidence.paragraph_index + 1} 段 · 第 {graph.evidence.start + 1}–{graph.evidence.end} 字</small>{graph.basis_kind === 'ANNOTATION' && graph.annotation && <><p>{graph.annotation.meaning}</p><small>保存时注释 v{graph.annotation.version} · {graph.annotation.status === 'DRAFT' ? '整理草稿，待核对' : '已保存署名状态，非教师认证'}</small><p className="knowledge-note">{graph.annotation.citation?.trim() ? `保存时登记的注释出处：${graph.annotation.citation}` : '保存时未提供释义出处，不能视为权威释义。'}</p></>}</li>
    <li><b>我的推断理由（选填）</b><p>{graph.reason || '未补充（选填）'}</p></li>
    <li><b>词义结论</b><p>{graph.conclusion}</p></li>
  </ol><p className="knowledge-note">{graph.evidence_rule_matched ? '依据所在原文包含课程预设线索' : '依据所在原文尚未覆盖课程预设线索'} · {graph.reason ? '理由待人工复核，不代表已验证其推理正确。' : '未补充手写理由，不代表已评估开放推理能力。'}</p></div>
}

export function ReasoningEditor({ session, answer, busy, onCommand, onDirtyChange, sessionId, annotationSelection, contextBasisSelection, onRequestContext, onSubmitDraft, submissionLabel, submissionHint }: {
  session: TrainingSession; answer: string | null; busy: boolean;
  onCommand: (type: CommandType, payload?: Record<string, unknown>) => void; onDirtyChange: (dirty: boolean) => void
  sessionId?: string; annotationSelection?: AnnotationBasisSelection | null
  contextBasisSelection?: ContextBasisSelection | null; onRequestContext?: () => void
  onSubmitDraft?: (payload: Record<string, unknown>) => void
  submissionLabel?: string; submissionHint?: string
}) {
  const graph = session.reasoning_graph
  const [basis, setBasis] = useState<EvidenceBasis | null>(() => savedBasis(graph, sessionId ?? ''))
  const [reason, setReason] = useState(graph?.reason ?? '')
  const dirty = !!(reason || basis) && (!graph || graph.reason !== reason.trim() || graph.conclusion !== answer || !basisMatchesGraph(basis, graph))
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  const frozen = session.transfer_ready || session.summary_ready || session.completed
  useEffect(() => {
    if (!busy && !frozen && !session.completed && annotationSelectionIsCurrent(annotationSelection, sessionId, session.stage)) setBasis({ kind: 'ANNOTATION', annotation: annotationSelection })
  }, [annotationSelection, sessionId, session.stage])
  useEffect(() => {
    if (!busy && !frozen && contextBasisSelectionIsCurrent(contextBasisSelection, sessionId, session.stage)) setBasis({ kind: 'CONTEXT', evidence: contextBasisSelection.selection })
  }, [contextBasisSelection, sessionId, session.stage])
  const selection = session.context_selection
  const chosenPosition = basis?.kind === 'CONTEXT' ? basis.evidence : basis?.annotation
  const reasonLength = Array.from(reason.trim()).length
  const saveHint = busy ? '正在处理当前操作，请稍候。'
    : frozen ? '本阶段已提交，证据与理由仅供回看。'
    : !basis ? '先从原文选择一段，或在字词资料中选择一条注释作为依据。'
    : !answer ? '请先回到题目选择一个词义结论。'
    : reasonLength > 2000 ? '理由最多 2000 字，请精简后再保存。'
    : !dirty ? onSubmitDraft ? '依据已保存，可以核验并继续；不会重复保存相同依据。' : '证据与理由已保存；修改后可以再次保存。'
    : '依据和结论已齐全，可以保存；手写理由选填。'
  return <section className="reasoning-editor" aria-labelledby="reasoning-title">
    <h2 id="reasoning-title" tabIndex={-1}>选一条依据，支持你的判断。</h2>
    <p>可用原文或已有注释作为依据；点读不会自动保存。</p>
    <fieldset disabled={busy || frozen || session.completed}><legend>选择依据 · 理由选填</legend>
      <div className="evidence-capture"><button type="button" className="knowledge-action" disabled={!selection} onClick={() => { if (!busy && !frozen && !session.completed && selection) setBasis({ kind: 'CONTEXT', evidence: selection }) }}>将当前原文选段记为证据</button><button type="button" className="knowledge-action" onClick={() => { if (!busy && !frozen) { if (onRequestContext) onRequestContext(); else jumpTo('fulltext-title') } }}>返回原文选择证据或注释</button></div>
      {basis ? <div className="chosen-evidence"><p className="eyebrow">{basis.kind === 'CONTEXT' ? '已选原文上下文' : '已选字词注释'}</p><blockquote>{basis.kind === 'CONTEXT' ? basis.evidence.token : basis.annotation.token}</blockquote>{chosenPosition && <small>第 {chosenPosition.paragraph_index + 1} 段 · 第 {chosenPosition.start + 1}–{chosenPosition.end} 字</small>}{basis.kind === 'ANNOTATION' && <><p>{basis.annotation.meaning}</p><p className="knowledge-note">注释 v{basis.annotation.annotation_version} · {basis.annotation.status === 'DRAFT' ? '整理草稿，待核对；不是正确性证明。' : '已保存署名状态，不等于教师认证。'}</p></>}</div> : <p className="knowledge-note">尚未选择依据。可用“选择任意词组”定位同段最多 80 字，或展开字词解释选择已有注释。</p>}
      <details className="optional-reason"><summary>补充我的推断理由（选填）{reason && <span> · 已填写 {reasonLength} 字</span>}</summary>
      <label>我的推断理由（选填）<textarea value={reason} aria-describedby="reasoning-length reasoning-save-hint" onChange={event => { if (!busy && !frozen && !session.completed) setReason(event.target.value) }} placeholder="可以不填。也可以用自己的话说明，这条依据为什么支持你的判断。" /></label>
      <p id="reasoning-length" className="reasoning-length">{reasonLength} / 2000 字 · 可以留空，收起不会清除内容</p></details>
      <p>当前词义结论：{answer ?? '请先在上方选择词义'}</p>
      <p id="reasoning-save-hint" className="reasoning-save-hint" role="status">{submissionHint ?? saveHint}</p>
      {!(onSubmitDraft && frozen) && <div className={onSubmitDraft ? 'guided-task-primary' : undefined}><button type="button" className={`button ${onSubmitDraft ? 'button-primary' : 'button-secondary'}`} aria-describedby="reasoning-save-hint" disabled={busy || frozen || session.completed || !basis || !answer || reasonLength > 2000 || (!onSubmitDraft && !dirty)} onClick={() => {
        if (busy || frozen || session.completed || !basis || !answer || reasonLength > 2000) return
        const payload = evidencePayload(basis, reason, answer)
        if (onSubmitDraft) onSubmitDraft(payload)
        else if (dirty) onCommand('SAVE_REASONING', payload)
      }}>{onSubmitDraft ? submissionLabel ?? '提交本题并继续' : '保存依据与结论'}</button></div>}
    </fieldset>
    {!graph && dirty && <p className="knowledge-note" role="status">当前证据与理由尚未保存；保存成功后才能刷新恢复。</p>}
    {graph && <><p role="status">{dirty ? '有未保存改动，请保存后提交判断。' : '证据链已保存，可刷新恢复。'}</p><details><summary>查看已保存的证据链</summary><ReasoningPath graph={graph} /></details></>}
    <p className="knowledge-note">训练规则只核验选项和预设证据覆盖，不证明开放理由正确。下方模型反馈仅供试用、待审核；保存证据链不发积分。</p>
  </section>
}

export function ReasoningHistory({ sessionId, version }: { sessionId: string; version: number }) {
  const [open, setOpen] = useState(false)
  const [retry, setRetry] = useState(0)
  const [read, setRead] = useState<{ key: string; records: ReasoningRecord[] | null; error: string; loading: boolean }>({ key: '', records: null, error: '', loading: false })
  const readKey = JSON.stringify([sessionId, version, retry])
  // Hide a previous session/revision synchronously, before effects can run.
  const records = read.key === readKey ? read.records : null
  const error = read.key === readKey ? read.error : ''
  const loading = open && (read.key !== readKey || read.loading)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setRead({ key: readKey, records: null, error: '', loading: true })
    trainingApi.reasoning(sessionId, controller.signal).then(data => { if (!controller.signal.aborted) setRead({ key: readKey, records: data.records, error: '', loading: false }) })
      .catch(reason => { if (!controller.signal.aborted) setRead({ key: readKey, records: null, error: errorMessage(reason), loading: false }) })
    return () => controller.abort()
  }, [open, sessionId, readKey])
  return <details className="reasoning-history" onToggle={event => setOpen(event.currentTarget.open)}><summary>回看本次训练的证据与理由</summary>
    {loading ? <p role="status">正在读取推理记录…</p> : error ? <p role="alert">{error}<button className="knowledge-action" onClick={() => setRetry(value => value + 1)}>重试记录</button></p> : records && (records.length ? records.map(record => <article key={record.sequence_no}><p>记录 #{record.sequence_no} · {new Date(record.created_at).toLocaleString('zh-CN')}</p><ReasoningPath graph={record.graph} /></article>) : <p>这份历史训练尚未保存开放理由。保留旧记录，不补写或伪造推理路径。</p>)}
  </details>
}
