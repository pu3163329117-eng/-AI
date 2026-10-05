import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { adminLessonApi, lessonApi, profileApi, trainingApi } from './api'
import type { Achievement, Achievements, AdminLesson, AdminLessonInput, CommandType, LearnerProfile, LearningSummary, Lesson, ReviewSession, SchoolStage, TrainingSession } from './types'

type Page = 'home' | 'training' | 'skills' | 'review' | 'profile' | 'report' | 'admin' | 'onboarding'

const taskLabels = ['识别已知', '推断变量', '回溯验证', '迁移挑战']

function AppHeader({ page, profile, onNavigate }: { page: Page; profile: LearnerProfile | null; onNavigate: (page: Page) => void }) {
  return (
    <header className="app-header">
      <button className="brand" onClick={() => onNavigate('home')} aria-label="返回首页">
        文言 <span>·</span> 推理
      </button>
      <nav aria-label="主导航">
        <button className={page === 'home' || page === 'training' ? 'is-active' : ''} onClick={() => onNavigate('home')}>
          今日训练
        </button>
        <button className={page === 'skills' ? 'is-active' : ''} onClick={() => onNavigate('skills')}>
          能力地图
        </button>
        <button className={page === 'review' ? 'is-active' : ''} onClick={() => onNavigate('review')} disabled={!profile}>复习</button>
        <button className={page === 'profile' ? 'is-active' : ''} onClick={() => onNavigate('profile')} disabled={!profile}>我的</button>
        <button className={page === 'report' ? 'is-active' : ''} onClick={() => onNavigate('report')} disabled={!profile}>学习报告</button>
        <button className={page === 'admin' ? 'is-active' : ''} onClick={() => onNavigate('admin')}>内容管理</button>
      </nav>
      <button className="account" aria-label="查看学习档案" onClick={() => profile && onNavigate('profile')} disabled={!profile}>{profile?.display_name.slice(0, 1) ?? '—'}</button>
    </header>
  )
}

function HomePage({ profile, lessons, loading, catalogError, onRetry, onStart, isStarting, error }: {
  profile: LearnerProfile
  lessons: Lesson[]
  loading: boolean
  catalogError: string | null
  onRetry: () => void
  onStart: (lessonId: string) => void
  isStarting: boolean
  error: string | null
}) {
  const todayLesson = lessons[0]
  const stageLabel = profile.school_stage === 'JUNIOR' ? '初中' : '高中'
  return (
    <main className="home-page">
      <section className="hero" aria-labelledby="home-title">
        <div>
          <p className="eyebrow">{stageLabel} · 分级关卡</p>
          {loading ? <CatalogLoading /> : catalogError ? <CatalogError error={catalogError} onRetry={onRetry} /> : todayLesson ? <>
            <h1 id="home-title">{todayLesson.title}</h1>
            <p className="intro">{todayLesson.summary}</p>
            <p className="lesson-meta-line">{todayLesson.source} · {todayLesson.difficulty} · 约 {todayLesson.estimated_minutes} 分钟</p>
            <button className="button button-primary" onClick={() => onStart(todayLesson.id)} disabled={isStarting}>
              {isStarting ? '正在准备训练…' : '开始今日关卡'} <span aria-hidden="true">→</span>
            </button>
          </> : <CatalogEmpty stageLabel={stageLabel} />}
          {error && <p className="request-error" role="alert">无法开始训练：{error}</p>}
        </div>
        <aside className="streak" aria-label="连续学习进度">
          <div className="progress-ring" aria-label={`已完成 ${profile.completed_levels} 关`}><b>{profile.completed_levels}</b><small>关</small></div>
          <strong>{profile.display_name}的学习档案</strong>
          <small>已完成 {profile.completed_levels} 关<br />累计 {profile.total_points} 知行。</small>
        </aside>
      </section>
      <section className="lesson-catalog" aria-labelledby="catalog-title">
        <div className="catalog-heading">
          <div><p className="eyebrow">当前分级</p><h2 id="catalog-title">{stageLabel}关卡</h2></div>
          {!loading && !catalogError && lessons.length > 0 && <span>{lessons.length} 个可选关卡</span>}
        </div>
        {loading ? <CatalogLoading compact /> : catalogError ? <CatalogError error={catalogError} onRetry={onRetry} compact /> : lessons.length === 0 ? <CatalogEmpty stageLabel={stageLabel} compact /> : (
          <div className="lesson-grid">
            {lessons.map((lesson, index) => <LessonCard key={lesson.id} lesson={lesson} index={index} onStart={onStart} busy={isStarting} />)}
          </div>
        )}
      </section>
    </main>
  )
}

