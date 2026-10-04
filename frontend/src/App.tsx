import { useCallback, useEffect, useState } from 'react'
import { trainingApi } from './api'
import type { CommandType, TrainingSession } from './types'

type Page = 'home' | 'training' | 'skills'

const taskLabels = ['识别已知', '推断变量', '回溯验证', '迁移挑战']

function AppHeader({ page, onNavigate }: { page: Page; onNavigate: (page: Page) => void }) {
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
        <button disabled title="复习模块将在下一版开放">复习</button>
        <button disabled title="个人中心将在下一版开放">我的</button>
      </nav>
      <button className="account" aria-label="当前账户">林</button>
    </header>
  )
}

function HomePage({ onStart, isStarting, error }: { onStart: () => void; isStarting: boolean; error: string | null }) {
  return (
    <main className="home-page">
      <section className="hero" aria-labelledby="home-title">
        <div>
          <p className="eyebrow">10 月 4 日 · 约 8 分钟</p>
          <h1 id="home-title">读懂，<br />不是记住。</h1>
          <p className="intro">从一个字开始，读见整篇文章。今天练习“暂放与回溯”。</p>
          <button className="button button-primary" onClick={onStart} disabled={isStarting}>
            {isStarting ? '正在准备训练…' : '开始今日训练'} <span aria-hidden="true">→</span>
          </button>
          {error && <p className="request-error" role="alert">无法开始训练：{error}</p>}
        </div>
        <aside className="streak" aria-label="连续学习进度">
          <div className="progress-ring"><b>3/4</b></div>
          <strong>连续学习 7 天</strong>
          <small>完成今天的训练，解锁<br />“以证据作答”徽章。</small>
        </aside>
      </section>
      <section className="task-cards" aria-label="训练任务">
        <TaskCard number="01" title="今日主任务" description="人物关系反推实词义" />
        <TaskCard number="02" title="待回溯变量" description="“从” · 新证据已出现" />
        <TaskCard number="03" title="陌生文挑战" description="检验你是否真的会用" />
      </section>
    </main>
  )
}

function TaskCard({ number, title, description }: { number: string; title: string; description: string }) {
  return <article className="task-card"><em>{number}</em><b>{title}</b><p>{description}</p></article>
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

function SkillsPage({ onStart }: { onStart: () => void }) {
  const skills = [
    ['语境定位', '能够标记一个词的上下文边界', 78],
    ['关系推断', '从人物与行为中找依据', 56],
    ['暂放回溯', '等到新证据出现后再判断', 32],
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
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [session, setSession] = useState<TrainingSession | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = useCallback(async () => {
    setBusy(true); setError(null)
    try {
      const response = await trainingApi.createSession()
      setSessionId(response.session_id); setSession(response.session); setPage('training')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setBusy(false) }
  }, [])

  const command = useCallback(async (type: CommandType, payload: Record<string, string> = {}) => {
    if (!sessionId || !session) return
    setBusy(true); setError(null)
    try {
      const response = await trainingApi.command(sessionId, session.state_version, type, payload)
      setSession(response.session)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'REQUEST_FAILED')
    } finally { setBusy(false) }
  }, [session, sessionId])

  const navigate = (next: Page) => {
    if (next === 'home') setPage('home')
    else if (next === 'skills') setPage('skills')
  }

  return <div className="app-shell">
    <AppHeader page={page} onNavigate={navigate} />
    {page === 'home' && <HomePage onStart={start} isStarting={busy} error={error} />}
    {page === 'skills' && <SkillsPage onStart={start} />}
    {page === 'training' && session && <TrainingPage session={session} busy={busy} error={error} onCommand={command} onReturnHome={() => setPage('home')} />}
  </div>
}
