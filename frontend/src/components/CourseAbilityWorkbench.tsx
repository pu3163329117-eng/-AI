import { useCallback, useEffect, useRef, useState } from 'react'
import { adminLessonApi } from '../api'
import { abilityDimensions, abilityDimensionLabels, isCourseAbilityResponse, type CourseAbility } from '../courseAbility'
import { authResponseCheckpoint, errorMessage, RequestError, requestJson, uncertainWrite } from '../http'
import type { AdminLesson } from '../types'
import type { ExitRisk } from '../usePageRoute'
import { useConfirmationDialog } from './ConfirmationDialog'

async function readAbility(id: string, init: RequestInit = {}) {
  const response = await requestJson<unknown>(`${import.meta.env.VITE_API_ROOT ?? ''}/api/v1/admin/lessons/${encodeURIComponent(id)}/ability`, init)
  if (!isCourseAbilityResponse(response) || response.ability.lesson_id !== id) throw new RequestError('INVALID_RESPONSE', 200)
  return response.ability
}
type PendingAbility = { lessonId: string; body: { ability_level: CourseAbility['ability_level']; dimension_tags: string[]; expected_version: number; expected_content_version: string; actor: string; note: string } }
const unknownResult = (reason: unknown) => !(reason instanceof RequestError) || uncertainWrite(reason) || reason.status === 408 || reason.status === 429

