import { RecommendationQueue } from './RecommendationQueue'
import { errorMessage } from '../http'
import type { DailyMission, LearnerProfile, Lesson } from '../types'
import type { ExitRisk } from '../usePageRoute'
import './readingHomePage.css'
import { InkScene } from '../motion/InkScene'
import { RepellingTitle } from '../motion/RepellingTitle'

export type ReadingHomePageProps = {
  profile: LearnerProfile; lessons: Lesson[]; loading: boolean; catalogError: string | null
  onRetry: () => void; onStart: (lessonId: string) => void; onAssessment: () => void; onPractice: () => void
  onStartSession: (sessionId: string) => void; onRiskChange: (risk: ExitRisk) => void
  isStarting: boolean; error: string | null; mission: DailyMission | null; missionLoading: boolean; missionError: string | null
  inkMotion?: { enabled: boolean }
}

/** Visual composition only. Lesson selection and all writes remain owned by App. */
export function ReadingHomePage({ profile, lessons, loading, catalogError, onRetry, onStart, onAssessment, onPractice, onStartSession, onRiskChange, isStarting, error, mission, missionLoading, missionError, inkMotion }: ReadingHomePageProps) {
  const todayLesson = mission?.recommended_lesson ?? lessons[0]
  const stageLabel = profile.school_stage === 'JUNIOR' ? '初中' : '高中'
  return <main className="reading-home" aria-labelledby="home-title">
    <header className="reading-home-welcome"><p className="eyebrow">今日书房 · {stageLabel}分级</p><p>从原文出发，把依据说清楚。</p></header>
    <section className={`reading-home-today${inkMotion ? ' has-ink-scene' : ''}`} aria-label="今日阅读与任务">
      {inkMotion && <InkScene enabled={inkMotion.enabled} sceneKey="home" />}
      <div className="reading-home-current">
        <p className="eyebrow">本次阅读</p>
        {loading ? <><h1 id="home-title">正在准备你的阅读。</h1><CatalogLoading /></> : catalogError ? <><h1 id="home-title">先把文章找回来。</h1><CatalogError error={catalogError} onRetry={onRetry} /></> : todayLesson ? <>
          {inkMotion ? <RepellingTitle id="home-title" text={todayLesson.title} enabled={inkMotion.enabled} /> : <h1 id="home-title">{todayLesson.title}</h1>}
          <p className="reading-home-summary">{todayLesson.summary}</p>
          <p className="reading-home-meta">{todayLesson.source} · {todayLesson.difficulty} · 约 {todayLesson.estimated_minutes} 分钟</p>
          <button type="button" className="button button-primary reading-home-start" onClick={() => onStart(todayLesson.id)} disabled={isStarting}>
            {isStarting ? '正在准备训练…' : '开始今日关卡'} <span aria-hidden="true">→</span>
          </button>
        </> : <><h1 id="home-title">等一篇适合你的文章。</h1><CatalogEmpty stageLabel={stageLabel} /></>}
        {error && <p className="request-error" role="alert">无法开始训练：{error}</p>}
        <div className="reading-home-context" aria-label="五层阅读语境"><span>词</span><span>句</span><span>段</span><span>篇</span><span>时代</span><p>先读一遍，再逐层寻找线索。</p></div>
      </div>

      <aside className="reading-home-mission" aria-label="今日任务进度">
        {missionLoading ? <><p className="eyebrow">今日任务</p><strong>正在整理进度…</strong><p role="status">读取今天的训练记录。</p></> : missionError ? <><p className="eyebrow">今日任务</p><strong>进度暂不可用</strong><p>本次训练仍可正常开始。</p></> : mission ? <>
          <p className="eyebrow">今日任务 · {mission.mission_date.slice(5).replace('-', ' 月 ')} 日</p>
          <p className="reading-home-progress"><b>{mission.completed_sessions_today}</b><span> / {mission.target_completed_sessions} 次</span></p>
          <strong>{mission.completed ? '今天的任务已完成。' : '完成一节完整训练。'}</strong>
          {mission.target_completed_sessions > 0 && <progress value={Math.min(mission.completed_sessions_today, mission.target_completed_sessions)} max={mission.target_completed_sessions} aria-label={`今日已完成 ${mission.completed_sessions_today} / ${mission.target_completed_sessions} 次训练`} />}
          <p>{mission.completed ? '可以复习错题，或继续探索下一关。' : '从证据出发，完成核心判断与迁移。'}</p>
        </> : <><p className="eyebrow">今日任务</p><strong>完成一节完整训练。</strong><p>从证据出发，完成核心判断与迁移。</p></>}
      </aside>
    </section>

    <section className="reading-home-assessment" aria-labelledby="assessment-entry-title">
      <div><p className="eyebrow">能力试测 · 体验参考</p><h2 id="assessment-entry-title">先看看你的阅读起点。</h2><p>字词、句式、语境、篇章四维试测，可保存和继续。题目待审核，结果仅供体验，不改变当前课程分级。</p></div>
      <button type="button" className="button button-secondary" onClick={onAssessment}>进入能力试测 <span aria-hidden="true">→</span></button>
    </section>

    <RecommendationQueue profileId={profile.id} onAssessment={onAssessment} onPractice={onPractice} onStartSession={onStartSession} onRiskChange={onRiskChange} externalBusy={isStarting} />

    <section className="reading-home-catalog" aria-labelledby="catalog-title">
      <header><div><p className="eyebrow">已有课程 · 保留旧练习入口</p><h2 id="catalog-title">{stageLabel}关卡</h2></div>{!loading && !catalogError && lessons.length > 0 && <span>{lessons.length} 个可选关卡</span>}</header>
      {loading ? <CatalogLoading compact /> : catalogError ? <CatalogError error={catalogError} onRetry={onRetry} compact /> : lessons.length === 0 ? <CatalogEmpty stageLabel={stageLabel} compact /> : <div className="reading-home-courses">
        {lessons.map((lesson, index) => <LessonCard key={lesson.id} lesson={lesson} index={index} current={lesson.id === todayLesson?.id} onStart={onStart} busy={isStarting} />)}
      </div>}
    </section>
  </main>
}

