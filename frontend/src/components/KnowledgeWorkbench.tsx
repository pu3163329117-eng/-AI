import { useCallback, useEffect, useRef, useState } from 'react'
import { annotationApi, knowledgeApi } from '../api'
import { errorMessage, uncertainWrite } from '../http'
import type { AnnotationDetail, AnnotationFields, KnowledgeDocument, ManagedAnnotation } from '../types'
import type { ExitRisk } from '../usePageRoute'
import { useConfirmationDialog } from './ConfirmationDialog'
import { AnnotationQualityPanel } from './AnnotationQualityPanel'
import { AnnotationComparisonPanel } from './AnnotationComparisonPanel'
import { AnnotationPacketPanel } from './AnnotationPacketPanel'
import { KnowledgeEvidencePanel } from './KnowledgeEvidencePanel'
import './knowledgeWorkbench.css'

const fieldsFor = (item: ManagedAnnotation): AnnotationFields => ({ meaning: item.meaning, part_of_speech: item.part_of_speech,
  variability: item.variability, reasoning: item.reasoning, source_url: item.source_url ?? '', citation: item.citation })
const submittedFields = (fields: AnnotationFields): AnnotationFields => ({ ...fields, meaning: fields.meaning.trim(), part_of_speech: fields.part_of_speech.trim(), reasoning: fields.reasoning.trim(), source_url: fields.source_url.trim() })
type Submission = { id: string; version: number; action: 'EDIT' | 'REVIEW'; fields: AnnotationFields; actor: string; note: string }
type AnnotationGap = 'ALL' | 'MISSING_CITATION' | 'MISSING_SOURCE_URL' | 'MISSING_EITHER'
const sameFields = (first: AnnotationFields, second: AnnotationFields) => JSON.stringify(first) === JSON.stringify(second)
const hasReceipt = (data: AnnotationDetail, submission: Submission) => data.annotation.version >= submission.version + 1 && data.history.some(item => item.version === submission.version + 1 && item.action === submission.action && item.actor === submission.actor && item.note === submission.note && sameFields(fieldsFor({ ...data.annotation, ...item.payload }), submission.fields))

