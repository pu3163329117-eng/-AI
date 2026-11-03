import { TrainingWayfinding } from './components/TrainingWayfinding'
import { SpecializedPracticePage } from './components/SpecializedPracticePage'
import { GuidedTrainingPage, type GuidedTrainingProps } from './components/GuidedTrainingPage'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { adminLessonApi, lessonApi, profileApi, requestId, trainingApi } from './api'
import { errorMessage, uncertainWrite, RequestError, privateWritesAreSuspended, authResponseCheckpoint, setCreationWritesBlocked, requestJson } from './http'
import { validateResponse } from './contracts'
import { executeTrainingCommand, type TrainingCommandIntent, type TrainingCommandOutcome } from './trainingCommandOutcome'
import { AuthBoundary } from './authBoundary'
import { canManage, canManageSupport, validAuthSession, type AuthSession } from './auth'
import { ReviewRecallBoard } from './components/ReviewRecallBoard'
import { RenderBoundary } from './components/RenderBoundary'
import { AppHeader } from './components/AppHeader'
import { WaterinkMobileNavigation, WaterinkProfileLinks } from './components/WaterinkNavigation'
import { AboutPage } from './components/AboutPage'
import { ContextReader } from './components/ContextReader'
import { EditorialSources } from './components/EditorialSources'
import { AdminWorkbench } from './components/KnowledgeWorkbench'
import { SupportInbox } from './components/SupportInbox'
import { ReasoningEditor, ReasoningHistory } from './components/ReasoningEditor'
import { ReasonFeedback } from './components/ReasonFeedback'
import { AssessmentPage } from './components/AssessmentPage'
import { CourseAbilityWorkbench } from './components/CourseAbilityWorkbench'
import { AssessmentQuestionWorkbench } from './components/AssessmentQuestionWorkbench'
import { AIReasonReviewWorkbench } from './components/AIReasonReviewWorkbench'
import { AbilityProfilePanel } from './components/AbilityProfilePanel'
import { ReadingHomePage } from './components/ReadingHomePage'
import { InkScene } from './motion/InkScene'
import { InkMotionControl, useInkMotion } from './motion/useInkMotion'
import { ObservationReport } from './components/ObservationReport'
import { SessionObservations } from './components/SessionObservations'
import { BetaSupportPanel } from './components/BetaSupportPanel'
import { ProductTourBoundary, useProductTour } from './components/ProductTour'
import { trainingDraftIsDirty } from './trainingDraft'
import { useConfirmationDialog } from './components/ConfirmationDialog'
import { shouldLeaveOnboarding } from './betaSupport'
import { restoredAnswer } from './reasoning'
import { jumpTo, optionIndex, pageLabels, readRoute, type Page } from './navigation'
import { usePageRoute, type ExitRisk } from './usePageRoute'
import './polish.css'
import './functionalPages.css'
import type { Achievement, Achievements, AdminLesson, AdminLessonInput, CommandType, DailyMission, LearnerProfile, LearningSummary, Lesson, Mistake, PracticePlan, PracticePlanGroupBy, ReviewSession, SchoolStage, TrainingSession } from './types'

const taskLabels = ['识别已知', '推断变量', '回溯验证', '迁移挑战']
type PendingTrainingCommand = TrainingCommandIntent


function OnboardingPage({ busy, locked, draft, error, onCreate, inviteMode = false }: { busy: boolean; locked: boolean; draft: { displayName: string; schoolStage: SchoolStage } | null; error: string | null; onCreate: (name: string, stage: SchoolStage) => void; inviteMode?: boolean }) {
  const [name, setName] = useState(draft?.displayName ?? '')
  const [stage, setStage] = useState<SchoolStage>(draft?.schoolStage ?? 'JUNIOR')
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (name.trim()) onCreate(name.trim(), stage)
  }
  return (
    <main className="onboarding-page">
      <section className="onboarding-copy">
        <p className="eyebrow">第一步 · 建立学习档案</p>
        <h1>选好学习阶段，<br />开始读一篇。</h1>
        <ol className="getting-started-steps" aria-label="开始学习的三个步骤">
          <li><b>填写昵称和学习阶段</b><span>不用填写真实姓名。</span></li>
          <li><b>查看推荐文章</b><span>按所选初中或高中阶段展示课程。</span></li>
          <li><b>开始今日关卡</b><span>先读原文，尝试判断，再找依据。</span></li>
        </ol>
        <p>{inviteMode ? '学习档案将关联到当前登录账号。使用昵称即可，请勿填写真实姓名或其他敏感信息。' : '档案保存在本机学习服务中，这个浏览器会记住你的入口。目前处于本地免登录模式，不适合直接公开到互联网。'}</p>
      </section>
      <form className="profile-form" onSubmit={submit}>
        <label>怎么称呼你？<input type="text" autoComplete="nickname" value={name} maxLength={20} required disabled={busy || locked} onChange={(event) => setName(event.target.value)} placeholder="例如：小林" autoFocus /></label>
        <fieldset disabled={busy || locked} aria-describedby="school-stage-help">
          <legend>你现在的学习阶段</legend>
          <label><input type="radio" name="stage" checked={stage === 'JUNIOR'} onChange={() => setStage('JUNIOR')} /> 初中</label>
          <label><input type="radio" name="stage" checked={stage === 'SENIOR'} onChange={() => setStage('SENIOR')} /> 高中</label>
        </fieldset>
        <p id="school-stage-help" className="profile-form-help">当前课程覆盖初中和高中。这不是能力考试，只用于选择课程，请按你希望练习的阶段选择。</p>
        <button className="button button-primary" disabled={!name.trim() || busy || locked}>{locked ? '等待核对创建结果' : busy ? '正在建立档案…' : '保存资料，查看推荐文章'} <span aria-hidden="true">→</span></button>
        {error && <p className="request-error" role="alert">无法建立档案：{error}</p>}
      </form>
    </main>
  )
}

function ProfilePage({ profile, onStart, onReplayTour, onNavigate, adminAllowed, adminLabel }: { profile: LearnerProfile; onStart: () => void; onReplayTour: () => void; onNavigate: (page: Page) => void; adminAllowed: boolean; adminLabel?: '教研工作台' | '用户反馈' }) {
  const stage = profile.school_stage === 'JUNIOR' ? '初中' : '高中'
  const title = profile.total_points >= 60 ? '行读者' : profile.total_points >= 20 ? '见习推理者' : '初入文境'
  return (
    <main className="profile-page">
      <header className="waterink-page-heading">
      <p className="eyebrow">我的学习档案</p>
      <h1>{profile.display_name}，<br />继续把依据说清楚。</h1>
      <p className="intro">当前分级：{stage}。已确认的学习记录保存在你的学习档案中。</p>
      </header>
      <section className="profile-stats" aria-label="学习进度">
        <article><span>当前身份</span><strong>{title}</strong></article>
        <article><span>完成关卡</span><strong>{profile.completed_levels}</strong></article>
        <article><span>累计知行</span><strong>{profile.total_points}</strong></article>
      </section>
      <div className="profile-actions"><button className="button button-primary" onClick={onStart}>选择文章，继续训练 <span aria-hidden="true">→</span></button>
      <button className="button button-secondary" onClick={onReplayTour}>重新了解产品功能</button></div>
      <WaterinkProfileLinks onNavigate={onNavigate} adminAllowed={adminAllowed} adminLabel={adminLabel} />
    </main>
  )
}

