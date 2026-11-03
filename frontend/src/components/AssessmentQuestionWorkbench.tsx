import { useCallback, useEffect, useRef, useState } from 'react'
import { assessmentEditorialApi, editorialRequestId } from '../assessmentEditorialApi'
import { editorialDimensions, editorialDimensionLabels, editorialStates, editorialStatusLabels, editorialSourceUrl, fieldsForQuestion, sameFields, validEditorialWrite, editorialDraftIssues, type EditorialFields, type EditorialWrite, type QuestionDetail, type QuestionList } from '../assessmentEditorial'
import { authResponseCheckpoint, errorMessage, RequestError, uncertainWrite } from '../http'
import type { ExitRisk } from '../usePageRoute'
import '../assessmentEditorial.css'
import { useConfirmationDialog } from './ConfirmationDialog'

const pendingStorage = 'wenyan-assessment-editorial-pending-v1'
const unknownResult = (reason: unknown) => !(reason instanceof RequestError) || uncertainWrite(reason) || reason.status === 408 || reason.status === 429
function readPending(): EditorialWrite | null {
  try { const stored = JSON.parse(sessionStorage.getItem(pendingStorage) ?? 'null'); return validEditorialWrite(stored) ? stored : null } catch { return null }
}
function rememberPending(operation: EditorialWrite | null) {
  try { if (operation) sessionStorage.setItem(pendingStorage, JSON.stringify(operation)); else sessionStorage.removeItem(pendingStorage); return true } catch { return false }
}
function time(value: string | null) { return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未记录' }
function editorialError(reason: unknown) {
  const messages: Record<string, string> = {
    ASSESSMENT_QUESTION_VERSION_CONFLICT: '题目已被其他操作更新，本次没有覆盖。请先复制你的修改，再重新读取当前版本。',
    ASSESSMENT_QUESTION_INVALID: '题目字段未通过校验，请核对题干、选项、答案和解析。',
    ASSESSMENT_QUESTION_NOT_FOUND: '未找到这道候选题，请重新读取列表。',
    IDEMPOTENCY_KEY_REUSED: '提交标识对应的内容不一致，已停止写入。请保留修改并读取当前版本核对。',
  }
  return messages[reason instanceof Error ? reason.message : ''] ?? errorMessage(reason)
}
const extentLabel: Record<string, string> = { FULL: '全文', CHAPTER: '完整章', EXCERPT: '连续节选', PROMPT: '题干范围' }

export function AssessmentQuestionWorkbench({ onExitRiskChange }: { onExitRiskChange: (risk: ExitRisk) => void }) {
  const [dimension, setDimension] = useState('ALL')
  const [reviewStatus, setReviewStatus] = useState('ALL')
  const [offset, setOffset] = useState(0)
  const [list, setList] = useState<QuestionList | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [detail, setDetail] = useState<QuestionDetail | null>(null)
  const [fields, setFields] = useState<EditorialFields | null>(null)
  const [tagText, setTagText] = useState('')
  const [actor, setActor] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [pending, setPending] = useState<EditorialWrite | null>(readPending)
  const pendingRef = useRef<EditorialWrite | null>(pending)
  const setPendingNow = (value: EditorialWrite | null) => { pendingRef.current = value; setPending(value) }
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [durable, setDurable] = useState(true)
  const lock = useRef(false)
  const alive = useRef(true)
  const readController = useRef<AbortController | null>(null)
  const editorHeading = useRef<HTMLHeadingElement | null>(null)
  const questionChanged = !!detail && !!fields && !sameFields(fields, fieldsForQuestion(detail.question))
  const dirty = questionChanged || !!actor.trim() || !!note.trim()
  const issues = fields ? editorialDraftIssues(fields) : []
  const invalidSource = detail?.validation_valid === false
  const blocked = busy || !!pending
  const confirmation = useConfirmationDialog(JSON.stringify([detail?.question.id, detail?.version, fields, actor, note, busy, pending]))
  useEffect(() => { onExitRiskChange(busy ? 'working' : pending ? 'uncertain' : dirty ? 'dirty' : null) }, [busy, pending, dirty, onExitRiskChange])
  useEffect(() => () => onExitRiskChange(null), [onExitRiskChange])
  useEffect(() => { alive.current = true; return () => { alive.current = false; readController.current?.abort() } }, [])
  useEffect(() => {
    const controller = new AbortController()
    setListLoading(true); setList(null); setListError('')
    assessmentEditorialApi.list(dimension, reviewStatus, offset, controller.signal).then(next => {
      if (!controller.signal.aborted) { setList(next); setListLoading(false) }
    }).catch(reason => { if (!controller.signal.aborted) { setListError(editorialError(reason)); setListLoading(false) } })
    return () => controller.abort()
  }, [dimension, reviewStatus, offset, refresh])
  const accept = useCallback((next: QuestionDetail) => {
    setDetail(next); setFields(fieldsForQuestion(next.question)); setTagText(next.question.tags.join(', ')); setActor(''); setNote('')
  }, [])
  async function open(id: string, confirmed = false) {
    if (lock.current || pending) return
    if (dirty && !confirmed) {
      confirmation.ask({ title: '放弃本题未保存内容？', message: '本题有未保存的校订或审核说明，确定放弃吗？请先复制需要保留的内容。', confirmLabel: '放弃修改并重新读取', onConfirm: () => void open(id, true) })
      return
    }
    lock.current = true; setBusy(true); setReading(true); setError(''); setNotice('')
    const controller = new AbortController(); readController.current = controller
    try {
      const next = await assessmentEditorialApi.get(id, controller.signal)
      if (!alive.current || controller.signal.aborted) return
      accept(next)
      requestAnimationFrame(() => {
        editorHeading.current?.focus({ preventScroll: true })
        if (window.matchMedia('(max-width: 52rem)').matches) editorHeading.current?.scrollIntoView({ block: 'start' })
      })
    } catch (reason) { if (alive.current && !controller.signal.aborted) setError(editorialError(reason)) }
    finally { lock.current = false; if (alive.current) { setBusy(false); setReading(false) } }
  }
  async function send(operation: EditorialWrite, recovery = false) {
    if (lock.current || (recovery ? pendingRef.current !== operation : !!pendingRef.current)) return
    const sameIdentity = authResponseCheckpoint()
    lock.current = true; setBusy(true); setError(''); setNotice('')
    setPendingNow(operation); setDurable(rememberPending(operation))
    try {
      const next = await assessmentEditorialApi.write(operation)
      sameIdentity()
      if (!alive.current) return
      rememberPending(null); setPendingNow(null); accept(next); setRefresh(value => value + 1)
      setNotice(operation.method === 'PATCH' ? '草稿新版本已保存，原审核失效，须重新人工核对。旧试卷不被覆盖。' : operation.body.decision === 'APPROVE' ? '已记录当前版本的人工署名审核。署名未经登录认证；不代表题库已完成正式分级校准。' : '当前版本已退回，退回依据已保留。后续修改后须重新审核。')
    } catch (reason) {
      try { sameIdentity() } catch { return }
      if (alive.current) {
        if (!recovery && !unknownResult(reason)) { rememberPending(null); setPendingNow(null) }
        setError(recovery ? '本次恢复未得到有效回执；原提交结果仍未知，请使用原标识继续核对。' : editorialError(reason))
      }
    } finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  function releasePending() {
    const operation = pendingRef.current
    if (!operation || lock.current) return
    const sameIdentity = authResponseCheckpoint()
    confirmation.ask({ title: '结束未确认提交的核对？', message: '原提交可能已经保存，也可能稍后保存。结束核对不会撤销服务器写入；重新提交可能重复。请先复制需要保留的意见。', confirmLabel: '了解风险，结束核对', onConfirm: () => {
      if (!alive.current || lock.current || pendingRef.current !== operation) return
      try { sameIdentity() } catch { return }
      if (!rememberPending(null)) { setDurable(false); setError('浏览器无法清除原核对信息，请保留本页并恢复存储后再操作。'); return }
      setDurable(true); setPendingNow(null); setError(''); setNotice('原提交结果仍未知，结束核对没有撤销服务端写入；重新提交可能重复。')
    } })
  }
  function write(action: 'EDIT' | 'APPROVE' | 'REJECT', confirmed = false) {
    if (lock.current || pending || !detail || !fields || !actor.trim() || !note.trim() || (action !== 'REJECT' && (issues.length || invalidSource))) return
    if (action === 'EDIT' && !questionChanged || action !== 'EDIT' && questionChanged) return
    if (action !== 'EDIT' && !confirmed) {
      confirmation.ask({ title: action === 'APPROVE' ? '记录当前版本的署名审核？' : '退回当前题目版本？', message: action === 'APPROVE' ? '请确认你已实际核对原文版本、题干、选项、答案与解析，并填写核验来源。记录此版本的人工署名审核吗？' : '确认退回当前版本并记录你的核验依据吗？', confirmLabel: action === 'APPROVE' ? '记录署名审核' : '退回并记录依据', onConfirm: () => write(action, true) })
      return
    }
    const body: EditorialWrite['body'] = { expected_version: detail.version, actor: actor.trim(), note: note.trim() }
    if (action === 'EDIT') body.question = fields
    else body.decision = action
    void send({ id: detail.question.id, key: editorialRequestId(), method: action === 'EDIT' ? 'PATCH' : 'POST', body })
  }
  function field<K extends keyof EditorialFields>(key: K, value: EditorialFields[K]) { setFields(current => current && ({ ...current, [key]: value })) }
  const q = detail?.question
  const safeSource = q ? editorialSourceUrl(q.source_url) : null
  return <main className="knowledge-workbench assessment-question-workbench">
    {confirmation.modal}
    <header><p className="eyebrow">评测题审核工作台</p><h1>先核对题目，再讨论分级。</h1><p>逐题校订候选题干、稳定选项、答案和解析。保存草稿与人工审核分开，改稿后必须重新审核。</p><p className="knowledge-note">仅供可信本地教研使用。审核人由实际核对者填写，署名未经登录认证；候选题不等于已校准的正式测评。</p></header>
    {pending && <section className="assessment-editorial-recovery" aria-label="未确认的教研操作"><h2>上次操作的结果尚未确认</h2><p>题目 {pending.id} · {pending.method === 'PATCH' ? '保存草稿' : pending.body.decision === 'APPROVE' ? '审核通过' : '退回'}。已暂停其他写入，系统不会自动重放。</p><p>恢复会使用原提交标识和原内容；恢复失败不代表原提交失败。</p><button type="button" className="button button-primary" disabled={busy} onClick={() => void send(pending, true)}>{busy ? '正在确认…' : '使用原提交标识恢复结果'}</button><button type="button" className="button button-secondary" disabled={busy} onClick={releasePending}>结束核对</button>{!durable && <p role="alert">浏览器未能保存恢复标识。请留在此页完成确认，刷新可能丢失本地标识。</p>}</section>}
    {error && <p role="alert" className="request-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="knowledge-editor-layout">
      <aside className="annotation-queue" aria-label="候选评测题列表">
        <fieldset disabled={blocked}><legend>筛选候选题</legend><label>评测维度<select value={dimension} onChange={event => { setDimension(event.target.value); setOffset(0) }}><option value="ALL">全部维度</option>{editorialDimensions.map(item => <option key={item} value={item}>{editorialDimensionLabels[item]}</option>)}</select></label><label>审核状态<select value={reviewStatus} onChange={event => { setReviewStatus(event.target.value); setOffset(0) }}><option value="ALL">全部状态</option>{editorialStates.map(item => <option key={item} value={item}>{editorialStatusLabels[item]}</option>)}</select></label></fieldset>
        {listLoading ? <p role="status">正在读取候选题…</p> : listError ? <p role="alert">{listError}</p> : list && <><p>{list.total} 道候选题{list.items.length > 0 && ` · 第 ${offset + 1}–${offset + list.items.length} 道`}</p>{!list.items.length && <p>当前筛选没有候选题，请调整维度或审核状态。</p>}<div className="annotation-list">{list.items.map(item => <button key={item.question.id} type="button" aria-pressed={q?.id === item.question.id} className={q?.id === item.question.id ? 'selected' : ''} disabled={blocked} onClick={() => void open(item.question.id)}><b>{item.question.stem}</b><span>{editorialStatusLabels[item.question.review_status]} · 编辑头 v{item.version}</span><small>{editorialDimensionLabels[item.question.dimension]} · {item.question.difficulty} · {item.question.source}</small></button>)}</div><div className="assessment-editorial-paging"><button type="button" className="knowledge-action" disabled={blocked || listLoading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 12))}>上一页</button><button type="button" className="knowledge-action" disabled={blocked || listLoading || offset + 12 >= list.total} onClick={() => setOffset(offset + 12)}>下一页</button></div><p className="knowledge-note">{list.disclaimer}</p></>}
        <button type="button" className="knowledge-action" disabled={blocked} onClick={() => setRefresh(value => value + 1)}>重新读取候选题列表</button>
      </aside>
      <section className="annotation-editor" aria-label="当前评测题校订">
        {reading && <p role="status">正在读取当前题目…</p>}
        {q && detail && fields ? <><header><h2 ref={editorHeading} tabIndex={-1}>{editorialDimensionLabels[q.dimension]} · {q.difficulty}</h2><p>{editorialStatusLabels[q.review_status]} · 编辑头 v{detail.version}{questionChanged && ' · 题目未保存'}</p><p className="knowledge-note">题目 ID：{q.id}<br />修订：{detail.revision_version}<br />当前审核人：{q.reviewer ?? '尚无人工署名'} · {q.reviewed_at ? time(q.reviewed_at) : '未审核'}</p></header>
          <section className="assessment-editorial-source" aria-label="原文与来源"><h3>本题连续原文 · {extentLabel[q.passage_extent]}</h3><blockquote>{q.passage}</blockquote><p>{q.source} · 材料范围：{extentLabel[q.material_extent]}<br />全文第 {q.full_text_start + 1}–{q.full_text_end} 字{q.paragraph_index !== null && ` · 第 ${q.paragraph_index + 1} 段第 ${(q.start ?? 0) + 1}–${q.end} 字`}<br />原文版本：{q.text_version}</p>{safeSource && <a href={safeSource} target="_blank" rel="noopener noreferrer">打开原典来源核对（新标签页）</a>}<p className="knowledge-note">这里展示的是题目绑定的连续选段，不将节选标为整篇；来源链接不等于答案已经得到核验。原文和定位在此只读。</p></section>
          {invalidSource && <p role="alert" className="request-error">当前题目或来源定位未通过校验（{detail.validation_error}）。上方位置仅为原始记录，不是已核验引用。不能保存或批准，可填写依据退回；来源修复须另行建立正确原文版本。</p>}
          <form onSubmit={event => { event.preventDefault(); write('EDIT') }}>
            <fieldset disabled={blocked}><legend>校订题干与答案</legend>
              <label>题干<textarea required maxLength={4000} value={fields.stem} onChange={event => field('stem', event.target.value)} /></label>
              <fieldset className="assessment-editorial-options"><legend>选项文字与稳定标识</legend><p className="knowledge-note">此处序号仅便于核对；学生作答时选项会随机排序，答案按稳定标识匹配，不按 A/B/C/D 匹配。</p>{fields.options.map((option, index) => <label key={option.id}>选项 {index + 1}<small>{option.id}</small><textarea required maxLength={2000} value={option.text} onChange={event => field('options', fields.options.map(item => item.id === option.id ? { ...item, text: event.target.value } : item))} /></label>)}</fieldset>
              <label>正确选项<select value={fields.answer_id} onChange={event => field('answer_id', event.target.value)}>{fields.options.map((option, index) => <option key={option.id} value={option.id}>选项 {index + 1} · {option.text.slice(0, 60)}</option>)}</select></label>
              <label>解析与语境依据<textarea required maxLength={8000} value={fields.explanation} onChange={event => field('explanation', event.target.value)} /></label>
              <label>专项标签（用逗号分隔）<input value={tagText} maxLength={3600} onChange={event => { setTagText(event.target.value); field('tags', Array.from(new Set(event.target.value.split(/[,，]/).map(item => item.trim()).filter(Boolean)))) }} /></label>
              <div className="field-grid"><label>本次编辑／审核人<input required maxLength={80} autoComplete="off" placeholder="填写实际核对者，不填系统代审" value={actor} onChange={event => setActor(event.target.value)} /></label><label>本次核验依据／修改说明<textarea required maxLength={2000} placeholder="填写实际核对的注本、页码、链接和判断依据；退回时说明具体问题" value={note} onChange={event => setNote(event.target.value)} /></label></div>
            </fieldset>
            {issues.length > 0 && <ul className="assessment-editorial-issues" aria-label="题目字段问题">{issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
            <div className="annotation-actions"><button className="button button-primary" disabled={blocked || invalidSource || !questionChanged || !actor.trim() || !note.trim() || !!issues.length}>{busy && !reading ? '正在确认操作…' : '保存草稿新版本'}</button><button type="button" className="button button-secondary" disabled={blocked || invalidSource || questionChanged || !actor.trim() || !note.trim() || !!issues.length || q.review_status === 'APPROVED'} onClick={() => write('APPROVE')}>审核通过当前版本</button><button type="button" className="button button-secondary" disabled={blocked || questionChanged || !actor.trim() || !note.trim() || q.review_status === 'REJECTED'} onClick={() => write('REJECT')}>退回当前版本</button></div>
            <p className="knowledge-note">{questionChanged ? '题目有未保存修改，请先保存草稿后再审核。' : '审核针对上方修订号，不审核未保存的表单内容。'}不改写已经冻结的试卷或历史结果。</p>
          </form>
          <button type="button" className="knowledge-action" disabled={blocked} onClick={() => void open(q.id)}>重新读取当前题目</button>
          <details className="annotation-history"><summary>修订与审核历史 · {detail.history.length} 条</summary><p>记录追加保存，原始草稿和旧试卷不被本次改稿覆盖；所有署名均为未认证的本地记录。</p>{detail.history.map(item => <article key={item.version}><h3>{item.action === 'SEED' ? '原始草稿' : item.action === 'EDIT' ? '保存草稿' : item.action === 'APPROVE' ? '署名审核通过' : '人工退回'} · {item.actor ?? '未署名'}</h3><p>{item.version} · {time(item.created_at)}</p><p>{item.note ?? '原始候选题，尚无人工核验依据。'}</p><details><summary>查看此修订的题干、选项与解析</summary><p>{item.payload.stem}</p><ol>{item.payload.options.map(option => <li key={option.id}>{option.text}{option.id === item.payload.answer_id && '（正确选项）'}</li>)}</ol><p>{item.payload.explanation}</p><p>原文版本：{item.payload.text_version}</p></details></article>)}</details>
        </> : !reading && <p>从候选题列表选择一道题，核对来源后校订。保存不等于审核，审核不等于正式分级校准。</p>}
      </section>
    </div>
  </main>
}