export function KnowledgeWorkbench({ onExitRiskChange }: { onExitRiskChange: (risk: ExitRisk) => void }) {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [document, setDocument] = useState('')
  const [status, setStatus] = useState('ALL')
  const [gap, setGap] = useState<AnnotationGap>('ALL')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [list, setList] = useState<{ total: number; items: ManagedAnnotation[] } | null>(null)
  const [detail, setDetail] = useState<AnnotationDetail | null>(null)
  const [fields, setFields] = useState<AnnotationFields | null>(null)
  const [actor, setActor] = useState('')
  const [actorDirty, setActorDirty] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [listError, setListError] = useState('')
  const [notice, setNotice] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [retry, setRetry] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const queueTarget = useRef<HTMLElement | null>(null)
  const [queueFocusRequest, setQueueFocusRequest] = useState(0)
  const lock = useRef(false)
  const alive = useRef(true)
  const reads = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null })
  const queueGeneration = useRef(0)
  const pending = useRef<Submission | null>(null)
  const confirmation = useConfirmationDialog('knowledge-workbench')
  const fieldsDirty = !!detail && !!fields && JSON.stringify(fields) !== JSON.stringify(fieldsFor(detail.annotation))
  const dirty = fieldsDirty || !!note || actorDirty
  const state = useRef({ busy, uncertain, dirty })
  state.current = { busy, uncertain, dirty }
  const reviewIdentity = useRef('')
  reviewIdentity.current = JSON.stringify([detail?.annotation.id, detail?.annotation.version, fields, actor, note])
  useEffect(() => { alive.current = true; return () => { alive.current = false; queueGeneration.current++; reads.current.generation++; reads.current.controller?.abort() } }, [])
  useEffect(() => { onExitRiskChange(busy ? 'working' : uncertain ? 'uncertain' : dirty ? 'dirty' : null) }, [busy, uncertain, dirty, onExitRiskChange])
  useEffect(() => () => onExitRiskChange(null), [onExitRiskChange])
  useEffect(() => {
    if (!queueFocusRequest || !alive.current) return
    queueTarget.current?.focus({ preventScroll: true })
    queueTarget.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }, [queueFocusRequest])
  useEffect(() => {
    const controller = new AbortController()
    knowledgeApi.coverage(controller.signal).then(data => {
      if (!controller.signal.aborted) { setDocuments(data.documents); setDocument(current => current || data.documents[0]?.id || ''); if (!data.documents.length) setLoading(false) }
    }).catch(reason => { if (!controller.signal.aborted) { setListError(errorMessage(reason)); setLoading(false) } })
    return () => controller.abort()
  }, [retry, refresh])
  useEffect(() => {
    if (!document) return
    const controller = new AbortController(), generation = ++queueGeneration.current
    const current = () => alive.current && !controller.signal.aborted && generation === queueGeneration.current
    setLoading(true); setList(null); setListError('')
    annotationApi.list(document, status, search, offset, controller.signal, gap).then(data => {
      if (current()) { setList(data); setLoading(false) }
    }).catch(reason => { if (current()) { setListError(errorMessage(reason)); setLoading(false) } })
    return () => { queueGeneration.current++; controller.abort() }
  }, [document, status, gap, search, offset, retry, refresh])
  const guard = (action: () => void) => {
    if (lock.current || state.current.busy) { setNotice('请等待当前操作完成，或取消当前读取。'); return }
    if (state.current.uncertain) { setNotice('上次写入结果未确认。请先核对当前字词，不能切换或丢弃这份草稿。'); return }
    const run = () => { if (alive.current && !lock.current && !state.current.busy && !state.current.uncertain) action() }
    if (!state.current.dirty) { run(); return }
    confirmation.ask({ title: '放弃当前注释草稿？', message: '字词字段或本次说明尚未保存。请先复制需要保留的内容；确认后才会切换或重新读取。', confirmLabel: '放弃草稿并继续', onConfirm: run })
  }
  const clearEditor = () => { reads.current.generation++; reads.current.controller?.abort(); setDetail(null); setFields(null); setNote(''); setActorDirty(false); setError(''); setNotice(''); state.current.dirty = false; onExitRiskChange(null) }
  const filter = (action: () => void) => guard(() => { queueGeneration.current++; clearEditor(); setList(null); setLoading(true); action(); setRetry(value => value + 1) })
  const locate = (id: string, nextGap?: 'MISSING_CITATION' | 'MISSING_SOURCE_URL') => filter(() => {
    setDocument(id); setStatus(nextGap ? 'ALL' : 'DRAFT'); setGap(nextGap ?? 'ALL'); setOffset(0); setSearch(''); setQuery('')
    setQueueFocusRequest(value => value + 1)
  })
  const read = async (id: string, reconcile = false) => {
    if (lock.current || (state.current.uncertain && (!reconcile || pending.current?.id !== id))) return
    reads.current.controller?.abort()
    const controller = new AbortController(), generation = ++reads.current.generation
    reads.current.controller = controller
    const current = () => alive.current && !controller.signal.aborted && generation === reads.current.generation
    lock.current = true; state.current.busy = true; onExitRiskChange('working'); setBusy(true); setError(''); setNotice('')
    try {
      const data = await annotationApi.get(id, controller.signal)
      if (!current()) return
      if (data.annotation.id !== id || data.annotation.document_id !== document || !Number.isSafeInteger(data.annotation.version) || data.annotation.version < 0) { setError('读取标识或版本不一致，当前草稿已保留。'); return }
      const submission = pending.current
      if (reconcile && submission) {
        if (!hasReceipt(data, submission)) { setNotice('尚未找到能确认上次提交的版本记录。草稿和写入冻结保持不变；可复制内容，稍后再次核对。'); return }
        pending.current = null; setUncertain(false); state.current.uncertain = false
        setNotice('已核对到上次提交的版本记录，未重复发送写入。'); setRefresh(value => value + 1)
      }
      setDetail(data); setFields(fieldsFor(data.annotation)); setNote(''); setActorDirty(false); state.current.dirty = false
    } catch (reason) { if (current()) setError(errorMessage(reason)) }
    finally { if (current()) { reads.current.controller = null; lock.current = false; state.current.busy = false; setBusy(false) } }
  }
  const open = (id: string) => guard(() => { void read(id) })
  const cancelRead = () => { if (!reads.current.controller) return; reads.current.generation++; reads.current.controller.abort(); reads.current.controller = null; lock.current = false; state.current.busy = false; setBusy(false); setNotice('读取已取消，原草稿保持不变。') }
  const mutate = async (action: 'EDIT' | 'REVIEW') => {
    if (!alive.current || lock.current || uncertain || !detail || !fields || !actor.trim() || !note.trim()) return
    if (action === 'EDIT' && !fieldsDirty) return
    if (action === 'REVIEW' && (fieldsDirty || !fields.citation.trim() || !fields.source_url.trim() || detail.annotation.status === 'APPROVED')) return
    const submission = { id: detail.annotation.id, version: detail.annotation.version, action, fields: submittedFields(fields), actor: actor.trim(), note: note.trim() }
    lock.current = true; state.current.busy = true; onExitRiskChange('working'); setBusy(true); setError(''); setNotice('')
    try {
      const data = action === 'EDIT' ? await annotationApi.edit(submission.id, submission.version, submission.fields, submission.actor, submission.note) :
        await annotationApi.review(submission.id, submission.version, submission.actor, submission.note)
      if (!alive.current) return
      if (data.annotation.id !== submission.id || data.annotation.document_id !== document || !Number.isSafeInteger(data.annotation.version) || data.annotation.version < submission.version) throw new Error('INVALID_RESPONSE')
      const confirmedNoop = action === 'EDIT' && data.annotation.version === submission.version && sameFields(fieldsFor(detail.annotation), submission.fields) && sameFields(fieldsFor(data.annotation), submission.fields)
      if (!confirmedNoop && !hasReceipt(data, submission)) throw new Error('INVALID_RESPONSE')
      pending.current = null; setDetail(data); setFields(fieldsFor(data.annotation))
      if (confirmedNoop) {
        state.current.dirty = !!note || actorDirty
        setNotice('规范化后字段没有变化，未新增版本。本次说明和署名没有另行写入，请保留或复制；离开前仍会提示未保存。')
      } else {
        setNote(''); setActorDirty(false); state.current.dirty = false; setRefresh(value => value + 1)
        setNotice(action === 'EDIT' ? '草稿版本已保存。修改后须重新人工审核。' : '已记录当前版本的本地人工署名审核。')
      }
    } catch (reason) {
      if (!alive.current) return
      const unknown = uncertainWrite(reason) || (reason instanceof Error && reason.message === 'INVALID_RESPONSE')
      pending.current = unknown ? submission : null; state.current.uncertain = unknown; setUncertain(unknown); setError(reason instanceof Error && reason.message === 'ANNOTATION_VERSION_CONFLICT' ? '版本已变化，本次未覆盖他人的修改。你的草稿仍保留在表单中，请复制后再确认重新读取。' : errorMessage(reason))
    } finally { if (alive.current) { lock.current = false; state.current.busy = false; setBusy(false) } }
  }
  const review = () => { if (lock.current || state.current.uncertain) return; const identity = reviewIdentity.current; confirmation.ask({ title: '记录当前版本的人工核对？', message: '请确认已实际核对词义、变量分类与注释来源。这是自填署名记录，不验证教师身份，也不自动发布或开放正式等级。', confirmLabel: '确认已核对并记录', onConfirm: () => { if (identity !== reviewIdentity.current) { setNotice('当前内容或说明已变化，请重新核对后再审核。'); return }; void mutate('REVIEW') } }) }
  const setField = <K extends keyof AnnotationFields>(key: K, value: AnnotationFields[K]) => { if (lock.current || state.current.uncertain) return; state.current.dirty = true; onExitRiskChange('dirty'); setFields(current => current && ({ ...current, [key]: value })) }
  const previousOffset = list ? Math.min(Math.max(0, offset - 25), Math.floor(Math.max(0, list.total - 1) / 25) * 25) : 0
  return <>{confirmation.modal}<main className="knowledge-workbench">
    <header><p className="eyebrow">字词审核工作台</p><h1>一处原文，一份可核对的注释。</h1><p>按篇、按位置逐项校订。保存是草稿，人工审核是单独操作；历史版本不覆盖。</p><p className="knowledge-note">仅限本地教研使用，公网管理入口保持关闭。署名为自填核对记录，不验证教师身份；系统不代替教师审定。</p></header>
    <AnnotationQualityPanel refreshKey={refresh} disabled={busy || uncertain}
      onChooseDocument={id => locate(id)}
      onChooseGap={(id, nextGap) => locate(id, nextGap)} />
    <AnnotationPacketPanel document={documents.find(item => item.id === document) ?? null} disabled={busy || uncertain || dirty} refreshKey={refresh} />
    <KnowledgeEvidencePanel document={documents.find(item => item.id === document) ?? null} disabled={busy || uncertain || dirty} refreshKey={refresh} />
    <div className="knowledge-editor-layout">
      <aside className="annotation-queue" aria-label="字词审核队列" ref={queueTarget} tabIndex={-1}>
        <fieldset disabled={busy || uncertain}><legend>筛选原文注释</legend>
          <label>原文<select value={document} onChange={event => { const value = event.target.value; filter(() => { setDocument(value); setOffset(0) }) }}>{documents.map(item => <option key={item.id} value={item.id}>{item.source} · 审核 {item.approved_annotations ?? 0}/{item.total_annotations}</option>)}</select></label>
          <label>审核状态<select value={status} onChange={event => { const value = event.target.value; filter(() => { setStatus(value); setOffset(0) }) }}><option value="ALL">全部</option><option value="DRAFT">待审核</option><option value="APPROVED">已署名审核</option></select></label>
          <label>资料缺口<select value={gap} onChange={event => { const value = event.target.value as AnnotationGap; filter(() => { setGap(value); setOffset(0) }) }}><option value="ALL">全部资料</option><option value="MISSING_CITATION">缺注释出处</option><option value="MISSING_SOURCE_URL">缺来源链接</option><option value="MISSING_EITHER">缺出处或链接（去重）</option></select></label>
          <form onSubmit={event => { event.preventDefault(); filter(() => { setSearch(query.trim()); setOffset(0) }) }}><label>查找字词<input value={query} maxLength={80} onChange={event => setQuery(event.target.value)} /></label><button type="submit" className="knowledge-action">查找</button></form>
        </fieldset>
        {loading ? <p role="status">正在读取注释…</p> : listError ? <p role="alert">{listError}<button className="knowledge-action" disabled={busy || uncertain} onClick={() => filter(() => setRetry(value => value + 1))}>重新读取队列</button></p> : list && <>
          <p>{list.total} 条{list.items.length > 0 && ` · 第 ${offset + 1}–${offset + list.items.length} 条`}</p>
          {!list.items.length && <p>{offset > 0 ? '本页暂无注释，队列可能已变化；请返回第一页或上一页重新核对。' : '当前筛选没有注释，请调整原文、状态、资料缺口或字词。没有结果不表示注释已通过审核。'}</p>}
          <div className="annotation-list">{list.items.map(item => <button key={item.id} type="button" className={detail?.annotation.id === item.id ? 'selected' : ''} disabled={busy || uncertain} onClick={() => void open(item.id)}>
            <b>{item.token}</b><span>{item.status === 'APPROVED' ? '已审核' : '待审核'} · v{item.version}</span><small>第 {item.paragraph_index + 1} 段 · 第 {item.start + 1}–{item.end} 字</small><small>{item.sentence}</small>
          </button>)}</div>
          <div className="related-pagination">{offset > 0 && !list.items.length && <button className="knowledge-action" disabled={busy || uncertain} onClick={() => filter(() => setOffset(0))}>返回第一页</button>}<button className="knowledge-action" disabled={busy || uncertain || offset === 0} onClick={() => filter(() => setOffset(previousOffset))}>上一页</button><button className="knowledge-action" disabled={busy || uncertain || offset + 25 >= list.total} onClick={() => filter(() => setOffset(offset + 25))}>下一页</button></div>
        </>}
      </aside>
      <section className="annotation-editor" aria-label="当前注释编辑">
        {error && <p role="alert" className="request-error">{error}</p>}{notice && <p role="status">{notice}</p>}
        {detail && fields ? <>
          <header><p className="eyebrow">{detail.annotation.source} · v{detail.annotation.version}{dirty && ' · 未保存'}</p><h2>“{detail.annotation.token}”的本句义</h2><blockquote>{detail.annotation.sentence}</blockquote><p>第 {detail.annotation.paragraph_index + 1} 段 · 第 {detail.annotation.start + 1}–{detail.annotation.end} 字 · {detail.annotation.status === 'APPROVED' ? `审核人：${detail.annotation.reviewer}` : '待人工审核'}</p></header>
          <form onSubmit={event => { event.preventDefault(); void mutate('EDIT') }}>
            <fieldset disabled={busy || uncertain}><legend>校订当前注释</legend>
              <label>本句释义<textarea required maxLength={2000} value={fields.meaning} onChange={event => setField('meaning', event.target.value)} /></label>
              <div className="field-grid"><label>词性<input required maxLength={80} value={fields.part_of_speech} onChange={event => setField('part_of_speech', event.target.value)} /></label><label>变量分类<select value={fields.variability} onChange={event => setField('variability', event.target.value as AnnotationFields['variability'])}><option value="CONTEXTUAL">变量 · 随本句语境推断</option><option value="STABLE">无变量 · 本句相对确定</option></select></label></div>
              <label>语境依据<textarea required maxLength={4000} value={fields.reasoning} onChange={event => setField('reasoning', event.target.value)} /></label>
              <label>注释来源链接<input type="url" maxLength={2000} value={fields.source_url} onChange={event => setField('source_url', event.target.value)} /></label>
              <label>注释依据／出处页码<textarea maxLength={2000} value={fields.citation} onChange={event => setField('citation', event.target.value)} placeholder="填写实际核对的注本、页码或对应条目；原典链接不能替代释义来源" /></label>
              <div className="field-grid"><label>编辑／审核人<input required maxLength={80} value={actor} onChange={event => { if (lock.current || state.current.uncertain) return; state.current.dirty = true; setActorDirty(true); setActor(event.target.value) }} /></label><label>本次说明<textarea required maxLength={2000} value={note} onChange={event => { if (lock.current || state.current.uncertain) return; state.current.dirty = fieldsDirty || actorDirty || !!event.target.value; setNote(event.target.value) }} /></label></div>
            </fieldset>
            <div className="annotation-actions"><button className="button button-primary" disabled={busy || uncertain || !fieldsDirty || !actor.trim() || !note.trim()}>保存草稿版本</button><button type="button" className="button button-secondary" disabled={busy || uncertain || fieldsDirty || !actor.trim() || !note.trim() || !fields.citation.trim() || !fields.source_url || detail.annotation.status === 'APPROVED'} onClick={review}>人工审核当前版本</button></div>
          </form>
          <AnnotationComparisonPanel key={`${detail.annotation.id}:${detail.annotation.version}`} disabled={busy || uncertain}
            anchor={{ id: detail.annotation.id, document_id: detail.annotation.document_id, version: detail.annotation.version, token: detail.annotation.token, sense_key: detail.annotation.sense_key }} />
          <p className="knowledge-note">词项位置、原文与义项键不在此修改，以免破坏历史锚点。改动释义或来源后自动回到待审核。</p>
          <button type="button" className="knowledge-action" disabled={busy} onClick={() => uncertain ? void read(detail.annotation.id, true) : open(detail.annotation.id)}>{uncertain ? '核对上次提交（仅当前字词）' : '重新读取当前版本'}</button>
          {uncertain && <p role="alert">操作结果未确认，已暂停写入与切换。表单保留供复制；仅显式读取同一字词核对结果，不自动重复保存或审核。</p>}
          {(uncertain || error) && <details className="annotation-draft-copy"><summary>查看并手动复制保留的草稿</summary><p>以下仅展示本页草稿，不会自动发送或保存到浏览器。可长按文字复制，注意不要将私人记录发到公共渠道。</p><pre>{`字词：${detail.annotation.token}\n本句释义：${fields.meaning}\n词性：${fields.part_of_speech}\n变量分类：${fields.variability}\n语境依据：${fields.reasoning}\n注释来源：${fields.source_url}\n出处：${fields.citation}\n署名：${actor}\n本次说明：${note}`}</pre></details>}
          <details className="annotation-history"><summary>版本历史 · {Math.max(0, detail.history.length - 1)} 次变更</summary><p>v0 为原始整理草稿，后续版本追加保存。</p>{detail.history.map(item => <article key={item.version}><b>v{item.version} · {item.action === 'EDIT' ? '保存草稿' : item.action === 'SEED' ? '原始草稿' : '人工审核'} · {item.actor}</b><p>{new Date(item.created_at).toLocaleString('zh-CN')} · {item.note}</p><p>{item.payload.meaning}</p><p>{item.payload.reasoning}</p><p>{item.payload.citation}</p></article>)}</details>
        </> : <p>从左侧选择一个字词位置，查看和校订本句注释。</p>}
      </section>
    </div>
    {busy && reads.current.controller && <button type="button" className="knowledge-action" onClick={cancelRead}>取消当前读取</button>}
  </main></>
}

