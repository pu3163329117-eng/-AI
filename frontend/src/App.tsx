import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { lessonApi, profileApi, trainingApi } from './api'
import type { CommandType, LearnerProfile, Lesson, ReviewSession, SchoolStage, TrainingSession } from './types'

type Page = 'home' | 'training' | 'skills' | 'review' | 'profile' | 'onboarding'

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
  }

  if (profileLoading) return <main className="loading-page" aria-live="polite">正在读取学习档案…</main>

  return <div className="app-shell">
    <AppHeader page={page} profile={profile} onNavigate={navigate} />
    {page === 'onboarding' && <OnboardingPage busy={busy} error={error} onCreate={createProfile} />}
    {page === 'home' && profile && <HomePage profile={profile} lessons={lessons} loading={lessonsLoading} catalogError={lessonsError} onRetry={() => void loadLessons(profile.school_stage)} onStart={start} isStarting={busy} error={error} />}
    {page === 'skills' && profile && <SkillsPage profile={profile} onStart={() => lessons[0] && start(lessons[0].id)} />}
    {page === 'review' && profile && <ReviewPage sessions={reviewSessions} loading={reviewsLoading} error={reviewError} onOpen={openReviewSession} />}
    {page === 'profile' && profile && <ProfilePage profile={profile} onStart={() => lessons[0] && start(lessons[0].id)} />}
    {page === 'training' && session && <TrainingPage session={session} busy={busy} error={error} onCommand={command} onReturnHome={() => setPage('home')} />}
    {page === 'training' && !session && <EmptyPage onHome={() => setPage('home')} />}
  </div>
}
