import { useCallback, useEffect, useRef, useState } from 'react'
import { annotationApi, knowledgeApi } from '../api'
import { errorMessage, uncertainWrite } from '../http'
import type { AnnotationDetail, AnnotationFields, KnowledgeDocument, ManagedAnnotation } from '../types'
import type { ExitRisk } from '../usePageRoute'

const fieldsFor = (item: ManagedAnnotation): AnnotationFields => ({ meaning: item.meaning, part_of_speech: item.part_of_speech,
  variability: item.variability, reasoning: item.reasoning, source_url: item.source_url ?? '', citation: item.citation })

export function KnowledgeWorkbench({ onExitRiskChange }: { onExitRiskChange: (risk: ExitRisk) => void }) {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [document, setDocument] = useState('')
  const [status, setStatus] = useState('ALL')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [list, setList] = useState<{ total: number; items: ManagedAnnotation[] } | null>(null)
  const [detail, setDetail] = useState<AnnotationDetail | null>(null)
  const [fields, setFields] = useState<AnnotationFields | null>(null)
  const [actor, setActor] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [listError, setListError] = useState('')
  const [notice, setNotice] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [retry, setRetry] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const lock = useRef(false)
  const dirty = !!detail && !!fields && JSON.stringify(fields) !== JSON.stringify(fieldsFor(detail.annotation))
  useEffect(() => { onExitRiskChange(busy ? 'working' : uncertain ? 'uncertain' : dirty ? 'dirty' : null) }, [busy, uncertain, dirty, onExitRiskChange])
  useEffect(() => () => onExitRiskChange(null), [onExitRiskChange])
  useEffect(() => {
    const controller = new AbortController()
    knowledgeApi.coverage(controller.signal).then(data => {
      if (!controller.signal.aborted) { setDocuments(data.documents); setDocument(current => current || data.documents[0]?.id || ''); if (!data.documents.length) setLoading(false) }
    }).catch(reason => { if (!controller.signal.aborted) { setListError(errorMessage(reason)); setLoading(false) } })
    return () => controller.abort()
  }, [retry, refresh])
  useEffect(() => {
    if (!document) return
    const controller = new AbortController()
    setLoading(true); setList(null); setListError('')
    annotationApi.list(document, status, search, offset, controller.signal).then(data => {
      if (!controller.signal.aborted) { setList(data); setLoading(false) }
    }).catch(reason => { if (!controller.signal.aborted) { setListError(errorMessage(reason)); setLoading(false) } })
    return () => controller.abort()
  }, [document, status, search, offset, retry, refresh])
  const mayDiscard = () => !dirty || window.confirm('字词注释有未保存修改，确定放弃吗？请先复制需要保留的内容。')
  const open = async (id: string) => {
    if (lock.current || !mayDiscard()) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try { const data = await annotationApi.get(id); setDetail(data); setFields(fieldsFor(data.annotation)); setUncertain(false) }
    catch (reason) { setError(errorMessage(reason)) }
    finally { lock.current = false; setBusy(false) }
  }
  const mutate = async (action: 'EDIT' | 'REVIEW') => {
    if (lock.current || uncertain || !detail || !fields || !actor.trim() || !note.trim()) return
    if (action === 'REVIEW' && !window.confirm('请确认你已实际核对当前词义、变量分类与注释来源。记录审核当前版本吗？')) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const data = action === 'EDIT' ? await annotationApi.edit(detail.annotation.id, detail.annotation.version, fields, actor.trim(), note.trim()) :
        await annotationApi.review(detail.annotation.id, detail.annotation.version, actor.trim(), note.trim())
      setDetail(data); setFields(fieldsFor(data.annotation)); setRefresh(value => value + 1)
      setNotice(action === 'EDIT' ? '草稿版本已保存。修改后须重新人工审核。' : '已记录当前版本的本地人工署名审核。')
    } catch (reason) {
      setUncertain(uncertainWrite(reason)); setError(reason instanceof Error && reason.message === 'ANNOTATION_VERSION_CONFLICT' ? '版本已变化，本次未覆盖他人的修改。请复制你的修改，再重新读取。' : errorMessage(reason))
    } finally { lock.current = false; setBusy(false) }
  }
  const setField = <K extends keyof AnnotationFields>(key: K, value: AnnotationFields[K]) => setFields(current => current && ({ ...current, [key]: value }))
  return <main className="knowledge-workbench">
    <header><p className="eyebrow">字词审核工作台</p><h1>一处原文，一份可核对的注释。</h1><p>按篇、按位置逐项校订。保存是草稿，人工审核是单独操作；历史版本不覆盖。</p><p className="knowledge-note">仅限本地教研使用。署名为自填记录，尚无登录鉴权；系统不代替教师审定。</p></header>
    <div className="knowledge-editor-layout">
      <aside className="annotation-queue" aria-label="字词审核队列">
        <fieldset disabled={busy || uncertain}><legend>筛选原文注释</legend>
          <label>原文<select value={document} onChange={event => { setDocument(event.target.value); setOffset(0) }}>{documents.map(item => <option key={item.id} value={item.id}>{item.source} · 审核 {item.approved_annotations ?? 0}/{item.total_annotations}</option>)}</select></label>
          <label>审核状态<select value={status} onChange={event => { setStatus(event.target.value); setOffset(0) }}><option value="ALL">全部</option><option value="DRAFT">待审核</option><option value="APPROVED">已署名审核</option></select></label>
          <form onSubmit={event => { event.preventDefault(); setSearch(query.trim()); setOffset(0) }}><label>查找字词<input value={query} maxLength={80} onChange={event => setQuery(event.target.value)} /></label><button type="submit" className="knowledge-action">查找</button></form>
        </fieldset>
        {loading ? <p role="status">正在读取注释…</p> : listError ? <p role="alert">{listError}<button className="knowledge-action" onClick={() => setRetry(value => value + 1)}>重新读取队列</button></p> : list && <>
          <p>{list.total} 条{list.items.length > 0 && ` · 第 ${offset + 1}–${offset + list.items.length} 条`}</p>
          {!list.items.length && <p>当前筛选没有注释，请调整原文、状态或字词。</p>}
          <div className="annotation-list">{list.items.map(item => <button key={item.id} type="button" className={detail?.annotation.id === item.id ? 'selected' : ''} disabled={busy || uncertain} onClick={() => void open(item.id)}>
            <b>{item.token}</b><span>{item.status === 'APPROVED' ? '已审核' : '待审核'} · v{item.version}</span><small>第 {item.paragraph_index + 1} 段 · 第 {item.start + 1}–{item.end} 字</small><small>{item.sentence}</small>
          </button>)}</div>
          <div className="related-pagination"><button className="knowledge-action" disabled={busy || uncertain || offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>上一页</button><button className="knowledge-action" disabled={busy || uncertain || offset + 25 >= list.total} onClick={() => setOffset(offset + 25)}>下一页</button></div>
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
              <div className="field-grid"><label>编辑／审核人<input required maxLength={80} value={actor} onChange={event => setActor(event.target.value)} /></label><label>本次说明<textarea required maxLength={2000} value={note} onChange={event => setNote(event.target.value)} /></label></div>
            </fieldset>
            <div className="annotation-actions"><button className="button button-primary" disabled={busy || uncertain || !dirty || !actor.trim() || !note.trim()}>保存草稿版本</button><button type="button" className="button button-secondary" disabled={busy || uncertain || dirty || !actor.trim() || !note.trim() || !fields.citation.trim() || !fields.source_url || detail.annotation.status === 'APPROVED'} onClick={() => void mutate('REVIEW')}>人工审核当前版本</button></div>
          </form>
          <p className="knowledge-note">词项位置、原文与义项键不在此修改，以免破坏历史锚点。改动释义或来源后自动回到待审核。</p>
          <button type="button" className="knowledge-action" disabled={busy} onClick={() => void open(detail.annotation.id)}>重新读取当前版本</button>
          {uncertain && <p role="alert">操作结果未确认，已暂停写入。重新读取核对结果，不自动重复保存或审核。</p>}
          <details className="annotation-history"><summary>版本历史 · {Math.max(0, detail.history.length - 1)} 次变更</summary><p>v0 为原始整理草稿，后续版本追加保存。</p>{detail.history.map(item => <article key={item.version}><b>v{item.version} · {item.action === 'EDIT' ? '保存草稿' : item.action === 'SEED' ? '原始草稿' : '人工审核'} · {item.actor}</b><p>{new Date(item.created_at).toLocaleString('zh-CN')} · {item.note}</p><p>{item.payload.meaning}</p><p>{item.payload.reasoning}</p><p>{item.payload.citation}</p></article>)}</details>
        </> : <p>从左侧选择一个字词位置，查看和校订本句注释。</p>}
      </section>
    </div>
  </main>
}

export function AdminWorkbench({ onExitRiskChange, children }: { onExitRiskChange: (risk: ExitRisk) => void; children: (callback: (risk: ExitRisk) => void) => React.ReactNode }) {
  const [tab, setTab] = useState<'lessons' | 'words'>('lessons')
  const risk = useRef<ExitRisk>(null)
  const report = useCallback((next: ExitRisk) => { risk.current = next; onExitRiskChange(next) }, [onExitRiskChange])
  const change = (next: 'lessons' | 'words') => {
    if (next === tab) return
    if (risk.current === 'working') { window.alert('请等待当前操作完成。'); return }
    if (risk.current && !window.confirm('当前有未保存修改或未确认操作，确定离开此工作台吗？')) return
    report(null); setTab(next)
  }
  return <><nav className="editor-tabs" aria-label="教研工作台类型"><button aria-pressed={tab === 'lessons'} onClick={() => change('lessons')}>课程与来源</button><button aria-pressed={tab === 'words'} onClick={() => change('words')}>字词知识库审核</button></nav>{tab === 'lessons' ? children(report) : <KnowledgeWorkbench onExitRiskChange={report} />}</>
}