export function AdminWorkbench({ onExitRiskChange, children, ability, questions, aiReview }: { onExitRiskChange: (risk: ExitRisk) => void; children: (callback: (risk: ExitRisk) => void) => React.ReactNode; ability?: (callback: (risk: ExitRisk) => void) => React.ReactNode; questions?: (callback: (risk: ExitRisk) => void) => React.ReactNode; aiReview?: (callback: (risk: ExitRisk) => void) => React.ReactNode }) {
  const [tab, setTab] = useState<'lessons' | 'words' | 'ability' | 'questions' | 'ai'>('lessons')
  const risk = useRef<ExitRisk>(null)
  const confirmation = useConfirmationDialog('admin-workbench')
  const [notice, setNotice] = useState('')
  const report = useCallback((next: ExitRisk) => { risk.current = next; onExitRiskChange(next) }, [onExitRiskChange])
  const change = (next: 'lessons' | 'words' | 'ability' | 'questions' | 'ai') => {
    if (next === tab) return
    if (risk.current === 'working') { setNotice('请等待当前操作完成，不能切换工作台。'); return }
    const expectedRisk = risk.current
    const leave = () => { if (risk.current === 'working') { setNotice('请等待当前操作完成。'); return }; if (risk.current !== expectedRisk) { setNotice('当前操作状态已变化，请重新选择工作台并确认。'); return }; report(null); setNotice(''); setTab(next) }
    if (risk.current) { confirmation.ask({ title: risk.current === 'uncertain' ? '离开未确认操作？' : '放弃未保存修改？', message: risk.current === 'uncertain' ? '上次写入可能已在服务端完成。离开会丢失本页的草稿与核对线索；请先复制并核对当前记录。此操作不撤销服务端写入。' : '请先复制需要保留的修改和说明。确认后切换工作台，当前草稿将丢失。', confirmLabel: '确认离开工作台', onConfirm: leave }); return }
    leave()
  }
  return <>{confirmation.modal}<nav className="editor-tabs" aria-label="教研工作台类型"><button aria-pressed={tab === 'lessons'} onClick={() => change('lessons')}>课程与来源</button><button aria-pressed={tab === 'words'} onClick={() => change('words')}>字词知识库审核</button>{ability && <button aria-pressed={tab === 'ability'} onClick={() => change('ability')}>课程能力标定</button>}{questions && <button aria-pressed={tab === 'questions'} onClick={() => change('questions')}>评测题审核</button>}{aiReview && <button aria-pressed={tab === 'ai'} onClick={() => change('ai')}>AI 样例核对</button>}</nav>{notice && <p role="status">{notice}</p>}{tab === 'lessons' ? children(report) : tab === 'ability' && ability ? ability(report) : tab === 'questions' && questions ? questions(report) : tab === 'ai' && aiReview ? aiReview(report) : <KnowledgeWorkbench onExitRiskChange={report} />}</>
}