function CatalogLoading({ compact = false }: { compact?: boolean }) {
  return <div className={`reading-catalog-state${compact ? ' is-compact' : ''}`} aria-live="polite"><b>正在读取分级关卡…</b><p>正在为当前学习阶段整理可训练的文章。</p></div>
}
function CatalogError({ error, onRetry, compact = false }: { error: string; onRetry: () => void; compact?: boolean }) {
  return <div className={`reading-catalog-state${compact ? ' is-compact' : ''}`} role="alert"><b>暂时无法读取关卡目录。</b><p>{errorMessage(error)}</p><button type="button" className="text-button" onClick={onRetry}>重新读取 →</button></div>
}
function CatalogEmpty({ stageLabel, compact = false }: { stageLabel: string; compact?: boolean }) {
  return <div className={`reading-catalog-state${compact ? ' is-compact' : ''}`}><b>{stageLabel}分级暂未开放关卡。</b><p>关卡由教研内容发布后显示在这里，请稍后再来。</p></div>
}
function LessonCard({ lesson, index, current, onStart, busy }: { lesson: Lesson; index: number; current: boolean; onStart: (lessonId: string) => void; busy: boolean }) {
  return <article className="reading-home-course"><header><span>{String(index + 1).padStart(2, '0')}</span><small>{current ? '本次阅读' : lesson.difficulty}</small></header><h3>{lesson.title}</h3><p>{lesson.summary}</p>
    <footer><small>{lesson.source} · 约 {lesson.estimated_minutes} 分钟</small><button type="button" className="text-button" onClick={() => onStart(lesson.id)} disabled={busy}>{index === 0 ? '开始' : '选择'} →</button></footer>
  </article>
}