export function CourseAbilityWorkbench({ onExitRiskChange }: { onExitRiskChange: (risk: ExitRisk) => void }) {
  const [lessons, setLessons] = useState<AdminLesson[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [lesson, setLesson] = useState<AdminLesson | null>(null)
  const [saved, setSaved] = useState<CourseAbility | null>(null)
  const [level, setLevel] = useState<CourseAbility['ability_level']>(null)
  const [tags, setTags] = useState<string[]>([])
  const [actor, setActor] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PendingAbility | null>(null)
  const pendingRef = useRef<PendingAbility | null>(null)
  const [check, setCheck] = useState<CourseAbility | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const lock = useRef(false)
  const alive = useRef(true)
  const uncertain = !!pending
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const dirty = !!saved && (saved.ability_level !== level || JSON.stringify([...saved.dimension_tags].sort()) !== JSON.stringify([...tags].sort()) || note !== saved.note || (saved.version > 0 && saved.valid_for_content === false))
  // Native modal replacement is asynchronous. A changed draft/version or a new
  // operation invalidates the original decision instead of approving new state.
  const confirmation = useConfirmationDialog(JSON.stringify([lesson?.id, saved, level, tags, actor, note, busy, uncertain]))
  useEffect(() => { onExitRiskChange(busy ? 'working' : uncertain ? 'uncertain' : dirty ? 'dirty' : null) }, [busy, uncertain, dirty, onExitRiskChange])
  useEffect(() => () => onExitRiskChange(null), [onExitRiskChange])
  useEffect(() => {
    let cancelled = false
    setListLoading(true); setError('')
    adminLessonApi.list().then(data => { if (!cancelled) { setLessons(data.lessons); setListLoading(false) } }).catch(reason => { if (!cancelled) { setError(errorMessage(reason)); setListLoading(false) } })
    return () => { cancelled = true }
  }, [retry])
  const accept = useCallback((row: CourseAbility) => { setSaved(row); setLevel(row.ability_level); setTags(row.dimension_tags); setNote(row.note) }, [])
  const open = async (next: AdminLesson, confirmed = false) => {
    if (lock.current || pendingRef.current) return
    if (dirty && !confirmed) {
      confirmation.ask({ title: '放弃当前标定修改？', message: '当前课程标定有未保存修改，确定重新读取并放弃修改吗？', confirmLabel: '放弃修改并重新读取', onConfirm: () => void open(next, true) })
      return
    }
    const sameIdentity = authResponseCheckpoint()
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try { const row = await readAbility(next.id); sameIdentity(); if (alive.current) { setLesson(next); accept(row) } }
    catch (reason) { try { sameIdentity() } catch { return }; if (alive.current) setError(errorMessage(reason)) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  const save = async () => {
    if (lock.current || pendingRef.current || !lesson || !saved || !saved.current_content_version || !dirty || !actor.trim() || !note.trim()) return
    const operation: PendingAbility = { lessonId: lesson.id, body: { ability_level: level, dimension_tags: [...tags], expected_version: saved.version, expected_content_version: saved.current_content_version, actor: actor.trim(), note: note.trim() } }
    const sameIdentity = authResponseCheckpoint()
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const row = await readAbility(operation.lessonId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation.body) })
      sameIdentity()
      if (row.version !== operation.body.expected_version + 1 || row.content_version !== operation.body.expected_content_version ||
          row.ability_level !== operation.body.ability_level || JSON.stringify(row.dimension_tags) !== JSON.stringify(operation.body.dimension_tags) ||
          row.actor !== operation.body.actor || row.note !== operation.body.note) throw new RequestError('INVALID_RESPONSE', 200)
      if (alive.current) { accept(row); setNotice('课程能力标定已保存。未更改原文、旧训练或学习者等级。') }
    } catch (reason) { try { sameIdentity() } catch { return }; if (alive.current) { if (unknownResult(reason)) { pendingRef.current = operation; setPending(operation); setCheck(null) }; setError(reason instanceof Error && ['ABILITY_VERSION_CONFLICT', 'ABILITY_CONTENT_VERSION_CONFLICT'].includes(reason.message) ? '标定或课程内容版本已变化，本次未覆盖新版本。请先保留你的修改，再重新读取。' : errorMessage(reason)) } }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  const checkPending = async () => {
    const operation = pendingRef.current
    if (!operation || lock.current) return
    const sameIdentity = authResponseCheckpoint()
    lock.current = true; setBusy(true); setError(''); setNotice(''); setCheck(null)
    try { const row = await readAbility(operation.lessonId); sameIdentity(); if (alive.current && pendingRef.current === operation) { setCheck(row); setNotice('仅显示当前标定快照，不能确认原提交是否保存；原请求也可能稍后保存。') } }
    catch (reason) { try { sameIdentity() } catch { return }; if (alive.current && pendingRef.current === operation) setError(errorMessage(reason)) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  const releasePending = () => {
    const operation = pendingRef.current
    if (!operation || lock.current) return
    const sameIdentity = authResponseCheckpoint()
    confirmation.ask({ title: '结束未确认标定的核对？', message: '原提交可能已经保存，也可能稍后保存。结束核对不会撤销服务器写入；重新提交可能产生重复。请先复制需要保留的标定依据。', confirmLabel: '了解风险，结束核对', onConfirm: () => {
      if (!alive.current || lock.current || pendingRef.current !== operation) return
      try { sameIdentity() } catch { return }
      pendingRef.current = null; setPending(null); setCheck(null); setError(''); setNotice('原提交结果仍未知，结束核对没有撤销服务端写入；重新提交可能重复。')
    } })
  }
  return <main className="knowledge-workbench course-ability-workbench">
    {confirmation.modal}
    <header><p className="eyebrow">课程能力标定</p><h1>标明任务要求，不按篇幅猜等级。</h1><p>L1 基础、L2 进阶、L3 高阶与原文全文／章／节选范围分别管理。未标定课程仍能训练，暂不进入正式能力推荐。</p><p className="knowledge-note">标定不等于题目审核，也不改变学习者等级。仅限可信本地教研环境使用。</p></header>
    {error && <p role="alert" className="request-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="knowledge-editor-layout">
      <aside className="annotation-queue" aria-label="待标定课程">
        {listLoading ? <p role="status">正在读取课程…</p> : <><p>{lessons.length} 个课程</p>{!lessons.length && <p>暂没有可标定课程。</p>}<div className="annotation-list">{lessons.map(item => <button key={item.id} type="button" className={lesson?.id === item.id ? 'selected' : ''} disabled={busy || uncertain} onClick={() => void open(item)}><b>{item.title}</b><small>{item.source} · {item.status === 'PUBLISHED' ? '已发布' : '草稿'}</small></button>)}</div></>}
        <button className="knowledge-action" disabled={busy || uncertain} onClick={() => setRetry(value => value + 1)}>重新读取课程列表</button>
      </aside>
      <section className="annotation-editor" aria-label="当前课程能力标定">
        {lesson && saved ? <><h2>{lesson.title}</h2><p>{lesson.source} · 标定版本 v{saved.version}{dirty && ' · 未保存'}</p>{pending && <section role="alert"><p>保存结果尚未确认，已暂停写入；仅可读取当前快照，系统不会自动重复保存。</p><details><summary>复制原标定请求</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(pending, null, 2)}</pre></details><button type="button" className="knowledge-action" disabled={busy} onClick={() => void checkPending()}>读取当前标定核对</button><button type="button" className="knowledge-action" disabled={busy} onClick={releasePending}>结束核对</button>{check && <details open><summary>当前标定快照（并非提交回执）</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(check, null, 2)}</pre></details>}</section>}<form onSubmit={event => { event.preventDefault(); void save() }}>
          {saved.version > 0 && saved.valid_for_content === false && <p role="status" className="knowledge-note">当前标定未绑定此内容版本，不能进入正式推荐。请核对改稿后重新填写标定人并保存。</p>}
          <fieldset disabled={busy || uncertain}><legend>能力与专项要求</legend>
            <label>任务能力等级<select value={level ?? ''} onChange={event => setLevel((event.target.value || null) as CourseAbility['ability_level'])}><option value="">未标定</option><option value="L1">L1 · 基础级</option><option value="L2">L2 · 进阶级</option><option value="L3">L3 · 高阶级</option></select></label>
            <fieldset className="ability-tag-options"><legend>专项能力标签</legend>{abilityDimensions.map(dimension => <label key={dimension}><input type="checkbox" checked={tags.includes(dimension)} onChange={event => setTags(current => event.target.checked ? [...current, dimension] : current.filter(tag => tag !== dimension))} />{abilityDimensionLabels[dimension]}</label>)}</fieldset>
            <label>标定人<input required maxLength={80} value={actor} onChange={event => setActor(event.target.value)} placeholder="填写实际标定人" /></label>
            <label>标定依据<textarea required maxLength={2000} value={note} onChange={event => setNote(event.target.value)} placeholder="说明题目要求、目标能力及难度依据；仅材料长短不足以判断" /></label>
          </fieldset>
          <button className="button button-primary" disabled={busy || uncertain || !saved.current_content_version || !dirty || !actor.trim() || !note.trim()}>{busy ? '正在保存…' : '保存课程标定'}</button>
        </form><p className="knowledge-note">{saved.actor ? `当前版本标定人：${saved.actor}` : '当前未记录人工标定。'}{saved.updated_at && ` · ${new Date(saved.updated_at).toLocaleString('zh-CN')}`}</p><button type="button" className="knowledge-action" disabled={busy || uncertain} onClick={() => void open(lesson)}>重新读取当前标定</button></> : <p>选择一个课程，标定其任务能力要求。</p>}
      </section>
    </div>
  </main>
}