function CatalogLoading({ compact = false }: { compact?: boolean }) {
  return <div className={compact ? 'catalog-state compact' : 'catalog-state'} aria-live="polite"><b>正在读取分级关卡…</b><p>正在为当前学习阶段整理可训练的文章。</p></div>
}

function CatalogError({ error, onRetry, compact = false }: { error: string; onRetry: () => void; compact?: boolean }) {
  return <div className={compact ? 'catalog-state compact' : 'catalog-state'} role="alert"><b>暂时无法读取关卡目录。</b><p>请检查本地服务后重试。错误代码：{error}</p><button className="text-button" onClick={onRetry}>重新读取 →</button></div>
}

function CatalogEmpty({ stageLabel, compact = false }: { stageLabel: string; compact?: boolean }) {
  return <div className={compact ? 'catalog-state compact' : 'catalog-state'}><b>{stageLabel}分级暂未开放关卡。</b><p>关卡由教研内容发布后显示在这里，请稍后再来。</p></div>
}

function LessonCard({ lesson, index, onStart, busy }: { lesson: Lesson; index: number; onStart: (lessonId: string) => void; busy: boolean }) {
  return <article className="lesson-card">
    <div className="lesson-card-top"><em>{String(index + 1).padStart(2, '0')}</em><span>{index === 0 ? '今日推荐' : lesson.difficulty}</span></div>
    <h3>{lesson.title}</h3>
    <p>{lesson.summary}</p>
    <footer><small>{lesson.source} · 约 {lesson.estimated_minutes} 分钟</small><button className="text-button" onClick={() => onStart(lesson.id)} disabled={busy}>{index === 0 ? '开始' : '选择'} →</button></footer>
  </article>
}

function OnboardingPage({ busy, error, onCreate }: { busy: boolean; error: string | null; onCreate: (name: string, stage: SchoolStage) => void }) {
  const [name, setName] = useState('')
  const [stage, setStage] = useState<SchoolStage>('JUNIOR')
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (name.trim()) onCreate(name.trim(), stage)
  }
  return (
    <main className="onboarding-page">
      <section className="onboarding-copy">
        <p className="eyebrow">开始之前</p>
        <h1>先留下<br />你的起点。</h1>
        <p>这份档案只保存在当前设备，用来记录你的分级、完成关卡和知行积分。</p>
      </section>
      <form className="profile-form" onSubmit={submit}>
        <label>怎么称呼你？<input value={name} maxLength={20} onChange={(event) => setName(event.target.value)} placeholder="例如：小林" autoFocus /></label>
        <fieldset>
          <legend>你现在的学习阶段</legend>
          <label><input type="radio" name="stage" checked={stage === 'JUNIOR'} onChange={() => setStage('JUNIOR')} /> 初中</label>
          <label><input type="radio" name="stage" checked={stage === 'SENIOR'} onChange={() => setStage('SENIOR')} /> 高中</label>
        </fieldset>
        <button className="button button-primary" disabled={!name.trim() || busy}>{busy ? '正在建立档案…' : '建立学习档案'} <span aria-hidden="true">→</span></button>
        {error && <p className="request-error" role="alert">无法建立档案：{error}</p>}
      </form>
    </main>
  )
}

