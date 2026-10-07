import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { adminLessonApi, lessonApi, profileApi, requestId, trainingApi } from './api'
import { errorMessage, uncertainWrite } from './http'
import { ConnectionStatus } from './components/ConnectionStatus'
import { RenderBoundary } from './components/RenderBoundary'
import { ContextReader } from './components/ContextReader'
import { EditorialSources } from './components/EditorialSources'
import { jumpTo, optionIndex, pageLabels, readRoute, routeHash, type Page } from './navigation'
import { usePageRoute, type ExitRisk } from './usePageRoute'
import './polish.css'
import type { Achievement, Achievements, AdminLesson, AdminLessonInput, CommandType, DailyMission, LearnerProfile, LearningSummary, Lesson, Mistake, PracticePlan, PracticePlanGroupBy, ReviewSession, SchoolStage, TrainingSession } from './types'

const taskLabels = ['识别已知', '推断变量', '回溯验证', '迁移挑战']
type PendingTrainingCommand = { sessionId: string; version: number; type: CommandType; payload: Record<string, unknown>; key: string }

function AppHeader({ page, profile, onNavigate }: { page: Page; profile: LearnerProfile | null; onNavigate: (page: Page) => void }) {
  return (
    <header className="app-header">
      <button className="brand" onClick={() => onNavigate('home')} aria-label="返回首页">
        文言 <span>·</span> 推理
      </button>
      <nav aria-label="主导航">
        {(['home', 'skills', 'practice', 'review', 'profile', 'report', 'admin'] as Page[]).map(target => {
          const disabled = !profile && !['home', 'skills', 'admin'].includes(target)
          const active = page === target || (target === 'home' && page === 'training')
          return <a key={target} href={routeHash({ page: target })} className={active ? 'is-active' : ''} aria-current={active ? 'page' : undefined}
            aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined}
            onClick={event => { if (disabled) { event.preventDefault(); return } if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); onNavigate(target) }}>
            {target === 'profile' ? '我的' : target === 'admin' ? '内容管理' : pageLabels[target]}
          </a>
        })}
      </nav>
      <button className="account" aria-label="查看学习档案" onClick={() => profile && onNavigate('profile')} disabled={!profile}>{profile?.display_name.slice(0, 1) ?? '—'}</button>
    </header>
  )
}

