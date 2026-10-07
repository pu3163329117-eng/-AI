import { useCallback, useEffect, useRef, useState } from 'react'
import { adminLessonApi } from '../api'
import { abilityDimensions, abilityDimensionLabels, isCourseAbilityResponse, type CourseAbility } from '../courseAbility'
import { errorMessage, RequestError, requestJson, uncertainWrite } from '../http'
import type { AdminLesson } from '../types'
import type { ExitRisk } from '../usePageRoute'

async function readAbility(id: string, init: RequestInit = {}) {
  const response = await requestJson<unknown>(`${import.meta.env.VITE_API_ROOT ?? ''}/api/v1/admin/lessons/${encodeURIComponent(id)}/ability`, init)
  if (!isCourseAbilityResponse(response) || response.ability.lesson_id !== id) throw new RequestError('INVALID_RESPONSE', 200)
  return response.ability
}

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
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const lock = useRef(false)
  const dirty = !!saved && (saved.ability_level !== level || JSON.stringify([...saved.dimension_tags].sort()) !== JSON.stringify([...tags].sort()) || note !== saved.note)
  useEffect(() => { onExitRiskChange(busy ? 'working' : uncertain ? 'uncertain' : dirty ? 'dirty' : null) }, [busy, uncertain, dirty, onExitRiskChange])
  useEffect(() => () => onExitRiskChange(null), [onExitRiskChange])
  useEffect(() => {
    let cancelled = false
    setListLoading(true); setError('')
    adminLessonApi.list().then(data => { if (!cancelled) { setLessons(data.lessons); setListLoading(false) } }).catch(reason => { if (!cancelled) { setError(errorMessage(reason)); setListLoading(false) } })
    return () => { cancelled = true }
  }, [retry])
  const accept = useCallback((row: CourseAbility) => { setSaved(row); setLevel(row.ability_level); setTags(row.dimension_tags); setNote(row.note); setUncertain(false) }, [])
  const open = async (next: AdminLesson) => {
    if (lock.current || (dirty && !window.confirm('当前课程标定有未保存修改，确定重新读取并放弃修改吗？'))) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try { const row = await readAbility(next.id); setLesson(next); accept(row) }
    catch (reason) { setError(errorMessage(reason)) }
    finally { lock.current = false; setBusy(false) }
  }
  const save = async () => {
    if (lock.current || uncertain || !lesson || !saved || !dirty || !actor.trim() || !note.trim()) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const row = await readAbility(lesson.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ability_level: level, dimension_tags: tags, expected_version: saved.version, actor: actor.trim(), note: note.trim() }) })
      accept(row); setNotice('课程能力标定已保存。未更改原文、旧训练或学习者等级。')
    } catch (reason) { setUncertain(uncertainWrite(reason)); setError(reason instanceof Error && reason.message === 'ABILITY_VERSION_CONFLICT' ? '标定版本已变化，本次未覆盖新版本。请先保留你的修改，再重新读取。' : errorMessage(reason)) }
    finally { lock.current = false; setBusy(false) }
  }
  return <main className="knowledge-workbench course-ability-workbench">
    <header><p className="eyebrow">课程能力标定</p><h1>标明任务要求，不按篇幅猜等级。</h1><p>L1 基础、L2 进阶、L3 高阶与原文全文／章／节选范围分别管理。未标定课程仍能训练，暂不进入正式能力推荐。</p><p className="knowledge-note">标定不等于题目审核，也不改变学习者等级。仅限可信本地教研环境使用。</p></header>
    {error && <p role="alert" className="request-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="knowledge-editor-layout">
      <aside className="annotation-queue" aria-label="待标定课程">
        {listLoading ? <p role="status">正在读取课程…</p> : <><p>{lessons.length} 个课程</p>{!lessons.length && <p>暂没有可标定课程。</p>}<div className="annotation-list">{lessons.map(item => <button key={item.id} type="button" className={lesson?.id === item.id ? 'selected' : ''} disabled={busy || uncertain} onClick={() => void open(item)}><b>{item.title}</b><small>{item.source} · {item.status === 'PUBLISHED' ? '已发布' : '草稿'}</small></button>)}</div></>}
        <button className="knowledge-action" disabled={busy || uncertain} onClick={() => setRetry(value => value + 1)}>重新读取课程列表</button>
      </aside>
      <section className="annotation-editor" aria-label="当前课程能力标定">
        {lesson && saved ? <><h2>{lesson.title}</h2><p>{lesson.source} · 标定版本 v{saved.version}{dirty && ' · 未保存'}</p><form onSubmit={event => { event.preventDefault(); void save() }}>
          <fieldset disabled={busy || uncertain}><legend>能力与专项要求</legend>
            <label>任务能力等级<select value={level ?? ''} onChange={event => setLevel((event.target.value || null) as CourseAbility['ability_level'])}><option value="">未标定</option><option value="L1">L1 · 基础级</option><option value="L2">L2 · 进阶级</option><option value="L3">L3 · 高阶级</option></select></label>
            <fieldset className="ability-tag-options"><legend>专项能力标签</legend>{abilityDimensions.map(dimension => <label key={dimension}><input type="checkbox" checked={tags.includes(dimension)} onChange={event => setTags(current => event.target.checked ? [...current, dimension] : current.filter(tag => tag !== dimension))} />{abilityDimensionLabels[dimension]}</label>)}</fieldset>
            <label>标定人<input required maxLength={80} value={actor} onChange={event => setActor(event.target.value)} placeholder="填写实际标定人" /></label>
            <label>标定依据<textarea required maxLength={2000} value={note} onChange={event => setNote(event.target.value)} placeholder="说明题目要求、目标能力及难度依据；仅材料长短不足以判断" /></label>
          </fieldset>
          <button className="button button-primary" disabled={busy || uncertain || !dirty || !actor.trim() || !note.trim()}>{busy ? '正在保存…' : '保存课程标定'}</button>
        </form><p className="knowledge-note">{saved.actor ? `当前版本标定人：${saved.actor}` : '当前未记录人工标定。'}{saved.updated_at && ` · ${new Date(saved.updated_at).toLocaleString('zh-CN')}`}</p><button type="button" className="knowledge-action" disabled={busy} onClick={() => void open(lesson)}>重新读取当前标定</button>{uncertain && <p role="alert">保存结果尚未确认，已暂停写入。请重新读取核对，不自动重复保存。</p>}</> : <p>选择一个课程，标定其任务能力要求。</p>}
      </section>
    </div>
  </main>
}