function ProfilePage({ profile, onStart }: { profile: LearnerProfile; onStart: () => void }) {
  const stage = profile.school_stage === 'JUNIOR' ? '初中' : '高中'
  const title = profile.total_points >= 60 ? '行读者' : profile.total_points >= 20 ? '见习推理者' : '初入文境'
  return (
    <main className="profile-page">
      <p className="eyebrow">我的学习档案</p>
      <h1>{profile.display_name}，<br />继续把依据说清楚。</h1>
      <p className="intro">当前分级：{stage}。数据随本机 SQLite 档案保存。</p>
      <section className="profile-stats" aria-label="学习进度">
        <article><span>当前身份</span><strong>{title}</strong></article>
        <article><span>完成关卡</span><strong>{profile.completed_levels}</strong></article>
        <article><span>累计知行</span><strong>{profile.total_points}</strong></article>
      </section>
      <button className="button button-primary" onClick={onStart}>继续训练 <span aria-hidden="true">→</span></button>
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
    return <main className="learning-report-page report-state" aria-live="polite"><p className="eyebrow">学习报告</p><h1>正在整理<br />你的学习轨迹。</h1><p className="intro">把最近的训练、薄弱环节和连续学习天数汇总成一页。</p></main>
  }
  if (error) {
    return <main className="learning-report-page report-state" role="alert"><p className="eyebrow">学习报告</p><h1>报告暂时<br />还没准备好。</h1><p className="intro">请确认本地服务仍在运行后再试一次。错误代码：{error}</p><button className="button button-primary" onClick={onRetry}>重新读取 <span aria-hidden="true">→</span></button></main>
  }
  if (!summary || (summary.completed_sessions === 0 && summary.completed_lessons === 0 && summary.total_points === 0)) {
    return <main className="learning-report-page report-state"><p className="eyebrow">学习报告</p><h1>先完成一关，<br />再看见你的路径。</h1><p className="intro">每次完成训练后，这里会记录知行、连续学习天数，以及下一步值得回看的推理能力。</p><button className="button button-primary" onClick={onStart}>开始第一关 <span aria-hidden="true">→</span></button></main>
  }

  return (
    <main className="learning-report-page">
      <header className="report-heading">
        <div><p className="eyebrow">学习报告</p><h1>把每一次判断，<br />看成一条路径。</h1><p>这不是排名，而是你在文言语境中留下的证据、回溯与迁移记录。</p></div>
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
          : achievementsError ? <div className="report-empty" role="alert"><b>学习印记暂时无法读取。</b><p>报告其他内容不受影响；请稍后重新打开学习报告。错误代码：{achievementsError}</p></div>
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
      <button className="button button-primary report-action" onClick={onStart}>继续今日训练 <span aria-hidden="true">→</span></button>
    </main>
  )
}