function HomePage({ profile, lessons, loading, catalogError, onRetry, onStart, isStarting, error, mission, missionLoading, missionError }: {
  profile: LearnerProfile
  lessons: Lesson[]
  loading: boolean
  catalogError: string | null
  onRetry: () => void
  onStart: (lessonId: string) => void
  isStarting: boolean
  error: string | null
  mission: DailyMission | null
  missionLoading: boolean
  missionError: string | null
}) {
  const todayLesson = mission?.recommended_lesson ?? lessons[0]
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
        <aside className="streak daily-mission" aria-label="今日任务进度">
          {missionLoading ? <><span>今日任务</span><strong>正在整理进度…</strong><small>读取今天的训练记录。</small></> : missionError ? <><span>今日任务</span><strong>进度暂不可用</strong><small>本次训练仍可正常开始。</small></> : mission ? <>
            <span>今日任务 · {mission.mission_date.slice(5).replace('-', ' 月 ')} 日</span>
            <div className="mission-progress"><b>{mission.completed_sessions_today}</b><small> / {mission.target_completed_sessions} 次</small></div>
            <strong>{mission.completed ? '今天的任务已完成。' : '完成一节完整训练。'}</strong>
            <progress value={Math.min(mission.completed_sessions_today, mission.target_completed_sessions)} max={mission.target_completed_sessions} aria-label={`今日已完成 ${mission.completed_sessions_today} / ${mission.target_completed_sessions} 次训练`} />
            <small>{mission.completed ? '可以复习错题，或继续探索下一关。' : '从证据出发，完成核心判断与迁移。'}</small>
          </> : <><span>今日任务</span><strong>完成一节完整训练。</strong><small>从证据出发，完成核心判断与迁移。</small></>}
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
  return <div className={compact ? 'catalog-state compact' : 'catalog-state'} role="alert"><b>暂时无法读取关卡目录。</b><p>{errorMessage(error)}</p><button className="text-button" onClick={onRetry}>重新读取 →</button></div>
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
        <p>档案保存在本机学习服务中，这个浏览器会记住你的入口。目前尚未接入账号登录和跨设备找回。</p>
      </section>
      <form className="profile-form" onSubmit={submit}>
        <label>怎么称呼你？<input type="text" autoComplete="nickname" value={name} maxLength={20} required disabled={busy} onChange={(event) => setName(event.target.value)} placeholder="例如：小林" autoFocus /></label>
        <fieldset disabled={busy}>
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

function formatReviewDate(value: string | null) {
  if (!value) return '最近一次作答时间待同步'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日复习过`
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
  onStartLesson: (lessonId: string) => void;
}) {
  return (
    <main className="review-page">
      <p className="eyebrow">复习</p>
      <h1>把走过的推理，<br />再走一遍。</h1>
      <p className="intro">错过的判断会留在错题本里；未完成的关卡也能从原处继续。每一次重练，都回到具体的语境和证据。</p>

      <section className="mistake-bank" aria-labelledby="mistake-bank-title">
        <header className="review-section-heading"><div><p className="eyebrow">错题本</p><h2 id="mistake-bank-title">回到当时没说清的地方。</h2></div>{!mistakesLoading && !mistakesError && <span>{mistakes.length} 个待回看</span>}</header>
        {mistakesLoading ? <div className="review-state" aria-live="polite"><b>正在整理错题本…</b><p>把每次尚未答对的语境和线索汇总到这里。</p></div>
          : mistakesError ? <div className="review-state" role="alert"><b>错题本暂时无法读取。</b><p>请确认本地服务仍在运行。错误代码：{mistakesError}</p><button className="text-button" onClick={onRetryMistakes}>重新读取 →</button></div>
            : mistakes.length === 0 ? <div className="review-state"><b>错题本还是空的。</b><p>继续认真作答；遇到需要回看的地方，会在这里留下清晰的复习入口。</p></div>
              : <div className="mistake-list">
                {mistakes.map((item) => <article className="mistake-row" key={item.lesson_id}>
                  <div className="mistake-index" aria-hidden="true"><span>{String(item.wrong_attempts).padStart(2, '0')}</span><small>次</small></div>
                  <div className="mistake-content"><p className="mistake-meta">{item.source} · {formatReviewDate(item.latest_attempt_at)}</p><h3>{item.title}</h3><p className="mistake-passage">“{item.passage}”</p><p className="mistake-variable"><b>回看词：</b>{item.variable}</p><p className="mistake-hint">{item.review_hint}</p></div>
                  <button className="button button-secondary mistake-action" onClick={() => onStartLesson(item.lesson_id)} disabled={startingLesson}>{startingLesson ? '正在进入…' : '重新练习'} <span aria-hidden="true">→</span></button>
                </article>)}
              </div>}
        {startError && <p className="request-error review-action-error" role="alert">无法开始复习：{startError}</p>}
      </section>

      <section className="review-history" aria-labelledby="review-history-title">
        <header className="review-section-heading"><div><p className="eyebrow">最近训练</p><h2 id="review-history-title">继续未走完的路径。</h2></div></header>
        {loading ? <p className="review-status">正在读取训练记录…</p> : error ? <p className="request-error" role="alert">无法读取训练记录：{error}</p> : sessions.length === 0 ? (
          <div className="review-empty"><b>还没有可回看的训练。</b><p>完成第一关后，它会出现在这里。</p></div>
        ) : (
          <div className="review-list" aria-label="最近训练记录">
          {sessions.map((item) => (
            <article key={item.session_id}>
              <div><span>{item.completed ? '已完成' : '进行中'}</span><strong>{item.source}</strong><p>{item.feedback}</p></div>
              <button className="text-button" onClick={() => onOpen(item.session_id)}>{item.completed ? '查看总结' : '继续练习'} →</button>
            </article>
          ))}
          </div>
        )}
      </section>
    </main>
  )
}

const practiceGroupOptions: Array<{ value: PracticePlanGroupBy; label: string; description: string }> = [
  { value: 'theme', label: '主题', description: '围绕同一阅读语境，连续练习。' },
  { value: 'textbook_tag', label: '教材标签', description: '按教材单元与篇目线索回看。' },
  { value: 'reasoning_point', label: '推理考点', description: '把同一种推断方法练得更扎实。' },
]

function SpecializedPracticePage({
  plans,
  groupBy,
  loading,
  error,
  startingLesson,
  startError,
  onGroupByChange,
  onRetry,
  onStartLesson,
}: {
  plans: PracticePlan[]
  groupBy: PracticePlanGroupBy
  loading: boolean
  error: string | null
  startingLesson: boolean
  startError: string | null
  onGroupByChange: (groupBy: PracticePlanGroupBy) => void
  onRetry: () => void
  onStartLesson: (lessonId: string) => void
}) {
  const [openPlanId, setOpenPlanId] = useState<string | null>(null)
  const activeOption = practiceGroupOptions.find((option) => option.value === groupBy) ?? practiceGroupOptions[0]

  useEffect(() => {
    setOpenPlanId((current) => plans.some((plan) => plan.id === current) ? current : plans[0]?.id ?? null)
  }, [plans, groupBy])

  return (
    <main className="practice-page">
      <header className="practice-heading">
        <div>
          <p className="eyebrow">专项练习</p>
          <h1>把一种方法，<br />练到会用。</h1>
          <p>从已发布课程中按同一线索重新组织训练。选择一个专题，连续完成其中的关卡。</p>
        </div>
        <aside className="practice-signal" aria-label="当前专项练习模式">
          <span>当前聚合</span>
          <strong>{activeOption.label}</strong>
          <small>{activeOption.description}</small>
        </aside>
      </header>

      <section className="practice-controls" aria-label="专项练习分类">
        <p>选择组织方式</p>
        <div role="tablist" aria-label="专项练习分类方式">
          {practiceGroupOptions.map((option) => <button
            key={option.value}
            type="button"
            role="tab"
            id={`practice-tab-${option.value}`}
            aria-selected={groupBy === option.value}
            aria-controls="practice-results"
            tabIndex={groupBy === option.value ? 0 : -1}
            className={groupBy === option.value ? 'is-active' : ''}
            onClick={() => onGroupByChange(option.value)}
            onKeyDown={event => {
              const next = optionIndex(event.key, practiceGroupOptions.indexOf(option), practiceGroupOptions.length)
              if (next === null) return
              event.preventDefault(); onGroupByChange(practiceGroupOptions[next].value)
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
            }}
          >{option.label}</button>)}
        </div>
      </section>

      <section className="practice-plan-list" id="practice-results" role="tabpanel" aria-labelledby={`practice-tab-${groupBy}`} aria-busy={loading}>
        <header className="practice-list-heading"><div><p className="eyebrow">课程专题</p><h2 id="practice-list-title">按{activeOption.label}组织的课程。</h2></div>{!loading && !error && <span>{plans.length} 个专题</span>}</header>
        {loading ? <div className="practice-state" aria-live="polite"><b>正在整理专项练习…</b><p>正在按{activeOption.label}汇总已发布的课程。</p></div>
          : error ? <div className="practice-state" role="alert"><b>专项练习暂时无法读取。</b><p>请确认本地服务仍在运行。错误代码：{error}</p><button className="text-button" onClick={onRetry}>重新读取 →</button></div>
            : plans.length === 0 ? <div className="practice-state"><b>暂时没有可用的专项练习。</b><p>教研内容发布并补齐{activeOption.label}后，会自动出现在这里。</p></div>
              : <div className="practice-plans">{plans.map((plan, planIndex) => {
                const isOpen = openPlanId === plan.id
                const count = plan.lessons.length || plan.lesson_count
                return <article className={isOpen ? 'practice-plan is-open' : 'practice-plan'} key={plan.id}>
                  <button className="practice-plan-summary" type="button" aria-expanded={isOpen} onClick={() => setOpenPlanId(isOpen ? null : plan.id)}>
                    <span className="practice-plan-index">{String(planIndex + 1).padStart(2, '0')}</span>
                    <span className="practice-plan-copy"><small>{count} 节课程</small><strong>{plan.label}</strong></span>
                    <span className="practice-plan-toggle" aria-hidden="true">{isOpen ? '收起 −' : '展开 +'}</span>
                  </button>
                  {isOpen && <div className="practice-lessons" aria-label={`${plan.label}课程列表`}>
                    {plan.lessons.length === 0 ? <p>这个专题暂时没有可开始的课程。</p> : plan.lessons.map((lesson, lessonIndex) => <article className="practice-lesson" key={lesson.id}>
                      <div><span>{String(lessonIndex + 1).padStart(2, '0')}</span><h3>{lesson.title}</h3><p>{lesson.summary}</p><small>{lesson.source} · {lesson.difficulty} · 约 {lesson.estimated_minutes} 分钟</small></div>
                      <button className="button button-secondary practice-start" onClick={() => onStartLesson(lesson.id)} disabled={startingLesson}>{startingLesson ? '正在进入…' : '开始练习'} <span aria-hidden="true">→</span></button>
                    </article>)}
                  </div>}
                </article>
              })}</div>}
        {startError && <p className="request-error practice-action-error" role="alert">无法开始专项练习：{startError}</p>}
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
    if (dirty && !window.confirm('当前有未保存修改，确定放弃并新建课程吗？')) return
    setActiveId('new'); setEditingLesson(null); setForm(emptyContentForm()); setSavedForm(emptyContentForm()); setFormError(null); setSuccess(null); setReviewNote('')
  }

  const openLesson = async (lessonId: string) => {
    if (dirty && !window.confirm('当前有未保存修改，确定切换课程吗？')) return
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

  const setField = <Key extends keyof ContentForm>(key: Key, value: ContentForm[Key]) => setForm((current) => ({ ...current, [key]: value }))

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!activeId || (activeId !== 'new' && !selectedLesson?.review?.content_version)) return
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
    setSaving(true)
    try {
      const response = activeId === 'new'
        ? await adminLessonApi.create(payload)
        : await adminLessonApi.update(activeId, payload, selectedLesson!.review!.content_version)
      setLessons((current) => {
        const withoutSaved = current.filter((lesson) => lesson.id !== response.lesson.id)
        return [...withoutSaved, response.lesson]
      })
      setActiveId(response.lesson.id)
      setEditingLesson(response.lesson)
      setForm(contentFormFromLesson(response.lesson))
      setSavedForm(contentFormFromLesson(response.lesson))
      setSuccess(activeId === 'new' ? '草稿已创建。核对两阶段的原文与来源后，请审核当前版本。' : response.lesson.status === 'DRAFT' ? '修改已保存。草稿需重新审核后发布，学生已有训练不受影响。' : '修改已保存，资料版本未变化。')
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setSaving(false) }
  }

  const publish = async () => {
    if (!activeId || activeId === 'new' || dirty || selectedLesson?.review?.status !== 'APPROVED' || !selectedLesson.review.content_version) return
    setPublishing(true); setFormError(null); setSuccess(null)
    try {
      const response = await adminLessonApi.publish(activeId, selectedLesson.review.content_version)
      setEditingLesson(response.lesson)
      setLessons((current) => current.map((lesson) => lesson.id === response.lesson.id ? response.lesson : lesson))
      setForm(contentFormFromLesson(response.lesson))
      setSavedForm(contentFormFromLesson(response.lesson))
      setSuccess('关卡已发布，现在会出现在对应学段的学习目录中。')
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setPublishing(false) }
  }

  // Keep the detail version bound to its visible form. Refreshing the list must
  // not silently approve a different version that this editor has not loaded.
  const selectedLesson = editingLesson?.id === activeId ? editingLesson : null
  const dirty = activeId === 'new' ? JSON.stringify(form) !== JSON.stringify(emptyContentForm()) : JSON.stringify(form) !== JSON.stringify(savedForm)
  const working = saving || reviewing || publishing || detailLoading
  useLayoutEffect(() => {
    onExitRiskChange(working ? 'working' : dirty ? 'dirty' : null)
    return () => onExitRiskChange(null)
  }, [working, dirty, onExitRiskChange])
  const reviewStatus = selectedLesson?.review?.status
  const reviewLabel = dirty ? '有未保存修改，请先保存后审核' : reviewStatus === 'APPROVED' ? '当前版本已审核' : reviewStatus === 'STALE' ? '资料已变化，需重新审核' : '尚未审核'
  const review = async () => {
    if (!activeId || activeId === 'new' || dirty || !reviewer.trim() || !selectedLesson?.review?.content_version) return
    setReviewing(true); setFormError(null); setSuccess(null)
    try {
      const response = await adminLessonApi.review(activeId, reviewer.trim(), reviewNote.trim(), selectedLesson.review.content_version)
      setEditingLesson(response.lesson)
      setLessons(current => current.map(lesson => lesson.id === response.lesson.id ? response.lesson : lesson))
      setForm(contentFormFromLesson(response.lesson)); setSavedForm(contentFormFromLesson(response.lesson))
      setSuccess('已记录本地教研审核。请确认当前版本后，再点击发布关卡。')
    } catch (reason) { setFormError(reason instanceof Error ? reason.message : 'REQUEST_FAILED') }
    finally { setReviewing(false) }
  }
  const errorLabels: Record<string, string> = { LESSON_REVIEW_REQUIRED: '当前版本尚未审核，请先核对来源并审核。', LESSON_REVIEW_NOT_READY: '来源或训练资料不完整，请按下方检查项补齐后保存。', CONTENT_JSON_INVALID: '训练 JSON 格式有误，请检查引号、括号和逗号。', CONTENT_STAGES_REQUIRED: '请同时填写 CORE 和 TRANSFER；仅建立课程骨架时可将两者都留空。', CONTENT_OBJECT_REQUIRED: '每个阶段的 JSON 必须是对象，不能是数组、文字或空值。', LESSON_CONTENT_INVALID: '题目字段不完整：请核对题文、目标词、证据、正确答案及选项。', LESSON_READING_CONTEXT_INVALID: '阅读资料格式有误，paragraphs 必须是非空段落数组。', ESTIMATED_MINUTES_INVALID: '预计时长必须是大于 0 的整数。', REQUEST_FAILED: '请求未完成，请检查必填字段或稍后重试。' }
  Object.assign(errorLabels, { LESSON_REVIEW_VERSION_CONFLICT: '资料已在其他页面修改，不能审核未读的新版本。请重新读取并核对。', LESSON_PUBLISH_VERSION_CONFLICT: '资料版本已变化，不能发布旧页面所见版本。请重新读取并核对。', LESSON_EDIT_VERSION_CONFLICT: '其他页面已修改此课程；本次未覆盖新版本。请先复制自己的修改，再重新读取。' })
  for (const code of ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE', 'SERVER_UNAVAILABLE']) errorLabels[code] = errorMessage(code)
  const versionConflict = ['LESSON_REVIEW_VERSION_CONFLICT', 'LESSON_PUBLISH_VERSION_CONFLICT', 'LESSON_EDIT_VERSION_CONFLICT'].includes(formError ?? '')
  return (
    <main className="content-admin-page">
      <header className="admin-heading">
        <div><p className="eyebrow">教研工作台</p><h1>来源有据，<br />版本可追溯。</h1><p>保存草稿 → 核对来源并审核 → 发布当前版本。已发布课程修改后，需重新审核。</p></div>
        <button className="button button-primary" onClick={openNew} disabled={working}>创建新关卡 <span aria-hidden="true">+</span></button>
      </header>
      <div className="admin-workspace">
        <aside className="admin-list" aria-label="关卡列表">
          <div className="admin-list-title"><b>全部关卡</b><button className="text-button" onClick={() => void loadLessons()} disabled={loading}>刷新</button></div>
          {loading ? <p className="admin-state">正在读取关卡…</p> : listError ? <div className="admin-state" role="alert"><b>无法读取关卡。</b><p>错误代码：{listError}</p><button className="text-button" onClick={() => void loadLessons()}>重新读取 →</button></div> : lessons.length === 0 ? <p className="admin-state">还没有教研关卡。创建第一份草稿开始编辑。</p> : <div className="admin-lesson-list">
            {lessons.map((lesson) => <button key={lesson.id} disabled={working} className={activeId === lesson.id ? 'selected' : ''} onClick={() => void openLesson(lesson.id)}><span className={`status-badge ${lesson.status === 'PUBLISHED' ? 'published' : ''}`}>{lesson.status === 'PUBLISHED' ? '已发布' : '草稿'} · {lesson.review?.status === 'APPROVED' ? '已审核' : lesson.review?.status === 'STALE' ? '审核失效' : '待审核'}</span><strong>{lesson.title}</strong><small>{lesson.school_stage === 'JUNIOR' ? '初中' : '高中'} · {lesson.source}</small></button>)}
          </div>}
        </aside>
        <section className="admin-editor" aria-live="polite">
          {!activeId ? <div className="admin-placeholder">{formError && <p role="alert" className="request-error">关卡详情读取失败，请重新选择课程。（{formError}）</p>}<p className="eyebrow">内容管理</p><h2>选择一份关卡，<br />或新建草稿。</h2><p>这里记录课程的学习对象、教材位置、关键积累与推理路径。</p><button className="button button-primary" onClick={openNew}>创建新关卡 <span aria-hidden="true">→</span></button></div> : detailLoading ? <p className="admin-state">正在读取关卡详情…</p> : <form className="lesson-editor-form" onSubmit={submit}>
            <div className="editor-topline"><div><p className="eyebrow">{activeId === 'new' ? '新建草稿' : selectedLesson?.status === 'PUBLISHED' ? '已发布关卡' : '草稿关卡'}{dirty && ' · 有未保存修改'}</p><h2>{activeId === 'new' ? '建立课程骨架' : form.title || '未命名关卡'}</h2></div>{activeId !== 'new' && <button type="button" className="button button-secondary" onClick={publish} disabled={working || dirty || reviewStatus !== 'APPROVED' || selectedLesson?.status === 'PUBLISHED'}>{selectedLesson?.status === 'PUBLISHED' ? '已发布' : publishing ? '正在发布…' : '发布关卡'}</button>}</div>
            {activeId !== 'new' && <section className="editor-review" aria-label="资料版本与教研审核">
              <div className="review-version-line"><strong>{reviewLabel}</strong><span>版本 {selectedLesson?.review?.content_version ?? '读取中'}</span></div>
              <p>本地审核是署名记录，不代表已接入账号认证。请实际核对原文、题源、词义、选项与提示；系统只检查资料结构和版本一致性。</p>
              {selectedLesson?.review?.reviewer && <p>最近审核：{selectedLesson.review.reviewer}{selectedLesson.review.reviewed_at && ` · ${new Date(selectedLesson.review.reviewed_at).toLocaleString('zh-CN')}`}。{selectedLesson.review.note}</p>}
              {!!selectedLesson?.review?.issues?.length && <div className="review-issues"><b>发布前检查</b><ul>{selectedLesson.review.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div>}
              <div className="review-signoff"><label>审核人<input maxLength={80} value={reviewer} disabled={working} onChange={event => setReviewer(event.target.value)} placeholder="填写实际审核人的署名" /></label><label>审核说明<textarea maxLength={2000} value={reviewNote} disabled={working} onChange={event => setReviewNote(event.target.value)} placeholder="例如：核对原文版本、题源和词义注释" /></label></div>
              <button type="button" className="button button-secondary" disabled={working || dirty || !reviewer.trim() || !!selectedLesson?.review?.issues?.length} onClick={review}>{reviewing ? '正在记录审核…' : '确认审核当前版本'}</button>
              {dirty && <p>请先保存修改，再审核和发布，避免审核到旧版本。</p>}
            </section>}
            <fieldset className="editor-section" disabled={working}><legend>课程定位</legend><div className="field-grid"><label>学段<select value={form.school_stage} onChange={(event) => setField('school_stage', event.target.value as SchoolStage)}><option value="JUNIOR">初中</option><option value="SENIOR">高中</option></select></label><label>教材标签（用逗号分隔）<input value={form.textbook_tags} onChange={(event) => setField('textbook_tags', event.target.value)} placeholder="部编版, 七年级上册" /></label><label>主题<input value={form.theme} onChange={(event) => setField('theme', event.target.value)} placeholder="语境推断" /></label></div></fieldset>
            <fieldset className="editor-section" disabled={working}><legend>关卡信息</legend><div className="field-grid"><label className="span-two">题目<input required value={form.title} onChange={(event) => setField('title', event.target.value)} placeholder="例如：从人物关系推断词义" /></label><label>出处<input required value={form.source} onChange={(event) => setField('source', event.target.value)} placeholder="《陈涉世家》" /></label><label>难度<input required value={form.difficulty} onChange={(event) => setField('difficulty', event.target.value)} placeholder="进阶" /></label><label>预计时长（分钟）<input required min="1" type="number" inputMode="numeric" value={form.estimated_minutes} onChange={(event) => setField('estimated_minutes', event.target.value)} /></label><label className="span-two">学习摘要<textarea required value={form.summary} onChange={(event) => setField('summary', event.target.value)} placeholder="说明本关要完成的理解与推断任务。" /></label></div></fieldset>
            <fieldset className="editor-section" disabled={working}><legend>教研标注</legend><div className="field-grid"><label>积累点（每行一项）<textarea value={form.accumulation_points} onChange={(event) => setField('accumulation_points', event.target.value)} placeholder="实词义项\n人物关系" /></label><label>推理点（每行一项）<textarea value={form.reasoning_points} onChange={(event) => setField('reasoning_points', event.target.value)} placeholder="从人物动作寻找依据\n排除不合语境的义项" /></label><label className="span-two">推理层级<input value={form.reasoning_level} onChange={(event) => setField('reasoning_level', event.target.value)} placeholder="如：语境定位 → 关系推断 → 回溯验证" /></label></div></fieldset>
            <fieldset className="editor-section" disabled={working}><legend>训练内容</legend><p className="field-note">CORE 与 TRANSFER 均需提供原文、题目和 reading_context；其中填写 paragraphs、source_url、text_version、author、era 和材料范围 extent。全文与节选必须如实标注。</p><div className="field-grid"><label>CORE（核心训练 JSON）<textarea className="code-input" value={form.core_content} onChange={(event) => setField('core_content', event.target.value)} placeholder={'{\n  "passage": "…"\n}'} /></label><label>TRANSFER（迁移训练 JSON）<textarea className="code-input" value={form.transfer_content} onChange={(event) => setField('transfer_content', event.target.value)} placeholder={'{\n  "passage": "…"\n}'} /></label></div></fieldset>
            <EditorialSources core={form.core_content} transfer={form.transfer_content} />
            {versionConflict && activeId && activeId !== 'new' && <button type="button" className="button button-secondary" disabled={working} onClick={() => void openLesson(activeId)}>重新读取当前课程</button>}
            <div className="editor-actions"><button className="button button-primary" disabled={working}>{saving ? '正在保存…' : activeId === 'new' ? '保存草稿' : '保存修改'} <span aria-hidden="true">→</span></button>{formError && <p className="request-error" role="alert">操作未完成：{errorLabels[formError] ?? formError}</p>}{success && <p className="request-success" role="status">{success}</p>}</div>
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


function TrainingPage({ sessionId, session, busy, pendingCommand, error, recoveryNeeded, onRecover, onCommand, onReturnHome }: {
  sessionId: string
  session: TrainingSession
  busy: boolean
  pendingCommand: CommandType | null
  error: string | null
  recoveryNeeded: boolean
  onRecover: () => void
  onCommand: (type: CommandType, payload?: Record<string, unknown>) => void
  onReturnHome: () => void
}) {
  const [answer, setAnswer] = useState<string | null>(session.selected_answer)
  useEffect(() => setAnswer(session.selected_answer), [session.selected_answer, session.stage])
  const lastStep = useRef({ stage: session.stage, completed: session.completed })
  useEffect(() => {
    if (lastStep.current.stage === session.stage && lastStep.current.completed === session.completed) return
    lastStep.current = { stage: session.stage, completed: session.completed }
    const frame = requestAnimationFrame(() => jumpTo(session.completed ? 'summary-title' : 'training-question'))
    return () => cancelAnimationFrame(frame)
  }, [session.stage, session.completed])
  const pendingLabels: Partial<Record<CommandType, string>> = { SUBMIT_ATTEMPT: '正在核验判断…', REQUEST_MORE_CONTEXT: '正在保存点读位置与语境…', SELECT_EVIDENCE: '正在记录证据…', DEFER_VARIABLE: '正在暂放变量…', REVISIT_VARIABLE: '正在恢复判断…', REQUEST_HINT: '正在读取提示…', CONTINUE_TO_TRANSFER: '正在准备迁移挑战…', COMPLETE_SESSION: '正在保存本关总结…' }
  const locked = busy || recoveryNeeded
  useEffect(() => {
    if (!recoveryNeeded) return
    const frame = requestAnimationFrame(() => jumpTo('command-recovery-title'))
    return () => cancelAnimationFrame(frame)
  }, [recoveryNeeded])

  const submit = () => answer && onCommand('SUBMIT_ATTEMPT', { answer })
  const isTransferReady = session.transfer_ready && !session.completed
  const isSummaryReady = session.summary_ready && !session.completed
  const currentStep = session.completed ? 4 : session.stage === 'TRANSFER' ? 3 : 1
  const variableIndex = session.passage.indexOf(session.variable)
  const beforeVariable = variableIndex < 0 ? session.passage : session.passage.slice(0, variableIndex)
  const afterVariable = variableIndex < 0 ? '' : session.passage.slice(variableIndex + session.variable.length)

  return (
    <main className="training-page">
      <div className="training-shell">
        <aside className="step-list" aria-label="训练步骤">
          <b>本次训练</b>
          {taskLabels.map((label, index) => <span className={index < currentStep ? 'done' : index === currentStep ? 'current' : ''} key={label}>{label}</span>)}
        </aside>
        <aside className="evidence-panel" aria-label="推理工具">
          <b>证据板</b>
          <button className={session.evidence_selected ? 'selected' : ''} onClick={() => onCommand('SELECT_EVIDENCE')} disabled={locked || session.completed}>
            <span aria-hidden="true">“</span>{session.evidence}<span aria-hidden="true">”</span>
          </button>
          <hr />
          <button className="quiet-action" onClick={() => onCommand('DEFER_VARIABLE')} disabled={locked || session.completed || session.deferred}>{session.deferred ? '已暂放，先扩大语境' : '先暂放这个字'}</button>
          {session.deferred && <button className="quiet-action revisit-action" onClick={() => onCommand('REVISIT_VARIABLE')} disabled={locked || session.completed}>回看这个字，继续判断</button>}
          <button className="quiet-action" onClick={() => onCommand('REQUEST_HINT')} disabled={locked || session.completed}>需要一点提示</button>
          {session.hint && <p className="hint">第 {session.hint_level} 条提示：{session.hint}</p>}
        </aside>
        <section className="lesson" aria-labelledby="question-title">
          <div className="lesson-meta"><span>{session.source}</span><span>{session.stage === 'CORE' ? '02 / 04' : '04 / 04'}</span></div>
          {session.completed && session.summary ? (
            <LessonSummary summary={session.summary} onReturnHome={onReturnHome} />
          ) : (
            <>
              <section className="training-task" id="training-question" tabIndex={-1} key={`task-${session.stage}`}>
              <div className="training-task-heading"><p className="stage-label">当前判断 · 先读原文，再回到词上</p><button className="text-button" onClick={() => jumpTo('fulltext-title')}>阅读完整原文 ↓</button></div>
              <p className="passage">{beforeVariable}{variableIndex >= 0 && <span>{session.variable}</span>}{afterVariable}</p>
              <div className="question-area">
                <p className="stage-label">{session.stage === 'CORE' ? '先完成原文推理' : '陌生文迁移挑战'}</p>
                <h1 id="question-title">{session.question}</h1>
                <div className="choice-list" role="radiogroup" aria-label="选择词义">
                  {session.choices.map(choice => <label key={choice} className={`choice-option${answer === choice ? ' selected' : ''}`}>
                    <input type="radio" name={`answer-${sessionId}-${session.stage}`} value={choice} checked={answer === choice} disabled={locked} onChange={() => setAnswer(choice)} />
                    <span>{choice}</span>
                  </label>)}
                </div>
                <button className="button button-primary submit" onClick={submit} disabled={!answer || locked}>
                  {pendingCommand === 'SUBMIT_ATTEMPT' ? '正在核验…' : busy ? '请等待当前操作…' : '提交判断'}
                </button>
              </div>
              <div className={`feedback ${isTransferReady || isSummaryReady ? 'success' : ''}`} aria-live="polite">
                {busy ? pendingLabels[pendingCommand ?? 'SUBMIT_ATTEMPT'] ?? '正在处理当前操作…' : error ? `${recoveryNeeded ? '操作结果未确认' : '操作未完成'}：${error}` : session.feedback}
              </div>
              {recoveryNeeded && <div className="command-recovery" role="alert"><h3 id="command-recovery-title" tabIndex={-1}>刚才操作的结果尚未确认。</h3><p>服务可能已收到请求。本页暂不接受新操作；核对会沿用同一请求标识，避免重复记录或加分。刷新只重新读取进度，不自动提交。</p><button className="button button-secondary" disabled={busy} onClick={onRecover}>{busy ? '正在核对…' : '核对并重试刚才操作'}</button></div>}
              {isTransferReady && <button className="text-button" onClick={() => onCommand('CONTINUE_TO_TRANSFER')} disabled={locked}>进入陌生文挑战 →</button>}
              {isSummaryReady && <button className="text-button" onClick={() => onCommand('COMPLETE_SESSION')} disabled={locked}>查看本关总结 →</button>}
              </section>
              <ContextReader key={session.stage} sessionId={sessionId} session={session} busy={locked} onCommand={onCommand} />
              <nav className="reading-shortcuts" aria-label="训练页快捷操作"><button onClick={() => jumpTo('fulltext-title')}>阅读原文</button><button onClick={() => jumpTo('training-question')}>回到题目 ↑</button></nav>
            </>
          )}
        </section>
      </div>
    </main>
  )
}

function LessonSummary({ summary, onReturnHome }: { summary: NonNullable<TrainingSession['summary']>; onReturnHome: () => void }) {
  return (
    <section className="lesson-summary" aria-labelledby="summary-title">
      <p className="stage-label">本关总结</p>
      <h1 id="summary-title" tabIndex={-1}>你不是猜对，<br />是推出来的。</h1>
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
      <p className="eyebrow">能力地图</p>
      <h1>把每一次判断，<br />留下可回看的路径。</h1>
      <p className="intro">这里展示实际作答事件中的词义判断记录，不再按完成关卡数推算能力。判断正确率不等同于完整推理能力测评。</p>
      <section className="skill-list" aria-label="当前能力">
        {loading ? <p role="status">正在读取实际判断记录…</p> : error ? <div role="alert"><p>判断记录暂时未能读取。</p><button className="text-button" onClick={onRetry}>重新读取</button></div> : skills.length === 0 ? <div className="catalog-state"><b>还没有足够的判断记录。</b><p>完成作答后，这里会逐项显示真实样本，不把未知能力显示成零分。</p></div> : skills.map(skill => (
          <article className="skill-row" key={skill.label}>
            <div><strong>{skill.label}</strong><p>{skill.attempts} 次判断记录{skill.attempts < 5 ? ' · 样本较少，仅供回看' : ' · 建议结合证据与迁移表现回看'}</p></div>
            <div className="meter" aria-label={`${skill.label} 判断正确率 ${normalizedAccuracy(skill.accuracy)}%`}><i style={{ width: `${normalizedAccuracy(skill.accuracy)}%` }} /></div>
            <b>{normalizedAccuracy(skill.accuracy)}<small>%</small></b>
          </article>
        ))}
      </section>
      <button className="button button-primary" onClick={onStart}>继续今日训练 <span aria-hidden="true">→</span></button>
    </main>
  )
}

export function App() {
  const exitRisk = useRef<ExitRisk>(null)
  const { route, page, setPage } = usePageRoute(exitRisk)
  const onExitRiskChange = useCallback((risk: ExitRisk) => { exitRisk.current = risk }, [])
  const [profile, setProfile] = useState<LearnerProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(true)
  const [profileLoadAttempt, setProfileLoadAttempt] = useState(0)
  const [profileLoadError, setProfileLoadError] = useState<string | null>(null)
  const [reviewSessions, setReviewSessions] = useState<ReviewSession[]>([])
  const [reviewsLoading, setReviewsLoading] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
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
  const [uncertainCommand, setUncertainCommand] = useState<PendingTrainingCommand | null>(null)
  const operationLock = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [routeSessionLoading, setRouteSessionLoading] = useState(false)
  const [routeSessionError, setRouteSessionError] = useState<string | null>(null)
  const [routeSessionAttempt, setRouteSessionAttempt] = useState(0)

  useLayoutEffect(() => {
    if (pendingCommand) exitRisk.current = 'working'
    else if (uncertainCommand && page === 'training' && uncertainCommand.sessionId === sessionId) exitRisk.current = 'uncertain'
    else if (page !== 'admin') exitRisk.current = null
  }, [pendingCommand, uncertainCommand, sessionId, page])

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
    const storedProfileId = window.localStorage.getItem('wenyan.profile-id')
    if (!storedProfileId) {
      setProfileLoading(false); if (page !== 'admin') setPage('onboarding', undefined, true)
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
          if (readRoute(location.hash).page !== 'admin') setPage('onboarding', undefined, true)
        } else setProfileLoadError('暂时无法连接学习服务，档案和训练入口已保留。请检查后端是否启动后重试。')
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
    if (operationLock.current) return
    operationLock.current = true
    setBusy(true); setError(null)
    try {
      const response = await profileApi.create(displayName, schoolStage)
      window.localStorage.setItem('wenyan.profile-id', response.profile.id)
      setProfile(response.profile)
      setPage('home')
    } catch (reason) {
      setError(errorMessage(reason))
    } finally { setBusy(false); operationLock.current = false }
  }, [])

  const loadMistakes = useCallback(async (profileId: string) => {
    setMistakesLoading(true); setMistakesError(null)
    try {
      const response = await profileApi.listMistakes(profileId)
      setMistakes(response.mistakes)
    } catch (reason) {
      setMistakes([])
      setMistakesError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setMistakesLoading(false) }
  }, [])

  useEffect(() => {
    if (page !== 'review' || !profile) return
    setReviewsLoading(true); setReviewError(null)
    profileApi.listSessions(profile.id)
      .then(({ sessions }) => setReviewSessions(sessions))
      .catch((reason) => setReviewError(reason instanceof Error ? reason.message : 'REQUEST_FAILED'))
      .finally(() => setReviewsLoading(false))
    void loadMistakes(profile.id)
  }, [page, profile, loadMistakes])

  const loadPracticePlans = useCallback(async (profileId: string, groupBy: PracticePlanGroupBy) => {
    const request = ++practiceRequest.current
    setPracticeLoading(true); setPracticeError(null)
    try {
      const response = await profileApi.getPracticePlans(profileId, groupBy)
      if (request === practiceRequest.current) setPracticePlans(response.plans)
    } catch (reason) {
      if (request === practiceRequest.current) { setPracticePlans([]); setPracticeError(reason instanceof Error ? reason.message : 'REQUEST_FAILED') }
    } finally { if (request === practiceRequest.current) setPracticeLoading(false) }
  }, [])

  useEffect(() => {
    if (page === 'practice' && profile) void loadPracticePlans(profile.id, practiceGroupBy)
  }, [page, profile, practiceGroupBy, loadPracticePlans])

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

  const loadDailyMission = useCallback(async (profileId: string) => {
    setMissionLoading(true); setMissionError(null)
    try {
      const response = await profileApi.getDailyMission(profileId)
      setDailyMission(response.mission)
    } catch (reason) {
      setDailyMission(null)
      setMissionError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setMissionLoading(false) }
  }, [])

  useEffect(() => {
    if (page === 'home' && profile) void loadDailyMission(profile.id)
  }, [page, profile, loadDailyMission])

  useEffect(() => {
    if ((page === 'report' || page === 'skills') && profile) {
      void loadLearningSummary(profile.id)
      if (page === 'report') void loadAchievements(profile.id)
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
    if (operationLock.current) return
    if (!profile) { setPage('onboarding'); return }
    operationLock.current = true
    setBusy(true); setError(null)
    try {
      const response = await trainingApi.createSession(profile.id, lessonId)
      window.localStorage.setItem('wenyan.active-session', JSON.stringify({ profileId: profile.id, sessionId: response.session_id }))
      setSessionId(response.session_id); setSession(response.session); setPage('training', response.session_id)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally { setBusy(false); operationLock.current = false }
  }, [profile, busy])

  const runCommand = useCallback(async (intent: PendingTrainingCommand) => {
    if (operationLock.current) return
    operationLock.current = true
    setPendingCommand(intent.type)
    setBusy(true); setError(null)
    try {
      const response = await trainingApi.command(intent.sessionId, intent.version, intent.type, intent.payload, intent.key)
      setSession(response.session)
      if (response.profile) setProfile(response.profile)
      setUncertainCommand(null)
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : 'REQUEST_FAILED'
      if (uncertainWrite(reason)) {
        setUncertainCommand(intent); setError(errorMessage(reason))
      } else if (code === 'VERSION_CONFLICT') {
        setUncertainCommand(null)
        try { setSession((await trainingApi.getSession(intent.sessionId)).session) } catch { /* Keep local state until retry. */ }
        setError('训练已在其他页面更新，已尝试同步。请确认当前内容后重试。')
      } else { setUncertainCommand(null); setError(code === 'INVALID_CONTEXT_SELECTION' ? '所选词组超出原文范围，请重新点选。' : errorMessage(reason)) }
    } finally { setBusy(false); setPendingCommand(null); operationLock.current = false }
  }, [])
  const command = useCallback((type: CommandType, payload: Record<string, unknown> = {}) => {
    if (!sessionId || !session || operationLock.current || uncertainCommand?.sessionId === sessionId) return
    void runCommand({ sessionId, version: session.state_version, type, payload, key: requestId() })
  }, [session, sessionId, uncertainCommand, runCommand])

  const openReviewSession = useCallback(async (nextSessionId: string) => {
    if (operationLock.current) return
    operationLock.current = true
    setBusy(true); setError(null)
    try {
      const response = await trainingApi.getSession(nextSessionId)
      if (response.session.profile_id) window.localStorage.setItem('wenyan.active-session', JSON.stringify({ profileId: response.session.profile_id, sessionId: nextSessionId }))
      setSessionId(nextSessionId); setSession(response.session); setPage('training', nextSessionId)
    } catch (reason) {
      setReviewError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setBusy(false); operationLock.current = false }
  }, [busy])

  const navigate = (next: Page) => {
    if (!profile && next !== 'admin') { setPage('onboarding'); return }
    if (next === 'home') setPage('home')
    else if (next === 'skills') setPage('skills')
    else if (next === 'practice' && profile) setPage('practice')
    else if (next === 'review' && profile) setPage('review')
    else if (next === 'profile' && profile) setPage('profile')
    else if (next === 'report' && profile) setPage('report')
    else if (next === 'admin') setPage('admin')
  }

  if (profileLoading) return <main className="loading-page" aria-live="polite">正在读取学习档案…</main>
  if (profileLoadError) return <main className="loading-page" aria-live="polite"><div><p>{profileLoadError}</p><button className="button button-primary" onClick={() => setProfileLoadAttempt(attempt => attempt + 1)}>重试读取档案</button></div></main>

  return <div className="app-shell polished">
    <a className="skip-link" href="#page-content" onClick={event => { event.preventDefault(); jumpTo('page-content') }}>跳到主要内容</a>
    <AppHeader page={page} profile={profile} onNavigate={navigate} />
    <ConnectionStatus />
    <div className="page-view" id="page-content" tabIndex={-1} key={`${page}:${route.sessionId ?? ''}`}>
    <RenderBoundary onHome={() => navigate('home')}>
    {(page === 'onboarding' || (!profile && (page === 'home' || page === 'skills'))) && <OnboardingPage busy={busy} error={error} onCreate={createProfile} />}
    {page === 'home' && profile && <HomePage profile={profile} lessons={lessons} loading={lessonsLoading} catalogError={lessonsError} onRetry={() => void loadLessons(profile.school_stage)} onStart={start} isStarting={busy} error={error} mission={dailyMission} missionLoading={missionLoading} missionError={missionError} />}
    {page === 'skills' && profile && <SkillsPage summary={learningSummary} loading={summaryLoading} error={summaryError} onRetry={() => void loadLearningSummary(profile.id)} onStart={() => lessons[0] && start(lessons[0].id)} />}
    {page === 'practice' && profile && <SpecializedPracticePage plans={practicePlans} groupBy={practiceGroupBy} loading={practiceLoading} error={practiceError} startingLesson={busy} startError={error} onGroupByChange={setPracticeGroupBy} onRetry={() => void loadPracticePlans(profile.id, practiceGroupBy)} onStartLesson={start} />}
    {page === 'review' && profile && <ReviewPage sessions={reviewSessions} loading={reviewsLoading} error={reviewError} mistakes={mistakes} mistakesLoading={mistakesLoading} mistakesError={mistakesError} startingLesson={busy} startError={error} onOpen={openReviewSession} onRetryMistakes={() => void loadMistakes(profile.id)} onStartLesson={start} />}
    {page === 'profile' && profile && <ProfilePage profile={profile} onStart={() => lessons[0] && start(lessons[0].id)} />}
    {page === 'report' && profile && <LearningReportPage summary={learningSummary} loading={summaryLoading} error={summaryError} achievements={achievements} achievementsLoading={achievementsLoading} achievementsError={achievementsError} onRetry={() => { void loadLearningSummary(profile.id); void loadAchievements(profile.id) }} onStart={() => lessons[0] && start(lessons[0].id)} onRecommendation={(kind) => navigate(kind === 'WEAK_SKILL' ? 'review' : 'home')} />}
    {page === 'admin' && <ContentAdminPage onExitRiskChange={onExitRiskChange} />}
    {page === 'training' && (routeSessionLoading || (!!route.sessionId && route.sessionId !== sessionId)) && <main className="route-state">{routeSessionError ? <div role="alert"><p>{routeSessionError}</p><button className="button button-primary" onClick={() => setRouteSessionAttempt(n => n + 1)}>重试读取</button><button className="text-button" onClick={() => setPage('review')}>返回复习</button></div> : <p role="status">正在恢复这次训练…</p>}</main>}
    {page === 'training' && !routeSessionLoading && session && sessionId && route.sessionId === sessionId && <TrainingPage key={sessionId} sessionId={sessionId} session={session} busy={busy} pendingCommand={pendingCommand} error={error} recoveryNeeded={uncertainCommand?.sessionId === sessionId} onRecover={() => uncertainCommand && void runCommand(uncertainCommand)} onCommand={command} onReturnHome={() => { window.localStorage.removeItem('wenyan.active-session'); setPage('home') }} />}
    {page === 'training' && !route.sessionId && <EmptyPage onHome={() => setPage('home')} />}
    </RenderBoundary>
    </div>
  </div>
}
