import { useEffect, useId, useRef, useState } from 'react'
import type { AbilityLevel } from '../assessment'
import { learningPathApi, pathRequestId } from '../learningPathApi'
import { categoryLabels, materialLabels, pathDimensionLabels, recommendationProgress, taskStatusLabels } from '../learningPath'
import type { RecommendationCategory, RecommendationPlan, RecommendationTask } from '../learningPath'
import { authResponseCheckpoint, errorMessage, RequestError, uncertainWrite } from '../http'
import type { ExitRisk } from '../usePageRoute'
import '../learningPath.css'
import './recommendationQueue.css'

type Pending = { kind: 'GENERATE'; key: string; profileId: string; level: AbilityLevel | null } | { kind: 'START'; key: string; profileId: string; taskId: string }
type Props = { profileId: string | null; externalBusy?: boolean; onAssessment?: () => void; onPractice?: () => void; onStartSession: (sessionId: string) => void; onRiskChange?: (risk: ExitRisk) => void }
function pathError(error: unknown) {
  const messages: Record<string, string> = { RECOMMENDATION_DISABLED: '学习推荐暂未启用，可以继续已有课程。', RECOMMENDATION_TASK_UNAVAILABLE: '课程的发布、审核或版本条件已变化。没有开始新训练，请重新读取队列。', RECOMMENDATION_TASK_NOT_FOUND: '未找到这条推荐任务，请重新读取队列。', IDEMPOTENCY_KEY_REUSED: '同一提交标识对应了不同内容，本次已停止。请重新读取队列。', PROFILE_NOT_FOUND: '学习档案暂不可用，请重新选择档案。', RECOMMENDATION_VERSION_CONFLICT: '队列状态已变化，没有覆盖新记录。请重新读取队列。', RECOMMENDATION_CONFLICT: '另一页面同时修改了学习路线，本次未覆盖。请重新读取后再明确提交。' }
  return error instanceof Error ? messages[error.message] ?? errorMessage(error) : errorMessage(error)
}
function time(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN') }
const unknownResult = (reason: unknown) => !(reason instanceof RequestError) || uncertainWrite(reason) || reason.status === 408 || reason.status === 429
export function RecommendationQueue(props: Props) {
  return <ProfileRecommendationQueue key={props.profileId ?? 'no-profile'} {...props} />
}
function ProfileRecommendationQueue({ profileId, externalBusy = false, onAssessment, onPractice, onStartSession, onRiskChange }: Props) {
  const [plan, setPlan] = useState<RecommendationPlan | null>(null)
  const [level, setLevel] = useState<AbilityLevel | ''>('')
  const [savedLevel, setSavedLevel] = useState<AbilityLevel | ''>('')
  const [loading, setLoading] = useState(!!profileId)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [retry, setRetry] = useState(0)
  const [confirmation, setConfirmation] = useState<{ kind: 'START'; task: RecommendationTask } | { kind: 'RELOAD' } | { kind: 'RELEASE'; target: Pending } | null>(null)
  const confirmationId = useId()
  const cancelConfirmation = useRef<HTMLButtonElement>(null)
  const confirmationTrigger = useRef<HTMLButtonElement | null>(null)
  const lock = useRef(false)
  const pendingRef = useRef<Pending | null>(null)
  const remember = (value: Pending | null) => { pendingRef.current = value; setPending(value) }
  const alive = useRef(true)
  const currentProfile = useRef(profileId); currentProfile.current = profileId
  const previousProfile = useRef(profileId)
  const dirty = level !== savedLevel
  const risk: ExitRisk = busy ? 'working' : pending ? 'uncertain' : dirty ? 'dirty' : null
  useEffect(() => { onRiskChange?.(risk) }, [onRiskChange, risk])
  useEffect(() => () => onRiskChange?.(null), [onRiskChange])
  useEffect(() => { if (confirmation) cancelConfirmation.current?.focus(); else confirmationTrigger.current?.focus() }, [confirmation])
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (previousProfile.current !== profileId) {
      previousProfile.current = profileId
      remember(null); setLevel(''); setSavedLevel(''); setBusy(lock.current)
    }
    const controller = new AbortController(); setPlan(null); setError(''); setNotice(''); setLoading(!!profileId)
    if (profileId) learningPathApi.recommendations(profileId, controller.signal).then(next => {
      if (controller.signal.aborted) return
      setPlan(next); const initial = next?.level_source === 'USER_CHOICE' ? next.practice_level : ''; setLevel(initial); setSavedLevel(initial); setLoading(false)
    }).catch(reason => { if (!controller.signal.aborted) { setError(pathError(reason)); setLoading(false) } })
    return () => controller.abort()
  }, [profileId, retry])
  async function execute(request: Pending, recovery = false) {
    if (lock.current || externalBusy || request.profileId !== profileId || (recovery ? pendingRef.current !== request : !!pendingRef.current)) return
    const sameIdentity = authResponseCheckpoint()
    lock.current = true; setBusy(true); setError('')
    try {
      if (request.kind === 'GENERATE') {
        const next = await learningPathApi.generate(request.profileId, request.level, request.key)
        sameIdentity()
        if (!alive.current || currentProfile.current !== request.profileId) return
        setPlan(next); const selected = next.level_source === 'USER_CHOICE' ? next.practice_level : ''; setLevel(selected); setSavedLevel(selected); remember(null); setNotice('队列已由服务端确认。刷新读取不会再生成任务。')
      } else {
        const next = await learningPathApi.start(request.profileId, request.taskId, request.key)
        sameIdentity()
        if (!alive.current || currentProfile.current !== request.profileId) return
        setPlan(current => current ? { ...current, tasks: current.tasks.map(task => task.id === next.task.id ? next.task : task) } : current); setLevel(savedLevel); remember(null); setBusy(false); setNotice('训练会话已确认，正在进入原文学习。'); onRiskChange?.(null); onStartSession(next.session_id)
      }
    } catch (reason) {
      try { sameIdentity() } catch { return }
      if (alive.current && currentProfile.current === request.profileId) { setError(recovery ? '本次恢复未得到有效回执；原提交结果仍未知，请使用原标识继续核对。' : pathError(reason)); remember(recovery || unknownResult(reason) ? request : null) }
    } finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  const disabled = loading || busy || externalBusy || !!pending || !!confirmation
  const progress = plan ? recommendationProgress(plan) : null
  function continueTask(task: RecommendationTask) {
    if (!profileId || loading || busy || externalBusy || pending || lock.current || task.status === 'UNAVAILABLE') return
    if (task.status === 'COMPLETED' && task.session_id) { setLevel(savedLevel); setBusy(false); onRiskChange?.(null); onStartSession(task.session_id); return }
    void execute({ kind: 'START', key: pathRequestId(), profileId, taskId: task.id })
  }
  function start(task: RecommendationTask, trigger: HTMLButtonElement) {
    if (!profileId || disabled || task.status === 'UNAVAILABLE') return
    if (dirty) { confirmationTrigger.current = trigger; setConfirmation({ kind: 'START', task }); return }
    continueTask(task)
  }
  function closeConfirmation() {
    setConfirmation(null)
  }
  function confirmAction() {
    if (!confirmation || busy || externalBusy || lock.current) return
    const action = confirmation
    if (action.kind === 'RELEASE') {
      if (pendingRef.current !== action.target) return
      remember(null); setNotice('原提交仍可能已保存或稍后保存；解除冻结没有撤销服务端操作，重新提交可能重复。'); closeConfirmation(); return
    }
    if (pendingRef.current) return
    closeConfirmation()
    if (action.kind === 'RELOAD') setRetry(value => value + 1)
    else continueTask(action.task)
  }
  return <section className="learning-path recommendation-queue" aria-labelledby="recommendation-queue-title"><header className="path-section-heading"><div><p className="eyebrow">学习路线 · 只推荐实际可用任务</p><h2 id="recommendation-queue-title">下一步，带着理由去读。</h2></div>{onAssessment && <button className="button button-secondary" disabled={busy || externalBusy} onClick={onAssessment}>先看看能力试测</button>}</header>
    {!profileId ? <p>建立档案后可保存自己的学习队列。你仍可以浏览现有课程。</p> : <>
      <fieldset className="path-level-choice" disabled={disabled}><legend>选择练习起点，不是修改能力等级</legend><label><input type="radio" name="path-practice-level" checked={level === ''} onChange={() => setLevel('')} />使用正式建议；尚未正式测评则从基础起步</label>{(['L1', 'L2', 'L3'] as AbilityLevel[]).map(item => <label key={item}><input type="radio" name="path-practice-level" checked={level === item} onChange={() => setLevel(item)} />{item} · {{ L1: '基础入境', L2: '通篇理解', L3: '深入阅读' }[item]}</label>)}</fieldset>
      <div className="path-actions"><button className="button button-primary" disabled={disabled} onClick={() => void execute({ kind: 'GENERATE', key: pathRequestId(), profileId, level: level || null })}>{busy ? '正在等待服务端确认…' : plan ? '确认起点并生成／读取队列' : '确认起点并生成学习队列'}</button>{onPractice && <button className="button button-secondary" disabled={busy || externalBusy} onClick={onPractice}>暂不测评，继续已有练习</button>}</div>
      <p className="path-save-status" role="status" aria-live="polite">{busy ? '正在确认提交，请勿重复操作。' : pending ? '上次提交的结果未知，请先恢复确认。' : dirty ? '新选择的练习起点尚未确认。' : notice}</p>
      {confirmation && <div className="path-confirmation" role="dialog" aria-labelledby={`${confirmationId}-title`} aria-describedby={`${confirmationId}-description`} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeConfirmation() } }}><h3 id={`${confirmationId}-title`}>{confirmation.kind === 'RELEASE' ? '结束未确认提交的核对？' : '练习起点还没有确认'}</h3><p id={`${confirmationId}-description`}>{confirmation.kind === 'RELEASE' ? '原提交可能已保存，也可能稍后保存。解除冻结不会撤销服务端操作；重新提交可能产生重复。请先复制并核对。' : confirmation.kind === 'RELOAD' ? '重新读取会放弃刚选择的起点，恢复服务端已保存的队列。' : '开始这条任务会沿用当前已保存的队列，刚选择的新起点不会生效。'}</p><div className="path-actions"><button ref={cancelConfirmation} type="button" className="button button-secondary" onClick={closeConfirmation}>保留选择，返回修改</button><button type="button" className="button button-primary" disabled={busy || externalBusy || (!!pending && confirmation.kind !== 'RELEASE')} onClick={confirmAction}>{confirmation.kind === 'RELEASE' ? '了解风险，结束核对' : confirmation.kind === 'RELOAD' ? '放弃选择，重新读取' : '沿用当前队列并开始'}</button></div></div>}
      {error && <div className="path-message" role="alert"><p>{error}</p>{!pending && !busy && <button className="button button-secondary" disabled={externalBusy || !!confirmation || loading} onClick={event => { if (dirty) { confirmationTrigger.current = event.currentTarget; setConfirmation({ kind: 'RELOAD' }); return }; setRetry(value => value + 1) }}>重新读取队列</button>}</div>}
      {pending && <div className="path-message" role="alert"><p>保存或开始任务的结果尚未确认。已暂停新的提交；恢复时只使用上次的标识和原始内容。恢复失败不表示原提交失败。</p><button className="button button-secondary" disabled={busy || externalBusy || !!confirmation} onClick={() => void execute(pending, true)}>恢复上一次提交</button><button className="button button-secondary" disabled={busy || externalBusy || !!confirmation} onClick={event => { confirmationTrigger.current = event.currentTarget; setConfirmation({kind:'RELEASE',target:pending}) }}>结束核对</button></div>}
{loading ? <p role="status" aria-busy="true">正在读取已保存的学习队列，不会自动生成…</p> : plan ? <><div className="path-plan-meta"><p>练习起点 {plan.practice_level} · {{ USER_CHOICE: '你选择的练习方向，不是测评定级', FORMAL_ASSESSMENT: '来自正式测评的试行建议', FOUNDATION_DEFAULT: '未定级时的基础练习起点' }[plan.level_source]}</p><p>{plan.explanation}</p><small>{time(plan.created_at)} · 实际 {progress!.total} 项任务 · 已完成 {progress!.completed}{progress!.unavailable ? ` · 暂不可用 ${progress!.unavailable}` : ''}</small></div>{plan.tasks.length ? <div className="path-task-groups">{(['MAIN', 'REINFORCEMENT', 'CHALLENGE'] as RecommendationCategory[]).map(category => { const tasks = plan.tasks.filter(task => task.category === category); return tasks.length ? <section key={category} aria-labelledby={`path-category-${category}`}><h3 id={`path-category-${category}`}>{categoryLabels[category]} · {tasks.length} 项</h3><ol>{tasks.map(task => <li key={task.id}><div className="path-task-heading"><div><p className="eyebrow">{task.task_type === 'WHOLE_READING' ? '通篇阅读' : '专项练习'} · {materialLabels[task.material_extent]} · {task.ability_level}</p><h4>{task.title}</h4></div><span>{taskStatusLabels[task.status]}</span></div><p>{task.source} · {task.dimension_tags.map(tag => pathDimensionLabels[tag]).join('、') || '目标未登记'}</p><p><b>为什么推荐：</b>{task.reason}</p>{task.unavailable_reason && <p className="path-note">{task.unavailable_reason}</p>}<div className="path-task-footer"><small>冻结内容版本 {task.content_version}</small><button className="button button-secondary" disabled={disabled || task.status === 'UNAVAILABLE'} onClick={event => start(task, event.currentTarget)}>{task.status === 'COMPLETED' ? '回看已完成训练' : task.status === 'IN_PROGRESS' ? '继续这条训练' : task.status === 'UNAVAILABLE' ? '暂不可开始' : '开始这条训练'}</button></div></li>)}</ol></section> : null })}</div> : <div className="path-empty"><h3>当前还没有合格的推荐任务。</h3><p>没有把未审核、未标定或已过期课程凑进队列。旧练习仍可使用，但不冒充正式推荐。</p></div>}{plan.gaps.length > 0 && <aside className="path-gaps" aria-labelledby="path-gaps-title"><h3 id="path-gaps-title">当前内容缺口</h3><ul>{plan.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></aside>}<p className="path-note">这里展示实际任务，不把三类任务数量称为已经满足 70／20／10 比例。新材料挑战也不意味着你的能力等级已经提高。</p></> : !error && <div className="path-empty"><h3>尚未生成学习路线。</h3><p>先确认练习起点，再明确生成。仅打开或刷新首页不会新增队列。</p></div>}
    </>}
  </section>
}