function ReviewPage({ sessions, loading, error, onOpen }: { sessions: ReviewSession[]; loading: boolean; error: string | null; onOpen: (sessionId: string) => void }) {
  return (
    <main className="review-page">
      <p className="eyebrow">复习</p>
      <h1>把走过的推理，<br />再走一遍。</h1>
      <p className="intro">这里显示当前设备档案下的最近训练；未完成的关卡可以从原处继续。</p>
      {loading ? <p className="review-status">正在读取训练记录…</p> : error ? <p className="request-error" role="alert">无法读取训练记录：{error}</p> : sessions.length === 0 ? (
        <section className="review-empty"><b>还没有可回看的训练。</b><p>完成第一关后，它会出现在这里。</p></section>
      ) : (
        <section className="review-list" aria-label="最近训练记录">
          {sessions.map((item) => (
            <article key={item.session_id}>
              <div><span>{item.completed ? '已完成' : '进行中'}</span><strong>{item.source}</strong><p>{item.feedback}</p></div>
              <button className="text-button" onClick={() => onOpen(item.session_id)}>{item.completed ? '查看总结' : '继续练习'} →</button>
            </article>
          ))}
        </section>
      )}
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
  const result: Record<string, unknown> = {}
  if (form.core_content.trim()) result.CORE = JSON.parse(form.core_content)
  if (form.transfer_content.trim()) result.TRANSFER = JSON.parse(form.transfer_content)
  return Object.keys(result).length ? result : undefined
}

function ContentAdminPage() {
  const [lessons, setLessons] = useState<AdminLesson[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState<ContentForm>(emptyContentForm)
  const [detailLoading, setDetailLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

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
    setActiveId('new'); setForm(emptyContentForm()); setFormError(null); setSuccess(null)
  }

  const openLesson = async (lessonId: string) => {
    setActiveId(lessonId); setDetailLoading(true); setFormError(null); setSuccess(null)
    try {
      const response = await adminLessonApi.get(lessonId)
      setForm(contentFormFromLesson(response.lesson))
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setDetailLoading(false) }
  }

  const setField = <Key extends keyof ContentForm>(key: Key, value: ContentForm[Key]) => setForm((current) => ({ ...current, [key]: value }))

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError(null); setSuccess(null)
    let content: Record<string, unknown> | undefined
    try {
      content = parseEditorialContent(form)
    } catch {
      setFormError('CONTENT_JSON_INVALID')
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
    setSaving(true)
    try {
      const response = activeId === 'new'
        ? await adminLessonApi.create(payload)
        : await adminLessonApi.update(activeId!, payload)
      setLessons((current) => {
        const withoutSaved = current.filter((lesson) => lesson.id !== response.lesson.id)
        return [...withoutSaved, response.lesson]
      })
      setActiveId(response.lesson.id)
      setForm(contentFormFromLesson(response.lesson))
      setSuccess(activeId === 'new' ? '草稿已创建，补全训练内容后即可发布。' : '修改已保存。')
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setSaving(false) }
  }

  const publish = async () => {
    if (!activeId || activeId === 'new') return
    setPublishing(true); setFormError(null); setSuccess(null)
    try {
      const response = await adminLessonApi.publish(activeId)
      setLessons((current) => current.map((lesson) => lesson.id === response.lesson.id ? response.lesson : lesson))
      setForm(contentFormFromLesson(response.lesson))
      setSuccess('关卡已发布，现在会出现在对应学段的学习目录中。')
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setPublishing(false) }
  }

  const selectedLesson = activeId && activeId !== 'new' ? lessons.find((lesson) => lesson.id === activeId) : null
  return (
    <main className="content-admin-page">
      <header className="admin-heading">
        <div><p className="eyebrow">教研工作台</p><h1>把关卡做成<br />可发布的课程。</h1><p>草稿不会进入学习目录；发布前请完成两段训练内容和教研标注。</p></div>
        <button className="button button-primary" onClick={openNew}>创建新关卡 <span aria-hidden="true">+</span></button>
      </header>
      <div className="admin-workspace">
        <aside className="admin-list" aria-label="关卡列表">
          <div className="admin-list-title"><b>全部关卡</b><button className="text-button" onClick={() => void loadLessons()} disabled={loading}>刷新</button></div>
          {loading ? <p className="admin-state">正在读取关卡…</p> : listError ? <div className="admin-state" role="alert"><b>无法读取关卡。</b><p>错误代码：{listError}</p><button className="text-button" onClick={() => void loadLessons()}>重新读取 →</button></div> : lessons.length === 0 ? <p className="admin-state">还没有教研关卡。创建第一份草稿开始编辑。</p> : <div className="admin-lesson-list">
            {lessons.map((lesson) => <button key={lesson.id} className={activeId === lesson.id ? 'selected' : ''} onClick={() => void openLesson(lesson.id)}><span className={`status-badge ${lesson.status === 'PUBLISHED' ? 'published' : ''}`}>{lesson.status === 'PUBLISHED' ? '已发布' : '草稿'}</span><strong>{lesson.title}</strong><small>{lesson.school_stage === 'JUNIOR' ? '初中' : '高中'} · {lesson.source}</small></button>)}
          </div>}
        </aside>
        <section className="admin-editor" aria-live="polite">
          {!activeId ? <div className="admin-placeholder"><p className="eyebrow">内容管理</p><h2>选择一份关卡，<br />或新建草稿。</h2><p>这里记录课程的学习对象、教材位置、关键积累与推理路径。</p><button className="button button-primary" onClick={openNew}>创建新关卡 <span aria-hidden="true">→</span></button></div> : detailLoading ? <p className="admin-state">正在读取关卡详情…</p> : <form className="lesson-editor-form" onSubmit={submit}>
            <div className="editor-topline"><div><p className="eyebrow">{activeId === 'new' ? '新建草稿' : selectedLesson?.status === 'PUBLISHED' ? '已发布关卡' : '草稿关卡'}</p><h2>{activeId === 'new' ? '建立课程骨架' : form.title || '未命名关卡'}</h2></div>{activeId !== 'new' && <button type="button" className="button button-secondary" onClick={publish} disabled={publishing || selectedLesson?.status === 'PUBLISHED'}>{selectedLesson?.status === 'PUBLISHED' ? '已发布' : publishing ? '正在发布…' : '发布关卡'}</button>}</div>
            <fieldset className="editor-section"><legend>课程定位</legend><div className="field-grid"><label>学段<select value={form.school_stage} onChange={(event) => setField('school_stage', event.target.value as SchoolStage)}><option value="JUNIOR">初中</option><option value="SENIOR">高中</option></select></label><label>教材标签（用逗号分隔）<input value={form.textbook_tags} onChange={(event) => setField('textbook_tags', event.target.value)} placeholder="部编版, 七年级上册" /></label><label>主题<input value={form.theme} onChange={(event) => setField('theme', event.target.value)} placeholder="语境推断" /></label></div></fieldset>
            <fieldset className="editor-section"><legend>关卡信息</legend><div className="field-grid"><label className="span-two">题目<input required value={form.title} onChange={(event) => setField('title', event.target.value)} placeholder="例如：从人物关系推断词义" /></label><label>出处<input required value={form.source} onChange={(event) => setField('source', event.target.value)} placeholder="《陈涉世家》" /></label><label>难度<input required value={form.difficulty} onChange={(event) => setField('difficulty', event.target.value)} placeholder="进阶" /></label><label>预计时长（分钟）<input required min="1" type="number" inputMode="numeric" value={form.estimated_minutes} onChange={(event) => setField('estimated_minutes', event.target.value)} /></label><label className="span-two">学习摘要<textarea required value={form.summary} onChange={(event) => setField('summary', event.target.value)} placeholder="说明本关要完成的理解与推断任务。" /></label></div></fieldset>
            <fieldset className="editor-section"><legend>教研标注</legend><div className="field-grid"><label>积累点（每行一项）<textarea value={form.accumulation_points} onChange={(event) => setField('accumulation_points', event.target.value)} placeholder="实词义项\n人物关系" /></label><label>推理点（每行一项）<textarea value={form.reasoning_points} onChange={(event) => setField('reasoning_points', event.target.value)} placeholder="从人物动作寻找依据\n排除不合语境的义项" /></label><label className="span-two">推理层级<input value={form.reasoning_level} onChange={(event) => setField('reasoning_level', event.target.value)} placeholder="如：语境定位 → 关系推断 → 回溯验证" /></label></div></fieldset>
            <fieldset className="editor-section"><legend>训练内容</legend><p className="field-note">发布前需提供 CORE 与 TRANSFER 的完整 JSON 内容；系统会在发布时验证结构。</p><div className="field-grid"><label>CORE（核心训练 JSON）<textarea className="code-input" value={form.core_content} onChange={(event) => setField('core_content', event.target.value)} placeholder={'{\n  "passage": "…"\n}'} /></label><label>TRANSFER（迁移训练 JSON）<textarea className="code-input" value={form.transfer_content} onChange={(event) => setField('transfer_content', event.target.value)} placeholder={'{\n  "passage": "…"\n}'} /></label></div></fieldset>
            <div className="editor-actions"><button className="button button-primary" disabled={saving}>{saving ? '正在保存…' : activeId === 'new' ? '保存草稿' : '保存修改'} <span aria-hidden="true">→</span></button>{formError && <p className="request-error" role="alert">操作未完成：{formError}</p>}{success && <p className="request-success" role="status">{success}</p>}</div>
          </form>}
        </section>
      </div>
    </main>
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

function TrainingPage({ session, busy, error, onCommand, onReturnHome }: {
  session: TrainingSession
  busy: boolean
  error: string | null
  onCommand: (type: CommandType, payload?: Record<string, string>) => void
  onReturnHome: () => void
}) {
  const [answer, setAnswer] = useState<string | null>(session.selected_answer)
  useEffect(() => setAnswer(session.selected_answer), [session.selected_answer, session.stage])

  const submit = () => answer && onCommand('SUBMIT_ATTEMPT', { answer })
  const isTransferReady = session.transfer_ready && !session.completed
  const isSummaryReady = session.summary_ready && !session.completed
  const currentStep = session.completed ? 4 : session.stage === 'TRANSFER' ? 3 : 1
  const [beforeVariable, afterVariable = ''] = session.passage.split(session.variable)

  return (
    <main className="training-page">
      <div className="training-shell">
        <aside className="step-list" aria-label="训练步骤">
          <b>本次训练</b>
          {taskLabels.map((label, index) => <span className={index < currentStep ? 'done' : index === currentStep ? 'current' : ''} key={label}>{label}</span>)}
        </aside>
        <section className="lesson" aria-labelledby="question-title">
          <div className="lesson-meta"><span>{session.source}</span><span>{session.stage === 'CORE' ? '02 / 04' : '04 / 04'}</span></div>
          {session.completed && session.summary ? (
            <LessonSummary summary={session.summary} onReturnHome={onReturnHome} />
          ) : (
            <>
              <p className="passage">{beforeVariable}<span>{session.variable}</span>{afterVariable}</p>
              <div className="question-area">
                <p className="stage-label">{session.stage === 'CORE' ? '先完成原文推理' : '陌生文迁移挑战'}</p>
                <h1 id="question-title">{session.question}</h1>
                <div className="choice-list" role="radiogroup" aria-label="选择词义">
                  {session.choices.map((choice) => (
                    <button
                      type="button"
                      key={choice}
                      role="radio"
                      aria-checked={answer === choice}
                      className={answer === choice ? 'selected' : ''}
                      disabled={busy}
                      onClick={() => setAnswer(choice)}
                    >
                      <span className="radio-dot" aria-hidden="true" />{choice}
                    </button>
                  ))}
                </div>
                <button className="button button-primary submit" onClick={submit} disabled={!answer || busy}>
                  {busy ? '正在核验…' : '提交判断'}
                </button>
              </div>
              <div className={`feedback ${isTransferReady || isSummaryReady ? 'success' : ''}`} aria-live="polite">
                {error ? `操作未完成：${error}` : session.feedback}
              </div>
              {isTransferReady && <button className="text-button" onClick={() => onCommand('CONTINUE_TO_TRANSFER')} disabled={busy}>进入陌生文挑战 →</button>}
              {isSummaryReady && <button className="text-button" onClick={() => onCommand('COMPLETE_SESSION')} disabled={busy}>查看本关总结 →</button>}
            </>
          )}
        </section>
        <aside className="evidence-panel" aria-label="推理工具">
          <b>证据板</b>
          <button className={session.evidence_selected ? 'selected' : ''} onClick={() => onCommand('SELECT_EVIDENCE')} disabled={busy || session.completed}>
            <span aria-hidden="true">“</span>{session.evidence}<span aria-hidden="true">”</span>
          </button>
          <hr />
          <button className="quiet-action" onClick={() => onCommand('DEFER_VARIABLE')} disabled={busy || session.completed}>先暂放这个字</button>
          <button className="quiet-action" onClick={() => onCommand('REQUEST_HINT')} disabled={busy || session.completed}>需要一点提示</button>
          {session.hint && <p className="hint">第 {session.hint_level} 条提示：{session.hint}</p>}
        </aside>
      </div>
    </main>
  )
}

function LessonSummary({ summary, onReturnHome }: { summary: NonNullable<TrainingSession['summary']>; onReturnHome: () => void }) {
  return (
    <section className="lesson-summary" aria-labelledby="summary-title">
      <p className="stage-label">本关总结</p>
      <h1 id="summary-title">你不是猜对，<br />是推出来的。</h1>
      <div className="summary-lines">
        <article><b>积累</b><p>{summary.accumulation}</p></article>
        <article><b>推理</b><p>{summary.reasoning}</p></article>
      </div>
      <div className="earned-points" aria-label={`本关获得 ${summary.earned_points} 点`}>+{summary.earned_points}<span>知行</span></div>
      <button className="button button-primary" onClick={onReturnHome}>返回今日训练 <span aria-hidden="true">→</span></button>
    </section>
  )
}

function SkillsPage({ profile, onStart }: { profile: LearnerProfile; onStart: () => void }) {
  const progress = Math.min(100, profile.completed_levels * 50)
  const skills = [
    ['语境定位', '在句子里标出判断所需的证据', progress],
    ['关系推断', '从人物与行为中找依据', Math.max(0, progress - 10)],
    ['暂放回溯', '等到新证据出现后再判断', Math.max(0, progress - 20)],
  ] as const
  return (
    <main className="skills-page">
      <p className="eyebrow">能力地图</p>
      <h1>把每一次判断，<br />留下可回看的路径。</h1>
      <p className="intro">能力不是答对次数，而是能否指出证据，并在陌生句子里再次使用。</p>
      <section className="skill-list" aria-label="当前能力">
        {skills.map(([title, description, progress]) => (
          <article className="skill-row" key={title}>
            <div><strong>{title}</strong><p>{description}</p></div>
            <div className="meter" aria-label={`${title} ${progress}%`}><i style={{ width: `${progress}%` }} /></div>
            <b>{progress}</b>
          </article>
        ))}
      </section>
      <button className="button button-primary" onClick={onStart}>继续今日训练 <span aria-hidden="true">→</span></button>
    </main>
  )
}

export function App() {
  const [page, setPage] = useState<Page>('home')
  const [profile, setProfile] = useState<LearnerProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(true)
  const [reviewSessions, setReviewSessions] = useState<ReviewSession[]>([])
  const [reviewsLoading, setReviewsLoading] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [learningSummary, setLearningSummary] = useState<LearningSummary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [achievements, setAchievements] = useState<Achievements | null>(null)
  const [achievementsLoading, setAchievementsLoading] = useState(false)
  const [achievementsError, setAchievementsError] = useState<string | null>(null)
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [lessonsLoading, setLessonsLoading] = useState(false)
  const [lessonsError, setLessonsError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [session, setSession] = useState<TrainingSession | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const storedProfileId = window.localStorage.getItem('wenyan.profile-id')
    if (!storedProfileId) {
      setProfileLoading(false)
      setPage('onboarding')
      return
    }
    profileApi.get(storedProfileId)
      .then(({ profile: nextProfile }) => setProfile(nextProfile))
      .catch(() => {
        window.localStorage.removeItem('wenyan.profile-id')
        setPage('onboarding')
      })
      .finally(() => setProfileLoading(false))
  }, [])

  const createProfile = useCallback(async (displayName: string, schoolStage: SchoolStage) => {
    setBusy(true); setError(null)
    try {
      const response = await profileApi.create(displayName, schoolStage)
      window.localStorage.setItem('wenyan.profile-id', response.profile.id)
      setProfile(response.profile)
      setPage('home')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setBusy(false) }
  }, [])

  useEffect(() => {
    if (page !== 'review' || !profile) return
    setReviewsLoading(true); setReviewError(null)
    profileApi.listSessions(profile.id)
      .then(({ sessions }) => setReviewSessions(sessions))
      .catch((reason) => setReviewError(reason instanceof Error ? reason.message : 'REQUEST_FAILED'))
      .finally(() => setReviewsLoading(false))
  }, [page, profile])

  const loadLearningSummary = useCallback(async (profileId: string) => {
    setSummaryLoading(true); setSummaryError(null)
    try {
      const response = await profileApi.getLearningSummary(profileId)
      setLearningSummary(response.summary)
    } catch (reason) {
      setLearningSummary(null)
      setSummaryError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setSummaryLoading(false) }
  }, [])

  const loadAchievements = useCallback(async (profileId: string) => {
    setAchievementsLoading(true); setAchievementsError(null)
    try {
      const response = await profileApi.getAchievements(profileId)
      setAchievements(response)
    } catch (reason) {
      setAchievements(null)
      setAchievementsError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setAchievementsLoading(false) }
  }, [])

  useEffect(() => {
    if (page === 'report' && profile) {
      void loadLearningSummary(profile.id)
      void loadAchievements(profile.id)
    }
  }, [page, profile, loadLearningSummary, loadAchievements])

  const loadLessons = useCallback(async (schoolStage: SchoolStage) => {
    setLessonsLoading(true); setLessonsError(null)
    try {
      const response = await lessonApi.list(schoolStage)
      setLessons(response.lessons)
    } catch (reason) {
      setLessons([])
      setLessonsError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setLessonsLoading(false) }
  }, [])

  useEffect(() => {
    if (profile) void loadLessons(profile.school_stage)
  }, [profile, loadLessons])

  const start = useCallback(async (lessonId: string) => {
    if (!profile) { setPage('onboarding'); return }
    setBusy(true); setError(null)
    try {
      const response = await trainingApi.createSession(profile.id, lessonId)
      setSessionId(response.session_id); setSession(response.session); setPage('training')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setBusy(false) }
  }, [profile])

  const command = useCallback(async (type: CommandType, payload: Record<string, string> = {}) => {
    if (!sessionId || !session) return
    setBusy(true); setError(null)
    try {
      const response = await trainingApi.command(sessionId, session.state_version, type, payload)
      setSession(response.session)
      if (response.profile) setProfile(response.profile)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setBusy(false) }
  }, [session, sessionId])

  const openReviewSession = useCallback(async (nextSessionId: string) => {
    setBusy(true); setError(null)
    try {
      const response = await trainingApi.getSession(nextSessionId)
      setSessionId(nextSessionId); setSession(response.session); setPage('training')
    } catch (reason) {
      setReviewError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setBusy(false) }
  }, [])

  const navigate = (next: Page) => {
    if (next === 'home') setPage('home')
    else if (next === 'skills') setPage('skills')
    else if (next === 'review' && profile) setPage('review')
    else if (next === 'profile' && profile) setPage('profile')
    else if (next === 'report' && profile) setPage('report')
    else if (next === 'admin') setPage('admin')
  }

  if (profileLoading) return <main className="loading-page" aria-live="polite">正在读取学习档案…</main>

  return <div className="app-shell">
    <AppHeader page={page} profile={profile} onNavigate={navigate} />
    {page === 'onboarding' && <OnboardingPage busy={busy} error={error} onCreate={createProfile} />}
    {page === 'home' && profile && <HomePage profile={profile} lessons={lessons} loading={lessonsLoading} catalogError={lessonsError} onRetry={() => void loadLessons(profile.school_stage)} onStart={start} isStarting={busy} error={error} />}
    {page === 'skills' && profile && <SkillsPage profile={profile} onStart={() => lessons[0] && start(lessons[0].id)} />}
    {page === 'review' && profile && <ReviewPage sessions={reviewSessions} loading={reviewsLoading} error={reviewError} onOpen={openReviewSession} />}
    {page === 'profile' && profile && <ProfilePage profile={profile} onStart={() => lessons[0] && start(lessons[0].id)} />}
    {page === 'report' && profile && <LearningReportPage summary={learningSummary} loading={summaryLoading} error={summaryError} achievements={achievements} achievementsLoading={achievementsLoading} achievementsError={achievementsError} onRetry={() => { void loadLearningSummary(profile.id); void loadAchievements(profile.id) }} onStart={() => lessons[0] && start(lessons[0].id)} onRecommendation={(kind) => navigate(kind === 'WEAK_SKILL' ? 'review' : 'home')} />}
    {page === 'admin' && <ContentAdminPage />}
    {page === 'training' && session && <TrainingPage session={session} busy={busy} error={error} onCommand={command} onReturnHome={() => setPage('home')} />}
    {page === 'training' && !session && <EmptyPage onHome={() => setPage('home')} />}
  </div>
}