function displayActivityDate(value: string) {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

function normalizedAccuracy(value: number) {
  const percentage = value <= 1 ? value * 100 : value
  return Math.max(0, Math.min(100, Math.round(percentage)))
}

function achievementProgress(achievement: Achievement) {
  if (achievement.target <= 0) return achievement.unlocked ? 100 : 0
  return Math.max(0, Math.min(100, Math.round((achievement.current / achievement.target) * 100)))
}

function LearningReportPage({
  summary,
  loading,
  error,
  achievements,
  achievementsLoading,
  achievementsError,
  onRetry,
  onStart,
  onRecommendation,
}: {
  summary: LearningSummary | null
  loading: boolean
  error: string | null
  achievements: Achievements | null
  achievementsLoading: boolean
  achievementsError: string | null
  onRetry: () => void
  onStart: () => void
  onRecommendation: (kind: string) => void
}) {
  if (loading) {
    return <section className="learning-report-page report-state" aria-live="polite"><p className="eyebrow">学习进度</p><h2>正在整理<br />你的学习轨迹。</h2><p className="intro">把最近的训练、薄弱环节和连续学习天数汇总成一页。</p></section>
  }
  if (error) {
    return <section className="learning-report-page report-state" role="alert"><p className="eyebrow">学习进度</p><h2>报告暂时<br />还没准备好。</h2><p className="intro">{errorMessage(error)} 已确认的记录仍保留，可以重新读取。</p><button className="button button-primary" onClick={onRetry}>重新读取 <span aria-hidden="true">→</span></button></section>
  }
  if (!summary || (summary.completed_sessions === 0 && summary.completed_lessons === 0 && summary.total_points === 0)) {
    return <section className="learning-report-page report-state"><p className="eyebrow">学习进度</p><h2>先完成一关，<br />再看见你的路径。</h2><p className="intro">每次完成训练后，这里会记录知行、连续学习天数，以及下一步值得回看的推理能力。</p><button className="button button-primary" onClick={onStart}>去首页选择第一关 <span aria-hidden="true">→</span></button></section>
  }

  return (
    <section className="learning-report-page">
      <header className="report-heading">
        <div><p className="eyebrow">学习进度</p><h2>把每一次判断，<br />看成一条路径。</h2><p>这不是排名，而是你在文言语境中留下的证据、回溯与迁移记录。</p></div>
        <aside className="report-streak" aria-label={`已连续学习 ${summary.current_streak_days} 天`}><b>{summary.current_streak_days}</b><span>连续学习<br />天</span></aside>
      </header>

      <section className="report-totals" aria-label="学习总览">
        <article><span>累计知行</span><strong>{summary.total_points}</strong><small>来自完成训练</small></article>
        <article><span>完成关卡</span><strong>{summary.completed_lessons}</strong><small>已经走完的课程</small></article>
        <article><span>完成训练</span><strong>{summary.completed_sessions}</strong><small>包含重复复习</small></article>
      </section>

      <div className="report-grid">
        <section className="report-section weak-skills" aria-labelledby="weak-skills-title">
          <div className="report-section-heading"><div><p className="eyebrow">下一步回看</p><h2 id="weak-skills-title">需要多一点证据的地方</h2></div><span>按当前正确率排序</span></div>
          {summary.weak_skills.length === 0 ? <div className="report-empty"><b>还在收集你的推理样本。</b><p>再完成几次训练后，这里会标出值得优先复习的能力。</p></div> : <div className="weak-skill-list">
            {summary.weak_skills.map((skill) => {
              const accuracy = normalizedAccuracy(skill.accuracy)
              return <article key={skill.label} className="weak-skill-row">
                <div><strong>{skill.label}</strong><p>已练习 {skill.attempts} 次</p></div>
                <div className="report-meter" aria-label={`${skill.label} 当前正确率 ${accuracy}%`}><i style={{ width: `${accuracy}%` }} /></div>
                <b>{accuracy}%</b>
              </article>
            })}
          </div>}
        </section>

        <section className="report-section report-activity" aria-labelledby="activity-title">
          <div className="report-section-heading"><div><p className="eyebrow">最近 7 天</p><h2 id="activity-title">训练足迹</h2></div></div>
          {summary.recent_activity.length === 0 ? <div className="report-empty"><b>今天还没有训练记录。</b><p>完成一关后，知行和训练次数会按日期记在这里。</p></div> : <ol className="activity-list">
            {summary.recent_activity.map((activity) => <li key={activity.date}><time dateTime={activity.date}>{displayActivityDate(activity.date)}</time><span>{activity.completed_sessions > 0 ? `完成 ${activity.completed_sessions} 次训练` : '记录学习状态'}</span><b>{activity.points > 0 ? `+${activity.points}` : '—'} <small>知行</small></b></li>)}
          </ol>}
        </section>
      </div>

      <section className="report-achievements" aria-labelledby="achievements-title">
        <div className="report-section-heading">
          <div><p className="eyebrow">学习印记</p><h2 id="achievements-title">每一步都有回声</h2></div>
          {!achievementsLoading && achievements && <span>{achievements.achievements.filter((item) => item.unlocked).length} / {achievements.achievements.length} 已解锁</span>}
        </div>
        {achievementsLoading ? <div className="report-empty" aria-live="polite"><b>正在整理学习印记。</b><p>完成的训练和持续练习会在这里留下进度。</p></div>
          : achievementsError ? <div className="report-empty" role="alert"><b>学习印记暂时无法读取。</b><p>{errorMessage(achievementsError)} 报告其他内容不受影响。</p><button className="text-button" onClick={onRetry}>重新读取报告与印记 →</button></div>
            : !achievements || achievements.achievements.length === 0 ? <div className="report-empty"><b>学习印记正在准备中。</b><p>完成更多训练后，这里会展示你的阶段性进展。</p></div>
              : <div className="achievement-list">
                {achievements.achievements.map((achievement) => {
                  const progress = achievementProgress(achievement)
                  return <article key={achievement.id} className={achievement.unlocked ? 'achievement-row is-unlocked' : 'achievement-row'}>
                    <div className="achievement-copy"><span>{achievement.unlocked ? '已解锁' : '进行中'}</span><strong>{achievement.label}</strong><p>{achievement.description}</p></div>
                    <div className="achievement-progress">
                      <progress value={progress} max="100" aria-label={`${achievement.label}：${achievement.current} / ${achievement.target}`} />
                      <b>{achievement.unlocked ? '完成' : `${achievement.current} / ${achievement.target}`}</b>
                    </div>
                  </article>
                })}
              </div>}
      </section>

      {achievements?.review_recommendation && <section className="review-recommendation" aria-labelledby="recommendation-title">
        <div><p className="eyebrow">下一次练习</p><h2 id="recommendation-title">{achievements.review_recommendation.title}</h2><p>{achievements.review_recommendation.description}</p></div>
        <button className="button button-secondary" onClick={() => onRecommendation(achievements.review_recommendation!.kind)}>{achievements.review_recommendation.action_label} <span aria-hidden="true">→</span></button>
      </section>}
      <button className="button button-primary report-action" onClick={onStart}>选择文章，继续训练 <span aria-hidden="true">→</span></button>
    </section>
  )
}

function ReviewPage({
  sessions,
  loading,
  error,
  mistakes,
  mistakesLoading,
  mistakesError,
  startingLesson,
  startError,
  onOpen,
  onRetryMistakes,
  onRetrySessions,
  onStartLesson,
}: {
  sessions: ReviewSession[];
  loading: boolean;
  error: string | null;
  mistakes: Mistake[];
  mistakesLoading: boolean;
  mistakesError: string | null;
  startingLesson: boolean;
  startError: string | null;
  onOpen: (sessionId: string) => void;
  onRetryMistakes: () => void;
  onRetrySessions: () => void;
  onStartLesson: (lessonId: string) => void;
}) {
  return (
    <main className="review-page">
      <header className="waterink-page-heading">
      <p className="eyebrow">复习</p>
      <h1>把走过的推理，<br />再走一遍。</h1>
      <p className="intro">错过的判断会留在错题本里；未完成的关卡也能从原处继续。每一次重练，都回到具体的语境和证据。</p>
      </header>

      <section className="mistake-bank" aria-labelledby="mistake-bank-title">
        <header className="review-section-heading"><div><p className="eyebrow">错题本</p><h2 id="mistake-bank-title">回到当时没说清的地方。</h2></div>{!mistakesLoading && !mistakesError && <span>{mistakes.length} 个待回看</span>}</header>
        {mistakesLoading ? <div className="review-state" aria-live="polite"><b>正在整理错题本…</b><p>把每次尚未答对的语境和线索汇总到这里。</p></div>
          : mistakesError ? <div className="review-state" role="alert"><b>错题本暂时无法读取。</b><p>{errorMessage(mistakesError)} 已保存的错题没有被清除。</p><button className="text-button" onClick={onRetryMistakes}>重新读取错题 →</button></div>
            : mistakes.length === 0 ? <div className="review-state"><b>错题本还是空的。</b><p>继续认真作答；遇到需要回看的地方，会在这里留下清晰的复习入口。</p></div>
              : <ReviewRecallBoard items={mistakes} busy={startingLesson} onStart={onStartLesson} />}
        {startError && <p className="request-error review-action-error" role="alert">无法开始复习：{startError}</p>}
      </section>

      <section className="review-history" aria-labelledby="review-history-title">
        <header className="review-section-heading"><div><p className="eyebrow">最近训练</p><h2 id="review-history-title">继续未走完的路径。</h2></div></header>
        {loading ? <p className="review-status" role="status">正在读取训练记录…</p> : error ? <div className="review-state" role="alert"><b>训练记录暂时无法读取。</b><p>{errorMessage(error)}</p><button className="text-button" onClick={onRetrySessions}>重新读取训练记录 →</button></div> : sessions.length === 0 ? (
          <div className="review-empty"><b>还没有可回看的训练。</b><p>开始训练后，未完成的练习和已完成的总结都会出现在这里。</p></div>
        ) : (
          <div className="review-list" aria-label="最近训练记录">
          {sessions.map((item) => (
            <article key={item.session_id}>
              <div><span>{item.completed ? '已完成' : '进行中'}</span><strong>{item.source}</strong><p>{item.feedback}</p></div>
              <button className="text-button" disabled={startingLesson} onClick={() => onOpen(item.session_id)}>{startingLesson ? '正在打开…' : item.completed ? '查看总结' : '继续练习'} →</button>
            </article>
          ))}
          </div>
        )}
      </section>
    </main>
  )
}

type ContentForm = {
  school_stage: SchoolStage
  title: string
  source: string
  difficulty: string
  estimated_minutes: string
  summary: string
  textbook_tags: string
  theme: string
  accumulation_points: string
  reasoning_points: string
  reasoning_level: string
  core_content: string
  transfer_content: string
}

const emptyContentForm = (): ContentForm => ({
  school_stage: 'JUNIOR', title: '', source: '', difficulty: '', estimated_minutes: '', summary: '',
  textbook_tags: '', theme: '', accumulation_points: '', reasoning_points: '', reasoning_level: '',
  core_content: '', transfer_content: '',
})

const lines = (value: string) => value.split(/\n|,/).map((item) => item.trim()).filter(Boolean)

type PendingEditorial =
  | { kind: 'create'; form: ContentForm; payload: AdminLessonInput }
  | { kind: 'review'; lessonId: string; version: string; reviewer: string; note: string; form: ContentForm }
  | { kind: 'update'; lessonId: string; version: string; form: ContentForm; payload: AdminLessonInput }
  | { kind: 'publish'; lessonId: string; version: string; form: ContentForm }

function uncertainEditorialWrite(reason: unknown) {
  return !(reason instanceof RequestError) || uncertainWrite(reason) || reason.status === 408 || reason.status === 429
}

function contentFormFromLesson(lesson: AdminLesson): ContentForm {
  const content = lesson.content ?? {}
  return {
    school_stage: lesson.school_stage,
    title: lesson.title,
    source: lesson.source,
    difficulty: lesson.difficulty,
    estimated_minutes: String(lesson.estimated_minutes),
    summary: lesson.summary,
    textbook_tags: (lesson.textbook_tags ?? []).join(', '),
    theme: lesson.theme ?? '',
    accumulation_points: (lesson.accumulation_points ?? []).join('\n'),
    reasoning_points: (lesson.reasoning_points ?? []).join('\n'),
    reasoning_level: lesson.reasoning_level ?? '',
    core_content: content.CORE ? JSON.stringify(content.CORE, null, 2) : '',
    transfer_content: content.TRANSFER ? JSON.stringify(content.TRANSFER, null, 2) : '',
  }
}

function parseEditorialContent(form: ContentForm): Record<string, unknown> | undefined {
  if (!form.core_content.trim() && !form.transfer_content.trim()) return undefined
  if (!form.core_content.trim() || !form.transfer_content.trim()) throw new Error('CONTENT_STAGES_REQUIRED')
  const result: Record<string, unknown> = {}
  result.CORE = JSON.parse(form.core_content)
  result.TRANSFER = JSON.parse(form.transfer_content)
  if (Object.values(result).some(value => !value || typeof value !== 'object' || Array.isArray(value))) throw new Error('CONTENT_OBJECT_REQUIRED')
  return result
}

function ContentAdminPage({ onExitRiskChange }: { onExitRiskChange: (risk: ExitRisk) => void }) {
  const [lessons, setLessons] = useState<AdminLesson[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | 'new' | null>(null)
  const [editingLesson, setEditingLesson] = useState<AdminLesson | null>(null)
  const [form, setForm] = useState<ContentForm>(emptyContentForm)
  const [detailLoading, setDetailLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [reviewer, setReviewer] = useState('')
  const [reviewNote, setReviewNote] = useState('')
  const [savedForm, setSavedForm] = useState<ContentForm>(emptyContentForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingEditorial | null>(null)
  const pendingRef = useRef<PendingEditorial | null>(null)
  const operationLock = useRef(false)
  const checkLock = useRef(false)
  const alive = useRef(true)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [checkList, setCheckList] = useState<AdminLesson[] | null>(null)
  const [checkDetail, setCheckDetail] = useState<AdminLesson | null>(null)
  const [releasedNotice, setReleasedNotice] = useState(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const loadLessons = useCallback(async () => {
    setLoading(true); setListError(null)
    try {
      const response = await adminLessonApi.list()
      setLessons(response.lessons)
    } catch (reason) {
      setLessons([])
      setListError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void loadLessons() }, [loadLessons])

  const openNew = () => {
    requestContentChange(() => {
      setActiveId('new'); setEditingLesson(null); setForm(emptyContentForm()); setSavedForm(emptyContentForm()); setFormError(null); setSuccess(null); setReviewNote('')
    }, '当前有未保存修改，确定放弃并新建课程吗？')
  }

  const openLesson = (lessonId: string) => requestContentChange(() => { void readLesson(lessonId) }, '当前有未保存修改，确定切换课程吗？')
  const readLesson = async (lessonId: string) => {
    if (operationLock.current || pendingRef.current) return
    setActiveId(lessonId); setEditingLesson(null); setDetailLoading(true); setFormError(null); setSuccess(null)
    try {
      const response = await adminLessonApi.get(lessonId)
      setEditingLesson(response.lesson)
      setForm(contentFormFromLesson(response.lesson))
      setSavedForm(contentFormFromLesson(response.lesson))
      setLessons(current => current.map(lesson => lesson.id === lessonId ? response.lesson : lesson))
      setReviewNote('')
    } catch (reason) {
      // Never let a failed detail request reuse the previous lesson's form.
      setActiveId(null); setEditingLesson(null); setForm(emptyContentForm()); setSavedForm(emptyContentForm())
      setFormError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setDetailLoading(false) }
  }

  const setField = <Key extends keyof ContentForm>(key: Key, value: ContentForm[Key]) => { if (!operationLock.current && !pendingRef.current) setForm((current) => ({ ...current, [key]: value })) }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (operationLock.current || pendingRef.current || !activeId || (activeId !== 'new' && !selectedLesson?.review?.content_version)) return
    setFormError(null); setSuccess(null)
    let content: Record<string, unknown> | undefined
    try {
      content = parseEditorialContent(form)
    } catch (reason) {
      setFormError(reason instanceof Error && ['CONTENT_STAGES_REQUIRED', 'CONTENT_OBJECT_REQUIRED'].includes(reason.message) ? reason.message : 'CONTENT_JSON_INVALID')
      return
    }
    const estimatedMinutes = Number(form.estimated_minutes)
    if (!Number.isInteger(estimatedMinutes) || estimatedMinutes < 1) {
      setFormError('ESTIMATED_MINUTES_INVALID')
      return
    }
    const payload: AdminLessonInput = {
      school_stage: form.school_stage,
      title: form.title.trim(), source: form.source.trim(), difficulty: form.difficulty.trim(),
      estimated_minutes: estimatedMinutes, summary: form.summary.trim(),
      textbook_tags: lines(form.textbook_tags), theme: form.theme.trim(),
      accumulation_points: lines(form.accumulation_points), reasoning_points: lines(form.reasoning_points),
      reasoning_level: form.reasoning_level.trim(), content,
    }
    const submission: PendingEditorial = activeId === 'new' ? { kind: 'create', form: { ...form }, payload } : { kind: 'update', lessonId: activeId, version: selectedLesson!.review!.content_version, form: { ...form }, payload }
    const checkpoint = authResponseCheckpoint()
    operationLock.current = true; onExitRiskChange('working'); setSaving(true)
    try {
      const response = activeId === 'new'
        ? await adminLessonApi.create(payload)
        : await adminLessonApi.update(activeId, payload, selectedLesson!.review!.content_version)
      checkpoint()
      if (!alive.current) return
      if (submission.kind === 'create' && !validateResponse('/api/v1/admin/lessons', response, 'POST')) throw new RequestError('INVALID_RESPONSE', 200)
      if (submission.kind === 'update' && (!validateResponse(`/api/v1/admin/lessons/${encodeURIComponent(submission.lessonId)}`, response, 'PATCH') || response.lesson.id !== submission.lessonId || response.lesson.title !== payload.title || response.lesson.source !== payload.source || response.lesson.school_stage !== payload.school_stage)) throw new RequestError('INVALID_RESPONSE', 200)
      const nextForm = contentFormFromLesson(response.lesson)
      setLessons((current) => {
        const withoutSaved = current.filter((lesson) => lesson.id !== response.lesson.id)
        return [...withoutSaved, response.lesson]
      })
      setActiveId(response.lesson.id)
      setEditingLesson(response.lesson)
      setForm(nextForm)
      setSavedForm(nextForm)
      setSuccess(activeId === 'new' ? '草稿已创建。核对两阶段的原文与来源后，请审核当前版本。' : response.lesson.status === 'DRAFT' ? '修改已保存。草稿需重新审核后发布，学生已有训练不受影响。' : '修改已保存，资料版本未变化。')
    } catch (reason) {
      try { checkpoint() } catch { return }
      if (uncertainEditorialWrite(reason) && alive.current) {
        pendingRef.current = submission; setPending(submission); setCheckList(null); setCheckDetail(null); setCheckError(null); setReleasedNotice(false)
        onExitRiskChange('uncertain')
      }
      setFormError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { operationLock.current = false; if (alive.current) onExitRiskChange(pendingRef.current ? 'uncertain' : dirty ? 'dirty' : null); setSaving(false) }
  }

  const publish = async () => {
    if (operationLock.current || pendingRef.current || !activeId || activeId === 'new' || dirty || selectedLesson?.review?.status !== 'APPROVED' || !selectedLesson.review.content_version) return
    const submission: PendingEditorial = { kind: 'publish', lessonId: activeId, version: selectedLesson.review.content_version, form: { ...form } }
    const checkpoint = authResponseCheckpoint()
    operationLock.current = true; onExitRiskChange('working')
    setPublishing(true); setFormError(null); setSuccess(null)
    try {
      const response = await adminLessonApi.publish(activeId, selectedLesson.review.content_version)
      checkpoint()
      if (!alive.current) return
      if (!validateResponse(`/api/v1/admin/lessons/${encodeURIComponent(submission.lessonId)}/publish`, response, 'POST') || response.lesson.id !== submission.lessonId || response.lesson.status !== 'PUBLISHED' || response.lesson.review?.content_version !== submission.version) throw new RequestError('INVALID_RESPONSE', 200)
      setEditingLesson(response.lesson)
      setLessons((current) => current.map((lesson) => lesson.id === response.lesson.id ? response.lesson : lesson))
      setForm(contentFormFromLesson(response.lesson))
      setSavedForm(contentFormFromLesson(response.lesson))
      setSuccess('关卡已发布，现在会出现在对应学段的学习目录中。')
    } catch (reason) {
      try { checkpoint() } catch { return }
      if (uncertainEditorialWrite(reason) && alive.current) {
        pendingRef.current = submission; setPending(submission); setCheckList(null); setCheckDetail(null); setCheckError(null); setReleasedNotice(false)
        onExitRiskChange('uncertain')
      }
      setFormError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { operationLock.current = false; if (alive.current) onExitRiskChange(pendingRef.current ? 'uncertain' : dirty ? 'dirty' : null); setPublishing(false) }
  }

  // Keep the detail version bound to its visible form. Refreshing the list must
  // not silently approve a different version that this editor has not loaded.
  const selectedLesson = editingLesson?.id === activeId ? editingLesson : null
  const dirty = activeId === 'new' ? JSON.stringify(form) !== JSON.stringify(emptyContentForm()) : JSON.stringify(form) !== JSON.stringify(savedForm)
  const working = saving || reviewing || publishing || detailLoading || checking
  // The original blocking confirm could not outlive its draft. Bind the async
  // modal to the visible draft and work state so a stale acceptance cannot discard it.
  const contentConfirmation = useConfirmationDialog(JSON.stringify([activeId, form, savedForm, editingLesson?.review?.content_version, reviewer, reviewNote, working, pending]))
  const requestContentChange = (action: () => void, message: string) => {
    if (working || operationLock.current || pendingRef.current) return
    if (!dirty) { action(); return }
    contentConfirmation.ask({ title: '保留当前修改？', message, confirmLabel: '放弃修改并继续', onConfirm: action })
  }
  useLayoutEffect(() => {
    onExitRiskChange(working ? 'working' : pending ? 'uncertain' : dirty ? 'dirty' : null)
    return () => onExitRiskChange(null)
  }, [working, pending, dirty, onExitRiskChange])
  const reviewStatus = selectedLesson?.review?.status
  const reviewLabel = dirty ? '有未保存修改，请先保存后审核' : reviewStatus === 'APPROVED' ? '当前版本已审核' : reviewStatus === 'STALE' ? '资料已变化，需重新审核' : '尚未审核'
  const review = async () => {
    if (operationLock.current || pendingRef.current || !activeId || activeId === 'new' || dirty || !reviewer.trim() || !selectedLesson?.review?.content_version) return
    const submission: PendingEditorial = { kind: 'review', lessonId: activeId, version: selectedLesson.review.content_version, reviewer: reviewer.trim(), note: reviewNote.trim(), form: { ...form } }
    operationLock.current = true; onExitRiskChange('working'); setReviewing(true); setFormError(null); setSuccess(null)
    try {
      const response = await adminLessonApi.review(activeId, reviewer.trim(), reviewNote.trim(), selectedLesson.review.content_version)
      if (!validateResponse(`/api/v1/admin/lessons/${encodeURIComponent(activeId)}/review`, response, 'POST') ||
          response.lesson.id !== submission.lessonId || response.lesson.review?.content_version !== submission.version ||
          response.lesson.review?.reviewer !== submission.reviewer || response.lesson.review?.note !== submission.note) throw new RequestError('INVALID_RESPONSE', 200)
      const nextForm = contentFormFromLesson(response.lesson)
      setEditingLesson(response.lesson)
      setLessons(current => current.map(lesson => lesson.id === response.lesson.id ? response.lesson : lesson))
      setForm(nextForm); setSavedForm(nextForm)
      setSuccess('已记录本地教研审核。请确认当前版本后，再点击发布关卡。')
    } catch (reason) {
      if (uncertainEditorialWrite(reason) && alive.current) {
        pendingRef.current = submission; setPending(submission); setCheckList(null); setCheckDetail(null); setCheckError(null); setReleasedNotice(false)
        onExitRiskChange('uncertain')
      }
      setFormError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    }
    finally { operationLock.current = false; if (alive.current) onExitRiskChange(pendingRef.current ? 'uncertain' : dirty ? 'dirty' : null); setReviewing(false) }
  }
  const checkPending = async (lessonId?: string) => {
    const target = pendingRef.current
    if (!target || checkLock.current || operationLock.current) return
    if (target.kind !== 'create' && lessonId && lessonId !== target.lessonId) return
    if (target.kind === 'create' && lessonId && !checkList?.some(item => item.id === lessonId)) return
    const checkpoint = authResponseCheckpoint()
    const current = () => { try { checkpoint(); return alive.current && pendingRef.current === target } catch { return false } }
    checkLock.current = true; onExitRiskChange('working'); setChecking(true); setCheckError(null); setCheckDetail(null)
    try {
      if (target.kind === 'create' && !lessonId) {
        const response = await adminLessonApi.list()
        if (current()) setCheckList(response.lessons)
      } else {
        const id = target.kind !== 'create' ? target.lessonId : lessonId!
        const response = await adminLessonApi.get(id)
        if (response.lesson.id !== id) throw new RequestError('INVALID_RESPONSE', 200)
        if (current()) setCheckDetail(response.lesson)
      }
    } catch (reason) {
      if (current()) setCheckError(errorMessage(reason))
    } finally {
      checkLock.current = false
      if (current()) { setChecking(false); onExitRiskChange('uncertain') }
    }
  }
  const endPending = () => {
    const target = pendingRef.current
    if (!target || checkLock.current || operationLock.current) return
    const checkpoint = authResponseCheckpoint()
    contentConfirmation.ask({
      title: '结束未确认操作的核对？',
      message: '当前读取无法证明这次操作是否保存，也可能在读取后才保存。结束不会撤销服务器写入；以后重新提交可能产生重复。请先复制需要保留的草稿和核对线索。',
      confirmLabel: '了解风险，结束核对',
      onConfirm: () => {
        try { checkpoint() } catch { return }
        if (!alive.current || pendingRef.current !== target || checkLock.current || operationLock.current) return
        pendingRef.current = null; setPending(null); setCheckList(null); setCheckDetail(null); setCheckError(null); setFormError(null); setReleasedNotice(true)
        onExitRiskChange(dirty ? 'dirty' : null)
      },
    })
  }
  const errorLabels: Record<string, string> = { LESSON_REVIEW_REQUIRED: '当前版本尚未审核，请先核对来源并审核。', LESSON_REVIEW_NOT_READY: '来源或训练资料不完整，请按下方检查项补齐后保存。', CONTENT_JSON_INVALID: '训练 JSON 格式有误，请检查引号、括号和逗号。', CONTENT_STAGES_REQUIRED: '请同时填写 CORE 和 TRANSFER；仅建立课程骨架时可将两者都留空。', CONTENT_OBJECT_REQUIRED: '每个阶段的 JSON 必须是对象，不能是数组、文字或空值。', LESSON_CONTENT_INVALID: '题目字段不完整：请核对题文、目标词、证据、正确答案及选项。', LESSON_READING_CONTEXT_INVALID: '阅读资料格式有误，paragraphs 必须是非空段落数组。', ESTIMATED_MINUTES_INVALID: '预计时长必须是大于 0 的整数。', REQUEST_FAILED: '请求未完成，请检查必填字段或稍后重试。' }
  Object.assign(errorLabels, { LESSON_REVIEW_VERSION_CONFLICT: '资料已在其他页面修改，不能审核未读的新版本。请重新读取并核对。', LESSON_PUBLISH_VERSION_CONFLICT: '资料版本已变化，不能发布旧页面所见版本。请重新读取并核对。', LESSON_EDIT_VERSION_CONFLICT: '其他页面已修改此课程；本次未覆盖新版本。请先复制自己的修改，再重新读取。' })
  for (const code of ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE', 'SERVER_UNAVAILABLE']) errorLabels[code] = errorMessage(code)
  const versionConflict = ['LESSON_REVIEW_VERSION_CONFLICT', 'LESSON_PUBLISH_VERSION_CONFLICT', 'LESSON_EDIT_VERSION_CONFLICT'].includes(formError ?? '')
  return (
    <><main className="content-admin-page">
      <header className="admin-heading">
        <div><p className="eyebrow">教研工作台</p><h1>来源有据，<br />版本可追溯。</h1><p>保存草稿 → 核对来源并审核 → 发布当前版本。已发布课程修改后，需重新审核。</p></div>
        <button className="button button-primary" onClick={openNew} disabled={working || !!pending}>创建新关卡 <span aria-hidden="true">+</span></button>
      </header>
      <div className="admin-workspace">
        <aside className="admin-list" aria-label="关卡列表">
          <div className="admin-list-title"><b>全部关卡</b><button className="text-button" onClick={() => { if (!pendingRef.current && !operationLock.current) void loadLessons() }} disabled={loading || !!pending || working}>刷新</button></div>
          {loading ? <p className="admin-state">正在读取关卡…</p> : listError ? <div className="admin-state" role="alert"><b>无法读取关卡。</b><p>错误代码：{listError}</p><button className="text-button" onClick={() => void loadLessons()}>重新读取 →</button></div> : lessons.length === 0 ? <p className="admin-state">还没有教研关卡。创建第一份草稿开始编辑。</p> : <div className="admin-lesson-list">
            {lessons.map((lesson) => <button key={lesson.id} disabled={working || !!pending} className={activeId === lesson.id ? 'selected' : ''} onClick={() => void openLesson(lesson.id)}><span className={`status-badge ${lesson.status === 'PUBLISHED' ? 'published' : ''}`}>{lesson.status === 'PUBLISHED' ? '已发布' : '草稿'} · {lesson.review?.status === 'APPROVED' ? '已审核' : lesson.review?.status === 'STALE' ? '审核失效' : '待审核'}</span><strong>{lesson.title}</strong><small>{lesson.school_stage === 'JUNIOR' ? '初中' : '高中'} · {lesson.source}</small></button>)}
          </div>}
        </aside>
        <section className="admin-editor" aria-live="polite">
          {!activeId ? <div className="admin-placeholder">{formError && <p role="alert" className="request-error">关卡详情读取失败，请重新选择课程。（{formError}）</p>}<p className="eyebrow">内容管理</p><h2>选择一份关卡，<br />或新建草稿。</h2><p>这里记录课程的学习对象、教材位置、关键积累与推理路径。</p><button className="button button-primary" onClick={openNew}>创建新关卡 <span aria-hidden="true">→</span></button></div> : detailLoading ? <p className="admin-state">正在读取关卡详情…</p> : <form className="lesson-editor-form" onSubmit={submit}>
            {pending && <section className="editor-review" role="alert" aria-label="未确认操作核对">
              <h2>提交结果尚未确认</h2>
              <p>上次{pending.kind === 'create' ? '创建草稿' : pending.kind === 'review' ? '审核签署' : pending.kind === 'update' ? '保存修改' : '发布课程'}可能已经保存，也可能尚未保存。系统没有自动重试；请先复制草稿并读取当前信息核对。离开或刷新会丢失本页核对线索，不会撤销服务器写入。</p>
              <p>读取仅显示当前快照，不能证明本次提交是否成功；原请求也可能在读取后才保存。结束核对后再次提交可能产生重复。</p>
              <details><summary>复制本次草稿及核对线索</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(pending, null, 2)}</pre></details>
              <button type="button" className="button button-secondary" disabled={checking} onClick={() => void checkPending()}>{checking ? '正在读取…' : pending.kind === 'create' ? '读取课程列表核对' : '读取当前课程核对'}</button>
              {checkError && <p role="status">读取失败：{checkError}。结果仍未确认，可重新读取。</p>}
              {checkList && <div><p>以下为当前课程列表，仅供人工核对，不能确定哪项由本次操作产生。</p>{checkList.length === 0 ? <p>当前列表为空，也不能证明原请求未保存。</p> : <ul>{checkList.map(item => <li key={item.id}>{item.title} · {item.source} · {item.status} · {item.id} <button type="button" disabled={checking} onClick={() => void checkPending(item.id)}>读取该课程详情</button></li>)}</ul>}</div>}
              {checkDetail && <details open><summary>当前课程快照（并非提交回执）</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(checkDetail, null, 2)}</pre></details>}
              <button type="button" className="button button-secondary" disabled={checking} onClick={endPending}>结束本次核对</button>
            </section>}
            {releasedNotice && <p role="status">此前提交结果仍未知。结束核对没有撤销服务器写入；再次提交可能产生重复，请先核实。</p>}
            <div className="editor-topline"><div><p className="eyebrow">{activeId === 'new' ? '新建草稿' : selectedLesson?.status === 'PUBLISHED' ? '已发布关卡' : '草稿关卡'}{dirty && ' · 有未保存修改'}</p><h2>{activeId === 'new' ? '建立课程骨架' : form.title || '未命名关卡'}</h2></div>{activeId !== 'new' && <button type="button" className="button button-secondary" onClick={publish} disabled={working || !!pending || dirty || reviewStatus !== 'APPROVED' || selectedLesson?.status === 'PUBLISHED'}>{selectedLesson?.status === 'PUBLISHED' ? '已发布' : publishing ? '正在发布…' : '发布关卡'}</button>}</div>
            {activeId !== 'new' && <section className="editor-review" aria-label="资料版本与教研审核">
              <div className="review-version-line"><strong>{reviewLabel}</strong><span>版本 {selectedLesson?.review?.content_version ?? '读取中'}</span></div>
              <p>本地审核是署名记录，不代表已接入账号认证。请实际核对原文、题源、词义、选项与提示；系统只检查资料结构和版本一致性。</p>
              {selectedLesson?.review?.reviewer && <p>最近审核：{selectedLesson.review.reviewer}{selectedLesson.review.reviewed_at && ` · ${new Date(selectedLesson.review.reviewed_at).toLocaleString('zh-CN')}`}。{selectedLesson.review.note}</p>}
              {!!selectedLesson?.review?.issues?.length && <div className="review-issues"><b>发布前检查</b><ul>{selectedLesson.review.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div>}
              <div className="review-signoff"><label>审核人<input maxLength={80} value={reviewer} disabled={working || !!pending} onChange={event => { if (!pendingRef.current && !operationLock.current) setReviewer(event.target.value) }} placeholder="填写实际审核人的署名" /></label><label>审核说明<textarea maxLength={2000} value={reviewNote} disabled={working || !!pending} onChange={event => { if (!pendingRef.current && !operationLock.current) setReviewNote(event.target.value) }} placeholder="例如：核对原文版本、题源和词义注释" /></label></div>
              <button type="button" className="button button-secondary" disabled={working || !!pending || dirty || !reviewer.trim() || !!selectedLesson?.review?.issues?.length} onClick={review}>{reviewing ? '正在记录审核…' : '确认审核当前版本'}</button>
              {dirty && <p>请先保存修改，再审核和发布，避免审核到旧版本。</p>}
            </section>}
            <fieldset className="editor-section" disabled={working || !!pending}><legend>课程定位</legend><div className="field-grid"><label>学段<select value={form.school_stage} onChange={(event) => setField('school_stage', event.target.value as SchoolStage)}><option value="JUNIOR">初中</option><option value="SENIOR">高中</option></select></label><label>教材标签（用逗号分隔）<input value={form.textbook_tags} onChange={(event) => setField('textbook_tags', event.target.value)} placeholder="部编版, 七年级上册" /></label><label>主题<input value={form.theme} onChange={(event) => setField('theme', event.target.value)} placeholder="语境推断" /></label></div></fieldset>
            <fieldset className="editor-section" disabled={working || !!pending}><legend>关卡信息</legend><div className="field-grid"><label className="span-two">题目<input required value={form.title} onChange={(event) => setField('title', event.target.value)} placeholder="例如：从人物关系推断词义" /></label><label>出处<input required value={form.source} onChange={(event) => setField('source', event.target.value)} placeholder="《陈涉世家》" /></label><label>难度<input required value={form.difficulty} onChange={(event) => setField('difficulty', event.target.value)} placeholder="进阶" /></label><label>预计时长（分钟）<input required min="1" type="number" inputMode="numeric" value={form.estimated_minutes} onChange={(event) => setField('estimated_minutes', event.target.value)} /></label><label className="span-two">学习摘要<textarea required value={form.summary} onChange={(event) => setField('summary', event.target.value)} placeholder="说明本关要完成的理解与推断任务。" /></label></div></fieldset>
            <fieldset className="editor-section" disabled={working || !!pending}><legend>教研标注</legend><div className="field-grid"><label>积累点（每行一项）<textarea value={form.accumulation_points} onChange={(event) => setField('accumulation_points', event.target.value)} placeholder="实词义项\n人物关系" /></label><label>推理点（每行一项）<textarea value={form.reasoning_points} onChange={(event) => setField('reasoning_points', event.target.value)} placeholder="从人物动作寻找依据\n排除不合语境的义项" /></label><label className="span-two">推理层级<input value={form.reasoning_level} onChange={(event) => setField('reasoning_level', event.target.value)} placeholder="如：语境定位 → 关系推断 → 回溯验证" /></label></div></fieldset>
            <fieldset className="editor-section" disabled={working || !!pending}><legend>训练内容</legend><p className="field-note">CORE 与 TRANSFER 均需提供原文、题目和 reading_context；其中填写 paragraphs、source_url、text_version、author、era 和材料范围 extent。全文与节选必须如实标注。</p><div className="field-grid"><label>CORE（核心训练 JSON）<textarea className="code-input" value={form.core_content} onChange={(event) => setField('core_content', event.target.value)} placeholder={'{\n  "passage": "…"\n}'} /></label><label>TRANSFER（迁移训练 JSON）<textarea className="code-input" value={form.transfer_content} onChange={(event) => setField('transfer_content', event.target.value)} placeholder={'{\n  "passage": "…"\n}'} /></label></div></fieldset>
            <EditorialSources core={form.core_content} transfer={form.transfer_content} />
            {versionConflict && activeId && activeId !== 'new' && <button type="button" className="button button-secondary" disabled={working || !!pending} onClick={() => void openLesson(activeId)}>重新读取当前课程</button>}
            <div className="editor-actions"><button className="button button-primary" disabled={working || !!pending}>{saving ? '正在保存…' : activeId === 'new' ? '保存草稿' : '保存修改'} <span aria-hidden="true">→</span></button>{formError && !pending && <p className="request-error" role="alert">操作未完成：{errorLabels[formError] ?? formError}</p>}{success && <p className="request-success" role="status">{success}</p>}</div>
          </form>}
        </section>
      </div>
    </main>{contentConfirmation.modal}</>
  )
}

function EmptyPage({ onHome }: { onHome: () => void }) {
  return (
    <main className="empty-page" aria-labelledby="empty-title">
      <p className="eyebrow">训练状态未加载</p>
      <h1 id="empty-title">这一页暂时没有<br />可显示的训练。</h1>
      <p className="intro">返回今日训练后，可以重新开始或从“复习”中继续此前的记录。</p>
      <button className="button button-primary" onClick={onHome}>返回今日训练 <span aria-hidden="true">→</span></button>
    </main>
  )
}


function TrainingPage(props: Omit<GuidedTrainingProps, 'renderSummary'>) {
  return <GuidedTrainingPage {...props} renderSummary={summary => <LessonSummary summary={summary} onReturnHome={props.onReturnHome} />} />
}

function LessonSummary({ summary, onReturnHome }: { summary: NonNullable<TrainingSession['summary']>; onReturnHome: () => void }) {
  return (
    <section className="lesson-summary" aria-labelledby="summary-title">
      <header className="waterink-page-heading waterink-summary-heading">
      <p className="stage-label">本关总结</p>
      <h1 id="summary-title" tabIndex={-1}>词义判断已完成，<br />再回看推理路径。</h1>
      </header>
      <div className="summary-lines">
        <article><b>积累</b><p>{summary.accumulation}</p></article>
        <article><b>推理</b><p>{summary.reasoning}</p></article>
      </div>
      <div className="earned-points" aria-label={`本关获得 ${summary.earned_points} 点`}>+{summary.earned_points}<span>知行</span></div>
      <button className="button button-primary" onClick={onReturnHome}>返回今日训练 <span aria-hidden="true">→</span></button>
    </section>
  )
}

function SkillsPage({ summary, loading, error, onRetry, onStart }: {
  summary: LearningSummary | null; loading: boolean; error: string | null; onRetry: () => void; onStart: () => void
}) {
  const skills = summary?.skill_statistics ?? []
  return (
    <main className="skills-page">
      <header className="waterink-page-heading">
      <p className="eyebrow">能力地图</p>
      <h1>把每一次判断，<br />留下可回看的路径。</h1>
      <p className="intro">这里展示实际作答事件中的词义判断记录，不再按完成关卡数推算能力。判断正确率不等同于完整推理能力测评。</p>
      </header>
      <section className="skill-list" aria-label="当前能力">
        {loading ? <p role="status">正在读取实际判断记录…</p> : error ? <div role="alert"><p>判断记录暂时未能读取。</p><button className="text-button" onClick={onRetry}>重新读取</button></div> : skills.length === 0 ? <div className="catalog-state"><b>还没有足够的判断记录。</b><p>完成作答后，这里会逐项显示真实样本，不把未知能力显示成零分。</p></div> : skills.map(skill => (
          <article className="skill-row" key={skill.label}>
            <div><strong>{skill.label}</strong><p>{skill.attempts} 次判断记录{skill.attempts < 5 ? ' · 样本较少，仅供回看' : ' · 建议结合证据与迁移表现回看'}</p></div>
            <div className="meter" aria-label={`${skill.label} 判断正确率 ${normalizedAccuracy(skill.accuracy)}%`}><i style={{ width: `${normalizedAccuracy(skill.accuracy)}%` }} /></div>
            <b>{normalizedAccuracy(skill.accuracy)}<small>%</small></b>
          </article>
        ))}
      </section>
      <button className="button button-primary" onClick={onStart}>选择文章，继续训练 <span aria-hidden="true">→</span></button>
    </main>
  )
}

function DualAdminWorkbench({ supportAllowed, onExitRiskChange, children }: { supportAllowed: boolean; onExitRiskChange: (risk: ExitRisk) => void; children: (callback: (risk: ExitRisk) => void) => React.ReactNode }) {
  const [tab, setTab] = useState<'editorial' | 'support'>('editorial')
  const risk = useRef<ExitRisk>(null)
  const supportAccess = useRef(supportAllowed)
  supportAccess.current = supportAllowed
  const confirmation = useConfirmationDialog(supportAllowed ? 'admin-areas' : null)
  const [notice, setNotice] = useState('')
  const report = useCallback((next: ExitRisk) => { risk.current = next; onExitRiskChange(next) }, [onExitRiskChange])
  if (!supportAllowed && tab === 'support') setTab('editorial')
  const active = supportAllowed && tab === 'support' ? 'support' : 'editorial'
  const change = (next: 'editorial' | 'support') => {
    if (next === active || (next === 'support' && !supportAllowed)) return
    if (risk.current === 'working') { setNotice('请等待当前操作完成，不能切换工作台。'); return }
    const expectedRisk = risk.current
    const leave = () => { if (next === 'support' && !supportAccess.current) return; if (risk.current === 'working') { setNotice('请等待当前操作完成。'); return }; if (risk.current !== expectedRisk) { setNotice('当前操作状态已变化，请重新选择工作台并确认。'); return }; report(null); setNotice(''); setTab(next) }
    if (risk.current) { confirmation.ask({ title: risk.current === 'uncertain' ? '离开未确认操作？' : '放弃未保存修改？', message: risk.current === 'uncertain' ? '上次写入可能已在服务端完成。离开会丢失本页的草稿与核对线索；请先复制并核对当前记录。此操作不撤销服务端写入。' : '请先复制需要保留的修改和说明。确认后切换工作台，当前草稿将丢失。', confirmLabel: '确认离开工作台', onConfirm: leave }); return }
    leave()
  }
  return <>{confirmation.modal}{supportAllowed && <nav className="editor-tabs" aria-label="管理区域"><button type="button" aria-pressed={active === 'editorial'} onClick={() => change('editorial')}>教研工作台</button><button type="button" aria-pressed={active === 'support'} onClick={() => change('support')}>用户反馈</button></nav>}{supportAllowed && notice && <p role="status">{notice}</p>}{active === 'support' ? <main className="content-admin-page"><SupportInbox onRiskChange={report} /></main> : children(report)}</>
}

export function App() {
  return <AuthBoundary fallbackFooter={<BetaSupportPanel />}>{(auth, onLogout) => <><ProductTourBoundary session={auth} onLogout={onLogout}><LearningApp key={`${auth.mode}:${auth.user?.id ?? 'local'}`} auth={auth} onLogout={onLogout} /></ProductTourBoundary><BetaSupportPanel session={auth} /></>}</AuthBoundary>
}

function LearningApp({ auth, onLogout }: { auth: AuthSession; onLogout: () => Promise<void> }) {
  const inkMotion = useInkMotion()
  const { replayTour } = useProductTour()
  const adminAllowed = canManage(auth) || canManageSupport(auth)
  const initialProfile = useRef(auth.mode === 'invite' ? auth.profile_id : undefined)
  const shell = useRef<HTMLDivElement>(null)
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const logoutLock = useRef(false)
  const exitRisk = useRef<ExitRisk>(null)
  const createPendingRef = useRef<{ profileId: string; lessonId: string; previousRisk: ExitRisk } | null>(null)
  const profilePendingRef = useRef<{ displayName: string; schoolStage: SchoolStage; previousRisk: ExitRisk } | null>(null)
  const { route, page, setPage, navigationModal } = usePageRoute(exitRisk)
  const logoutConfirmation = useConfirmationDialog(auth.user?.id ?? auth.mode)
  const startConfirmation = useConfirmationDialog(auth.user?.id ?? auth.mode)
  const onExitRiskChange = useCallback((risk: ExitRisk) => { exitRisk.current = createPendingRef.current || profilePendingRef.current ? (risk === 'working' ? 'working' : 'uncertain') : risk }, [])
  const [profile, setProfile] = useState<LearnerProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(true)
  const [profileLoadAttempt, setProfileLoadAttempt] = useState(0)
  const [profileLoadError, setProfileLoadError] = useState<string | null>(null)
  const [reviewSessions, setReviewSessions] = useState<ReviewSession[]>([])
  const [reviewsLoading, setReviewsLoading] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewReadAttempt, setReviewReadAttempt] = useState(0)
  const [mistakes, setMistakes] = useState<Mistake[]>([])
  const [mistakesLoading, setMistakesLoading] = useState(false)
  const [mistakesError, setMistakesError] = useState<string | null>(null)
  const [practiceGroupBy, setPracticeGroupBy] = useState<PracticePlanGroupBy>('theme')
  const [practicePlans, setPracticePlans] = useState<PracticePlan[]>([])
  const [practiceLoading, setPracticeLoading] = useState(false)
  const [practiceError, setPracticeError] = useState<string | null>(null)
  const practiceRequest = useRef(0)
  const [learningSummary, setLearningSummary] = useState<LearningSummary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [achievements, setAchievements] = useState<Achievements | null>(null)
  const [achievementsLoading, setAchievementsLoading] = useState(false)
  const [achievementsError, setAchievementsError] = useState<string | null>(null)
  const [dailyMission, setDailyMission] = useState<DailyMission | null>(null)
  const [missionLoading, setMissionLoading] = useState(false)
  const [missionError, setMissionError] = useState<string | null>(null)
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [lessonsLoading, setLessonsLoading] = useState(false)
  const [lessonsError, setLessonsError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [session, setSession] = useState<TrainingSession | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingCommand, setPendingCommand] = useState<CommandType | null>(null)
  const [trainingDirty, setTrainingDirty] = useState(false)
  const [uncertainCommand, setUncertainCommand] = useState<PendingTrainingCommand | null>(null)
  const operationLock = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [routeSessionLoading, setRouteSessionLoading] = useState(false)
  const [routeSessionError, setRouteSessionError] = useState<string | null>(null)
  const [routeSessionAttempt, setRouteSessionAttempt] = useState(0)
  const latestReads = useRef({ mistakes: 0, sessions: 0, summary: 0, achievements: 0, mission: 0, lessons: 0 })
  const mounted = useRef(true)
  const commandOwner = useRef<symbol | null>(null)
  const commandContext = useRef({ sessionId, session, profileId: profile?.id ?? null, page, routeSessionId: route.sessionId })
  commandContext.current = { sessionId, session, profileId: profile?.id ?? null, page, routeSessionId: route.sessionId }
  const uncertainIntent = useRef(uncertainCommand)
  uncertainIntent.current = uncertainCommand
  useEffect(() => {
    mounted.current = true
    const warn = (event: BeforeUnloadEvent) => { if (createPendingRef.current || profilePendingRef.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => { mounted.current = false; setCreationWritesBlocked(false); window.removeEventListener('beforeunload', warn) }
  }, [])
  const [createPending, setCreatePending] = useState<{ profileId: string; lessonId: string; previousRisk: ExitRisk } | null>(null)
  const [createSessions, setCreateSessions] = useState<ReviewSession[] | null>(null)
  const [createReadError, setCreateReadError] = useState<string | null>(null)
  const [createChecking, setCreateChecking] = useState(false)
  const createReadLock = useRef(false)
  const [profilePending, setProfilePending] = useState<typeof profilePendingRef.current>(null)
  const [profileCheck, setProfileCheck] = useState<LearnerProfile | 'none' | 'unavailable' | null>(null)
  const [profileCheckError, setProfileCheckError] = useState<string | null>(null)
  const [profileChecking, setProfileChecking] = useState(false)
  const profileReadLock = useRef(false)
  useEffect(() => {
    if (createPendingRef.current && createPendingRef.current.profileId !== profile?.id) {
      createPendingRef.current = null; setCreatePending(null); setCreateSessions(null); setCreateReadError(null)
      if (!profilePendingRef.current) setCreationWritesBlocked(false)
      if (exitRisk.current === 'uncertain') exitRisk.current = null
    }
  }, [profile?.id])


  useEffect(() => {
    if (shouldLeaveOnboarding(page, !!profile)) setPage('home', undefined, true)
  }, [page, profile?.id, setPage])

  useLayoutEffect(() => { if (shell.current) shell.current.inert = logoutBusy }, [logoutBusy])
  const logout = async (confirmed = false) => {
    if (logoutLock.current) return
    if (exitRisk.current === 'working' || busy) { logoutConfirmation.ask({ title: '操作仍在进行', message: '请等待结果返回后退出。当前页面暂时保留。', confirmLabel: '继续等待', onConfirm: () => {} }); return }
    if (exitRisk.current && !confirmed) { logoutConfirmation.ask({ title: '确认退出登录？', message: '当前有未保存的输入或结果尚未确认的提交。退出会清空临时输入，已确认记录保留在账号中。', confirmLabel: '放弃临时输入并退出', onConfirm: () => void logout(true) }); return }
    logoutLock.current = true; setLogoutBusy(true); setLogoutError(null)
    try { await onLogout() }
    catch (reason) { setLogoutError(`退出未确认：${errorMessage(reason)}。本页暂时保留，请重试退出或重新读取登录状态。`) }
    finally { logoutLock.current = false; setLogoutBusy(false) }
  }

  useLayoutEffect(() => {
    if (pendingCommand || busy) exitRisk.current = 'working'
    else if (createPendingRef.current || profilePendingRef.current || (uncertainCommand && page === 'training' && uncertainCommand.sessionId === sessionId)) exitRisk.current = 'uncertain'
    else if (page !== 'admin' && page !== 'assessment' && page !== 'home') exitRisk.current = page === 'training' && trainingDirty ? 'dirty' : null
  }, [pendingCommand, busy, uncertainCommand, sessionId, page, trainingDirty])

  useEffect(() => {
    document.title = `${pageLabels[page]} · 文言·推理`
    const frame = requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'auto' })
      const main = document.querySelector<HTMLElement>('.page-view main')
      if (main) { main.tabIndex = -1; (main.querySelector<HTMLElement>('#render-error-title') ?? main).focus({ preventScroll: true }) }
    })
    return () => cancelAnimationFrame(frame)
  }, [page, route.sessionId, profileLoading])

  useEffect(() => {
    let cancelled = false
    setProfileLoading(true); setProfileLoadError(null)
    const storedProfileId = initialProfile.current === undefined ? window.localStorage.getItem('wenyan.profile-id') : initialProfile.current
    if (!storedProfileId) {
      setProfileLoading(false); if (!['admin', 'about'].includes(page)) setPage('onboarding', undefined, true)
      return () => { cancelled = true }
    }
    void (async () => {
      try {
        const { profile: nextProfile } = await profileApi.get(storedProfileId)
        if (cancelled) return
        setProfile(nextProfile)
        const initial = readRoute(location.hash)
        // A named page must survive refresh; only legacy root URLs resume automatically.
        if (location.hash && initial.page !== 'training') return
        let requestedSessionId = initial.sessionId
        const raw = window.localStorage.getItem('wenyan.active-session')
        try {
          if (!requestedSessionId && raw) {
            const saved = JSON.parse(raw) as { profileId?: string; sessionId?: string }
            if (saved.profileId === nextProfile.id) requestedSessionId = saved.sessionId
            else window.localStorage.removeItem('wenyan.active-session')
          }
          if (!requestedSessionId) { setPage('home', undefined, true); return }
          const response = await trainingApi.getSession(requestedSessionId)
          if (cancelled) return
          if (response.session.profile_id !== nextProfile.id) {
            setPage('review', undefined, true); return
          }
          window.localStorage.setItem('wenyan.active-session', JSON.stringify({ profileId: nextProfile.id, sessionId: requestedSessionId }))
          setSessionId(requestedSessionId); setSession(response.session); setPage('training', requestedSessionId, true)
        } catch (reason) {
          if (cancelled) return
          if (reason instanceof SyntaxError || (reason instanceof Error && reason.message === 'SESSION_NOT_FOUND')) window.localStorage.removeItem('wenyan.active-session')
          setError('上次训练暂未恢复，可在复习页重新打开；学习记录未被清除。')
          setPage('review', undefined, true)
        }
      } catch (reason) {
        if (cancelled) return
        if (reason instanceof Error && reason.message === 'PROFILE_NOT_FOUND') {
          window.localStorage.removeItem('wenyan.profile-id')
          window.localStorage.removeItem('wenyan.active-session')
          if (!['admin', 'about'].includes(readRoute(location.hash).page)) setPage('onboarding', undefined, true)
        } else setProfileLoadError('暂时无法连接学习服务，档案和训练入口已保留。请检查网络后重试；仍有问题可通过反馈与帮助联系内测负责人。')
      } finally { if (!cancelled) setProfileLoading(false) }
    })()
    return () => { cancelled = true }
  }, [profileLoadAttempt])

  useEffect(() => {
    if (profileLoading || !profile || page !== 'training' || !route.sessionId || route.sessionId === sessionId) {
      setRouteSessionLoading(false); setRouteSessionError(null)
      return
    }
    let cancelled = false
    setRouteSessionLoading(true); setRouteSessionError(null)
    trainingApi.getSession(route.sessionId).then(({ session: restored }) => {
      if (cancelled) return
      if (restored.profile_id !== profile.id) throw new Error('该训练不属于当前学习档案。')
      setSession(restored); setSessionId(route.sessionId!); setRouteSessionLoading(false)
    }).catch(() => { if (!cancelled) { setRouteSessionError('这次训练暂时无法读取。可以重试或返回复习页，已有记录不会被清除。'); setRouteSessionLoading(false) } })
    return () => { cancelled = true }
  }, [page, route.sessionId, sessionId, profile?.id, profileLoading, routeSessionAttempt])

  const createProfile = useCallback(async (displayName: string, schoolStage: SchoolStage) => {
    if (!mounted.current || operationLock.current || profile || profilePendingRef.current || createPendingRef.current || privateWritesAreSuspended()) return
    const checkpoint = authResponseCheckpoint(), previousRisk = exitRisk.current
    const current = () => { try { checkpoint(); return mounted.current && commandContext.current.profileId === null } catch { return false } }
    operationLock.current = true; exitRisk.current = 'working'; setBusy(true); setError(null)
    const markUnknown = () => {
      const pending = { displayName, schoolStage, previousRisk }
      setCreationWritesBlocked(true); profilePendingRef.current = pending; setProfilePending(pending); setProfileCheck(null); setProfileCheckError(null); exitRisk.current = 'uncertain'
      setError('档案创建结果尚未确认，请先核对当前账号资料；系统不会自动重复创建。')
    }
    try {
      const sent = profileApi.create(displayName, schoolStage); setCreationWritesBlocked(true)
      const response = await sent
      if (!current()) return
      if (privateWritesAreSuspended()) { markUnknown(); return }
      if (response.profile.display_name !== displayName || response.profile.school_stage !== schoolStage) throw new RequestError('INVALID_RESPONSE', 200)
      if (auth.mode === 'invite') initialProfile.current = response.profile.id
      window.localStorage.setItem('wenyan.profile-id', response.profile.id)
      if (!createPendingRef.current) setCreationWritesBlocked(false)
      operationLock.current = false; setBusy(false)
      setProfile(response.profile); exitRisk.current = previousRisk; setPage('home')
    } catch (reason) {
      if (!current()) return
      if (uncertainWrite(reason) || !(reason instanceof RequestError) || reason.status === 408 || reason.status === 429) markUnknown()
      else setError(errorMessage(reason))
    } finally {
      if (current()) { if (!profilePendingRef.current && !createPendingRef.current) setCreationWritesBlocked(false); if (exitRisk.current === 'working') exitRisk.current = previousRisk; setBusy(false); operationLock.current = false }
    }
  }, [profile, auth.mode, setPage])

  const checkCreatedProfile = async () => {
    const pending = profilePendingRef.current
    if (!pending || profileReadLock.current || privateWritesAreSuspended()) return
    const checkpoint = authResponseCheckpoint()
    const current = () => { try { checkpoint(); return mounted.current && profilePendingRef.current === pending && commandContext.current.profileId === null } catch { return false } }
    profileReadLock.current = true; setProfileChecking(true); setProfileCheckError(null); setProfileCheck(null)
    try {
      if (auth.mode !== 'invite') { if (current()) setProfileCheck('unavailable'); return }
      const result = await requestJson<unknown>(`${import.meta.env.VITE_API_ROOT ?? ''}/api/v1/auth/session`)
      if (!validAuthSession(result) || result.mode !== auth.mode || result.user?.id !== auth.user?.id || result.csrf_token !== auth.csrf_token || !result.authenticated) throw new RequestError('SESSION_CHANGED', 409)
      if (!current()) return
      if (!result.profile_id) { setProfileCheck('none'); return }
      const found = await profileApi.get(result.profile_id)
      if (current()) setProfileCheck(found.profile)
    } catch (reason) { if (current()) setProfileCheckError(errorMessage(reason)) }
    finally { profileReadLock.current = false; if (current()) setProfileChecking(false) }
  }
  const releaseCreatedProfile = () => {
    const pending = profilePendingRef.current
    if (!pending || profileReadLock.current || privateWritesAreSuspended()) return
    const checkpoint = authResponseCheckpoint()
    startConfirmation.ask({ title: '结束本次档案创建核对？', message: '原请求可能已经或稍后创建档案。结束核对不会撤销它；重新提交可能产生重复。请先核对当前账号资料。', confirmLabel: '了解风险，结束核对', onConfirm: () => {
      try { checkpoint() } catch { return }
      if (!mounted.current || profilePendingRef.current !== pending || commandContext.current.profileId !== null || privateWritesAreSuspended()) return
      profilePendingRef.current = null; setProfilePending(null); setProfileCheck(null); setProfileCheckError(null)
      if (!createPendingRef.current) setCreationWritesBlocked(false)
      if (exitRisk.current === 'uncertain') exitRisk.current = pending.previousRisk
      setError('此前档案创建结果仍未知；结束核对没有撤销原请求，再次提交可能重复。')
    } })
  }

  const loadMistakes = useCallback(async (profileId: string) => {
    const request = ++latestReads.current.mistakes
    setMistakesLoading(true); setMistakesError(null)
    try {
      const response = await profileApi.listMistakes(profileId)
      if (!mounted.current || request !== latestReads.current.mistakes) return
      setMistakes(response.mistakes)
    } catch (reason) {
      if (!mounted.current || request !== latestReads.current.mistakes) return
      setMistakes([])
      setMistakesError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { if (mounted.current && request === latestReads.current.mistakes) setMistakesLoading(false) }
  }, [])

  useEffect(() => {
    if (page !== 'review' || !profile) return
    const request = ++latestReads.current.sessions
    setReviewsLoading(true); setReviewError(null)
    profileApi.listSessions(profile.id)
      .then(({ sessions }) => { if (mounted.current && request === latestReads.current.sessions) setReviewSessions(sessions) })
      .catch((reason) => { if (mounted.current && request === latestReads.current.sessions) setReviewError(reason instanceof Error ? reason.message : 'REQUEST_FAILED') })
      .finally(() => { if (mounted.current && request === latestReads.current.sessions) setReviewsLoading(false) })
    void loadMistakes(profile.id)
    return () => { latestReads.current.sessions++; latestReads.current.mistakes++ }
  }, [page, profile?.id, loadMistakes, reviewReadAttempt])

  const loadPracticePlans = useCallback(async (profileId: string, groupBy: PracticePlanGroupBy) => {
    const request = ++practiceRequest.current
    setPracticeLoading(true); setPracticeError(null)
    try {
      const response = await profileApi.getPracticePlans(profileId, groupBy)
      if (mounted.current && request === practiceRequest.current) setPracticePlans(response.plans)
    } catch (reason) {
      if (mounted.current && request === practiceRequest.current) { setPracticePlans([]); setPracticeError(reason instanceof Error ? reason.message : 'REQUEST_FAILED') }
    } finally { if (mounted.current && request === practiceRequest.current) setPracticeLoading(false) }
  }, [])

  useEffect(() => {
    if (page === 'practice' && profile) void loadPracticePlans(profile.id, practiceGroupBy)
    return () => { practiceRequest.current++ }
  }, [page, profile, practiceGroupBy, loadPracticePlans])

  const loadLearningSummary = useCallback(async (profileId: string) => {
    const request = ++latestReads.current.summary
    setSummaryLoading(true); setSummaryError(null)
    try {
      const response = await profileApi.getLearningSummary(profileId)
      if (!mounted.current || request !== latestReads.current.summary) return
      setLearningSummary(response.summary)
    } catch (reason) {
      if (!mounted.current || request !== latestReads.current.summary) return
      setLearningSummary(null)
      setSummaryError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { if (mounted.current && request === latestReads.current.summary) setSummaryLoading(false) }
  }, [])

  const loadAchievements = useCallback(async (profileId: string) => {
    const request = ++latestReads.current.achievements
    setAchievementsLoading(true); setAchievementsError(null)
    try {
      const response = await profileApi.getAchievements(profileId)
      if (!mounted.current || request !== latestReads.current.achievements) return
      setAchievements(response)
    } catch (reason) {
      if (!mounted.current || request !== latestReads.current.achievements) return
      setAchievements(null)
      setAchievementsError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { if (mounted.current && request === latestReads.current.achievements) setAchievementsLoading(false) }
  }, [])

  const loadDailyMission = useCallback(async (profileId: string) => {
    const request = ++latestReads.current.mission
    setMissionLoading(true); setMissionError(null)
    try {
      const response = await profileApi.getDailyMission(profileId)
      if (!mounted.current || request !== latestReads.current.mission) return
      setDailyMission(response.mission)
    } catch (reason) {
      if (!mounted.current || request !== latestReads.current.mission) return
      setDailyMission(null)
      setMissionError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { if (mounted.current && request === latestReads.current.mission) setMissionLoading(false) }
  }, [])

  useEffect(() => {
    if (page === 'home' && profile) void loadDailyMission(profile.id)
    return () => { latestReads.current.mission++ }
  }, [page, profile, loadDailyMission])

  useEffect(() => {
    if ((page === 'report' || page === 'skills') && profile) {
      void loadLearningSummary(profile.id)
      if (page === 'report') void loadAchievements(profile.id)
    }
    return () => { latestReads.current.summary++; latestReads.current.achievements++ }
  }, [page, profile, loadLearningSummary, loadAchievements])

  const loadLessons = useCallback(async (schoolStage: SchoolStage) => {
    const request = ++latestReads.current.lessons
    setLessonsLoading(true); setLessonsError(null)
    try {
      const response = await lessonApi.list(schoolStage)
      if (!mounted.current || request !== latestReads.current.lessons) return
      setLessons(response.lessons)
    } catch (reason) {
      if (!mounted.current || request !== latestReads.current.lessons) return
      setLessons([])
      setLessonsError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { if (mounted.current && request === latestReads.current.lessons) setLessonsLoading(false) }
  }, [])

  useEffect(() => {
    if (profile) void loadLessons(profile.school_stage)
  }, [profile, loadLessons])

  const start = useCallback(async (lessonId: string, confirmed = false): Promise<void> => {
    if (!mounted.current || operationLock.current || createPendingRef.current || profilePendingRef.current || privateWritesAreSuspended()) return
    if (!profile) { setPage('onboarding'); return }
    if (commandContext.current.profileId !== profile.id) return
    if (exitRisk.current === 'working') { startConfirmation.ask({ title: '操作仍在进行', message: '请等待学习路线操作确认后，再开始其他练习。', confirmLabel: '继续等待', onConfirm: () => {} }); return }
    if (exitRisk.current && !confirmed) {
      const checkpoint = authResponseCheckpoint()
      startConfirmation.ask({ title: '离开学习路线？', message: '当前有未保存的选择或结果未确认的提交。可以保留当前状态，或离开并开始已有课程；不会自动重试旧提交。', confirmLabel: '开始已有课程', onConfirm: () => { try { checkpoint() } catch { return }; if (mounted.current) void start(lessonId, true) } }); return
    }
    const previousRisk = exitRisk.current, checkpoint = authResponseCheckpoint(), profileId = profile.id
    const current = () => { try { checkpoint(); return mounted.current && commandContext.current.profileId === profileId } catch { return false } }
    exitRisk.current = 'working'; operationLock.current = true
    setBusy(true); setError(null)
    const markUnknown = () => {
      const pending = { profileId, lessonId, previousRisk }
      setCreationWritesBlocked(true); createPendingRef.current = pending; setCreatePending(pending); setCreateSessions(null); setCreateReadError(null); exitRisk.current = 'uncertain'
      setError('训练创建结果尚未确认，请先核对最近训练；系统不会自动重新创建。')
    }
    try {
      const sent = trainingApi.createSession(profileId, lessonId)
      setCreationWritesBlocked(true)
      const response = await sent
      if (!current()) return
      if (privateWritesAreSuspended()) { markUnknown(); return }
      if (response.session.profile_id !== profileId || response.session.lesson?.id !== lessonId) throw new RequestError('INVALID_RESPONSE', 200)
      window.localStorage.setItem('wenyan.active-session', JSON.stringify({ profileId, sessionId: response.session_id }))
      setSessionId(response.session_id); setSession(response.session); exitRisk.current = null; setPage('training', response.session_id, true)
    } catch (reason) {
      if (!current()) return
      if (uncertainWrite(reason) || !(reason instanceof RequestError) || (reason.status === 408 || reason.status === 429)) {
        markUnknown()
      } else setError(errorMessage(reason))
    } finally {
      if (current()) { if (!createPendingRef.current && !profilePendingRef.current) setCreationWritesBlocked(false); if (exitRisk.current === 'working') exitRisk.current = previousRisk; setBusy(false); operationLock.current = false }
    }
  }, [profile, setPage, startConfirmation.ask])

  const checkCreatedTraining = async () => {
    const pending = createPendingRef.current
    if (!pending || createReadLock.current || privateWritesAreSuspended()) return
    const checkpoint = authResponseCheckpoint()
    const current = () => { try { checkpoint(); return mounted.current && createPendingRef.current === pending && commandContext.current.profileId === pending.profileId } catch { return false } }
    createReadLock.current = true; setCreateChecking(true); setCreateReadError(null); setCreateSessions(null)
    try { const result = await profileApi.listSessions(pending.profileId); if (current()) setCreateSessions(result.sessions) }
    catch (reason) { if (current()) setCreateReadError(errorMessage(reason)) }
    finally { createReadLock.current = false; if (current()) setCreateChecking(false) }
  }
  const releaseCreatedTraining = () => {
    const pending = createPendingRef.current
    if (!pending || createReadLock.current || privateWritesAreSuspended()) return
    const checkpoint = authResponseCheckpoint()
    startConfirmation.ask({ title: '结束本次训练创建核对？', message: '原请求可能已经或稍后创建训练。结束核对不会撤销它；重新开始可能产生重复。请先核对最近训练。', confirmLabel: '了解风险，结束核对', onConfirm: () => {
      try { checkpoint() } catch { return }
      if (!mounted.current || createPendingRef.current !== pending || commandContext.current.profileId !== pending.profileId || privateWritesAreSuspended()) return
      createPendingRef.current = null; setCreatePending(null); setCreateSessions(null); setCreateReadError(null)
      if (!profilePendingRef.current) setCreationWritesBlocked(false)
      if (exitRisk.current === 'uncertain') exitRisk.current = pending.previousRisk
      setError('此前训练创建结果仍未知；结束核对没有撤销原请求，再次开始可能重复。')
    } })
  }

  const runCommand = useCallback((intent: PendingTrainingCommand): Promise<TrainingCommandOutcome> => {
    // Keep any unknown intent/key intact while identity is being reconciled.
    if (privateWritesAreSuspended()) return Promise.resolve({ status: 'blocked' })
    const recovering = uncertainIntent.current === intent
    const isCurrent = (target: PendingTrainingCommand) => {
      const now = commandContext.current
      return mounted.current && now.page === 'training' && now.routeSessionId === target.sessionId
        && now.sessionId === target.sessionId && now.session?.state_version === target.version
        && now.session.profile_id === now.profileId
    }
    return executeTrainingCommand(intent, {
      lock: operationLock, owner: commandOwner, isCurrent, isAlive: () => mounted.current,
      begin: type => { setPendingCommand(type); setBusy(true); setError(null) },
      finish: () => { setBusy(false); setPendingCommand(null) },
      send: async target => {
        const response = await trainingApi.command(target.sessionId, target.version, target.type, target.payload, target.key)
        const owner = commandContext.current.profileId
        if (response.session.profile_id !== owner || response.profile && response.profile.id !== owner) throw new RequestError('INVALID_RESPONSE', 200)
        return response
      },
      accept: response => {
        commandContext.current.session = response.session
        setSession(response.session)
        if (response.profile) setProfile(response.profile)
        uncertainIntent.current = null; setUncertainCommand(null)
      },
      // A rejection of a replay does not prove whether the earlier attempt committed.
      isUnknown: reason => uncertainWrite(reason) || (recovering && reason instanceof RequestError && reason.status >= 400 && reason.status < 500 && reason.status !== 401 && reason.message !== 'SESSION_CHANGED'),
      unknown: (target, reason) => {
        uncertainIntent.current = target; setUncertainCommand(target)
        setError(recovering && reason instanceof RequestError && reason.status >= 400 && reason.status < 500
          ? '原提交的结果仍未确认；本次核对不能证明原提交失败，请继续核对原提交。' : errorMessage(reason))
      },
      failure: reason => {
        uncertainIntent.current = null; setUncertainCommand(null)
        const code = reason instanceof Error ? reason.message : 'REQUEST_FAILED'
        setError(code === 'INVALID_CONTEXT_SELECTION' ? '所选词组超出原文范围，请重新点选。' : errorMessage(reason))
      },
      conflict: async () => {
        uncertainIntent.current = null; setUncertainCommand(null)
        try {
          const restored = (await trainingApi.getSession(intent.sessionId)).session
          if (isCurrent(intent) && restored.profile_id === commandContext.current.profileId && restored.state_version >= intent.version) {
            commandContext.current.session = restored; setSession(restored)
          }
        } catch { /* A failed read keeps the current confirmed snapshot and draft. */ }
        if (mounted.current && commandContext.current.sessionId === intent.sessionId && commandContext.current.page === 'training') {
          setError('训练已在其他页面更新，已尝试同步。请确认当前内容后重试。')
        }
      },
    })
  }, [])
  const command = useCallback((type: CommandType, payload: Record<string, unknown> = {}, expectedVersion?: number): Promise<TrainingCommandOutcome> => {
    const now = commandContext.current
    if (!now.sessionId || !now.session || !mounted.current || now.page !== 'training' || now.routeSessionId !== now.sessionId) return Promise.resolve({ status: 'stale' })
    if (operationLock.current || uncertainIntent.current?.sessionId === now.sessionId) return Promise.resolve({ status: 'blocked' })
    if (expectedVersion !== undefined && expectedVersion !== now.session.state_version) return Promise.resolve({ status: 'stale' })
    return runCommand({ sessionId: now.sessionId, version: now.session.state_version, type, payload, key: requestId() })
  }, [runCommand])

  const openReviewSession = useCallback(async (nextSessionId: string) => {
    if (operationLock.current) return
    operationLock.current = true
    exitRisk.current = 'working'
    setBusy(true); setError(null)
    try {
      const response = await trainingApi.getSession(nextSessionId)
      if (response.session.profile_id) window.localStorage.setItem('wenyan.active-session', JSON.stringify({ profileId: response.session.profile_id, sessionId: nextSessionId }))
      setSessionId(nextSessionId); setSession(response.session); exitRisk.current = createPendingRef.current || profilePendingRef.current ? 'uncertain' : null; setPage('training', nextSessionId, true)
    } catch (reason) {
      setReviewError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { if (exitRisk.current === 'working') exitRisk.current = createPendingRef.current || profilePendingRef.current ? 'uncertain' : null; setBusy(false); operationLock.current = false }
  }, [busy])

  const navigate = (next: Page) => {
    if (!profile && !['admin', 'about'].includes(next)) { setPage('onboarding'); return }
    if (next === 'home') setPage('home')
    else if (next === 'skills') setPage('skills')
    else if (next === 'assessment') setPage('assessment')
    else if (next === 'practice' && profile) setPage('practice')
    else if (next === 'review' && profile) setPage('review')
    else if (next === 'profile' && profile) setPage('profile')
    else if (next === 'report' && profile) setPage('report')
    else if (next === 'admin') setPage('admin')
    else if (next === 'about') setPage('about')
  }

  if (profileLoading) return <main className="loading-page" aria-live="polite">正在读取学习档案…</main>
  if (profileLoadError) return <main className="loading-page" aria-live="polite"><div><p>{profileLoadError}</p><button className="button button-primary" onClick={() => setProfileLoadAttempt(attempt => attempt + 1)}>重试读取档案</button></div></main>

  return <>{navigationModal}{logoutConfirmation.modal}{startConfirmation.modal}<div className={`app-shell polished waterink-theme${page !== 'admin' ? ' inkroom-formal' : ''}${!['home', 'training', 'admin'].includes(page) ? ' inkroom-pages' : ''}`} data-surface={page} ref={shell}>
    <a className="skip-link" href="#page-content" onClick={event => { event.preventDefault(); jumpTo('page-content') }}>跳到主要内容</a>
    <AppHeader page={page} profile={profile} onNavigate={navigate} adminAllowed={adminAllowed} supportOnly={canManageSupport(auth) && !canManage(auth)} />
    <WaterinkMobileNavigation page={page} hasProfile={!!profile} onNavigate={navigate} />
    {profile && (page === 'home' || page === 'practice') && <InkMotionControl reduced={inkMotion.reduced} systemReduced={inkMotion.systemReduced} onChange={inkMotion.setReduced} />}
    {auth.mode === 'invite' && <div className="auth-account-bar"><span>当前账号：{auth.user?.email ? auth.user.email.replace(/^(.{1,2}).*(@.*)$/, '$1***$2') : auth.user?.username}</span><button onClick={() => void logout()} disabled={logoutBusy}>退出登录</button>{logoutError && <p role="alert">{logoutError}</p>}</div>}
    {profilePending && !profile && <section className="auth-state" aria-label="档案创建结果核对">
      <h2>档案创建结果尚未确认</h2><p>原请求可能已经或稍后创建档案。只读资料仅供人工核对，暂时没有档案也不能证明原请求失败。刷新、关闭页面或退出后本页核对线索会丢失；浏览器可能不会提示。</p>
      <button type="button" className="button button-secondary" disabled={profileChecking} onClick={() => void checkCreatedProfile()}>{profileChecking ? '正在读取…' : '读取当前账号资料'}</button>
      {profileCheckError && <p role="alert">读取失败：{profileCheckError}。结果仍未确认。</p>}
      {profileCheck === 'none' && <p>当前账号尚未显示档案；原请求仍可能稍后完成。</p>}
      {profileCheck === 'unavailable' && <p>当前模式没有按账号读取档案的接口，结果仍未确认。</p>}
      {profileCheck && typeof profileCheck === 'object' && <p>当前账号显示的档案：{profileCheck.display_name} · {profileCheck.school_stage === 'JUNIOR' ? '初中' : '高中'}。这不是原请求的操作回执。</p>}
      <button type="button" className="button button-secondary" disabled={profileChecking} onClick={releaseCreatedProfile}>结束本次核对</button>
    </section>}
    {createPending && createPending.profileId === profile?.id && <section className="auth-state" aria-label="训练创建结果核对">
      <h2>训练创建结果尚未确认</h2><p>原请求可能已经或稍后创建训练。最近训练仅供人工核对，列表为空也不能证明原请求失败。刷新、关闭页面或退出后本页核对线索会丢失；浏览器可能不会提示。</p>
      <button type="button" className="button button-secondary" disabled={createChecking} onClick={() => void checkCreatedTraining()}>{createChecking ? '正在读取…' : '读取最近训练'}</button>
      {createReadError && <p role="alert">读取失败：{createReadError}。结果仍未确认。</p>}
      {createSessions && (createSessions.length ? <ul>{createSessions.map(item => <li key={item.session_id}>{item.source} · {item.completed ? '已完成' : '进行中'}</li>)}</ul> : <p>当前没有最近训练；原请求仍可能稍后完成。</p>)}
      <button type="button" className="button button-secondary" disabled={createChecking} onClick={releaseCreatedTraining}>结束本次核对</button>
    </section>}
    <div className="page-view" id="page-content" tabIndex={-1} key={`${page}:${route.sessionId ?? ''}`}>
    <RenderBoundary onHome={() => navigate('home')}>
    {page === 'about' && <AboutPage onNavigate={navigate} onReplayTour={replayTour} />}
    {!profile && ['onboarding', 'home', 'skills'].includes(page) && <OnboardingPage busy={busy} locked={!!profilePending} draft={profilePending} error={error} onCreate={createProfile} inviteMode={auth.mode === 'invite'} />}
    {page === 'home' && profile && <ReadingHomePage inkMotion={inkMotion} profile={profile} lessons={lessons} loading={lessonsLoading} catalogError={lessonsError} onRetry={() => void loadLessons(profile.school_stage)} onStart={start} onAssessment={() => navigate('assessment')} onPractice={() => navigate('practice')} onStartSession={id => setPage('training', id)} onRiskChange={onExitRiskChange} isStarting={busy} error={error} mission={dailyMission} missionLoading={missionLoading} missionError={missionError} />}
    {page === 'assessment' && <AssessmentPage profileId={profile?.id ?? null} onCreateProfile={() => setPage('onboarding')} onHome={() => navigate('home')} onRiskChange={onExitRiskChange} />}
    {page === 'skills' && profile && <SkillsPage summary={learningSummary} loading={summaryLoading} error={summaryError} onRetry={() => void loadLearningSummary(profile.id)} onStart={() => navigate('home')} />}
    {page === 'practice' && profile && <SpecializedPracticePage inkMotion={inkMotion} plans={practicePlans} groupBy={practiceGroupBy} loading={practiceLoading} error={practiceError} startingLesson={busy} startError={error} onGroupByChange={setPracticeGroupBy} onRetry={() => void loadPracticePlans(profile.id, practiceGroupBy)} onStartLesson={start} />}
    {page === 'review' && profile && <ReviewPage key={profile.id} sessions={reviewSessions} loading={reviewsLoading} error={reviewError} mistakes={mistakes} mistakesLoading={mistakesLoading} mistakesError={mistakesError} startingLesson={busy} startError={error} onOpen={openReviewSession} onRetryMistakes={() => void loadMistakes(profile.id)} onRetrySessions={() => setReviewReadAttempt(value => value + 1)} onStartLesson={start} />}
    {page === 'profile' && profile && <ProfilePage profile={profile} onStart={() => navigate('home')} onReplayTour={replayTour} onNavigate={navigate} adminAllowed={adminAllowed} adminLabel={canManageSupport(auth) && !canManage(auth) ? '用户反馈' : '教研工作台'} />}
    {page === 'report' && profile && <main aria-label="学习报告">
      <header className="report-overview"><p className="eyebrow">学习报告</p><h1>表现、过程与进度，<br />分开看得更清楚。</h1><p>正式能力档案、作答过程和练习进度分别记录，不混成一个分数。</p><nav aria-label="报告分区"><button onClick={() => jumpTo('report-ability')}>能力档案</button><button onClick={() => jumpTo('report-observations')}>作答过程</button><button onClick={() => jumpTo('report-progress')}>学习进度</button></nav></header>
      <div className="ability-report-container"><div id="report-ability" tabIndex={-1}><AbilityProfilePanel profileId={profile.id} onAssessment={() => navigate('assessment')} onPractice={() => navigate('practice')} /></div><div id="report-observations" tabIndex={-1}><ObservationReport profileId={profile.id} onPractice={() => navigate('practice')} onOpenSession={(id) => setPage('training', id)} /></div></div>
      <div id="report-progress" tabIndex={-1}><LearningReportPage summary={learningSummary} loading={summaryLoading} error={summaryError} achievements={achievements} achievementsLoading={achievementsLoading} achievementsError={achievementsError} onRetry={() => { void loadLearningSummary(profile.id); void loadAchievements(profile.id) }} onStart={() => navigate('home')} onRecommendation={(kind) => navigate(kind === 'WEAK_SKILL' ? 'review' : 'home')} /></div>
    </main>}
    {page === 'admin' && (canManageSupport(auth) && !canManage(auth) ? <main className="content-admin-page"><SupportInbox onRiskChange={onExitRiskChange} /></main> : adminAllowed ? <DualAdminWorkbench supportAllowed={canManageSupport(auth)} onExitRiskChange={onExitRiskChange}>{callback => <AdminWorkbench onExitRiskChange={callback} ability={callback => <CourseAbilityWorkbench onExitRiskChange={callback} />} questions={callback => <AssessmentQuestionWorkbench onExitRiskChange={callback} />} aiReview={callback => <AIReasonReviewWorkbench onExitRiskChange={callback} />}>{callback => <ContentAdminPage onExitRiskChange={callback} />}</AdminWorkbench>}</DualAdminWorkbench> : <main className="auth-forbidden"><p className="eyebrow">管理后台未开放</p><h1>这里不属于当前账号的权限范围。</h1><p>学习功能不受影响。如需教研管理权限，请联系内测负责人。</p><button className="button button-primary" onClick={() => setPage(profile ? 'home' : 'onboarding')}>返回学习页面</button></main>)}
    {page === 'training' && (routeSessionLoading || (!!route.sessionId && route.sessionId !== sessionId)) && <main className="route-state">{routeSessionError ? <div role="alert"><p>{routeSessionError}</p><button className="button button-primary" onClick={() => setRouteSessionAttempt(n => n + 1)}>重试读取</button><button className="text-button" onClick={() => setPage('review')}>返回复习</button></div> : <p role="status">正在恢复这次训练…</p>}</main>}
    {page === 'training' && !routeSessionLoading && session && sessionId && route.sessionId === sessionId && <TrainingPage key={sessionId} sessionId={sessionId} session={session} busy={busy} pendingCommand={pendingCommand} error={error} recoveryNeeded={uncertainCommand?.sessionId === sessionId} onRecover={() => uncertainCommand && void runCommand(uncertainCommand)} onCommand={command} onDirtyChange={setTrainingDirty} onReturnHome={() => { window.localStorage.removeItem('wenyan.active-session'); setPage('home') }} />}
    {page === 'training' && !route.sessionId && <EmptyPage onHome={() => setPage('home')} />}
    </RenderBoundary>
    </div>
  </div>{logoutBusy && <div className="auth-logout-progress" role="status">正在安全退出，请稍候…</div>}</>
}
