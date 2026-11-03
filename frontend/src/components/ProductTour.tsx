import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode, TouchEvent } from 'react'
import type { AuthSession } from '../auth'
import { errorMessage } from '../http'
import { experienceTourApi, tourNeedsAccount, tourSwipeDirection } from '../experienceTour'
import type { ProductTourState, TourStep } from '../experienceTour'
import './productTour.css'

type TourMode = 'first' | 'replay' | 'preview'
const tourPages = [
  { label: '先知道怎么开始', title: <>读一篇文章，<br />试着说清一个词。</>, description: '这里帮你练习：这个词是什么意思？原文哪里能看出来？先看完这 4 页介绍，不需要现在就答题。' },
  { label: '试着点一个字', title: <>遇到不懂的词，<br />先看看前后文。</>, description: '训练中可以点击字词，查看它所在的句子、段落和文章背景。这些前后文就是“语境”。先在这一页的小例子里试一试。' },
  { label: '题目会带着你走', title: <>先试着回答，<br />再选一处依据。</>, description: '不必一开始就答对。选择词义，再从原文或本句注释中选择依据；自己的理由可以选填，不写也能继续。卡住时可以使用提示。' },
  { label: '记住一个入口就够了', title: <>先做今日训练，<br />其他功能按需用。</>, description: '首次使用先完善学习资料，再去首页看推荐文章。已有档案就继续使用，不用重新填写。之后每次打开，先从“今日训练”开始。' },
]

const contexts = {
  '学': ['学习。这里讨论持续学习的必要性。', '“学不可以已”：学习不应停止。', '本段用青、冰等比喻说明学习能使人改变。', '《劝学》围绕学习的意义、作用与方法展开。', '荀子，战国。本文属于论说文。'],
  '已': ['停止。不是现代汉语中“已经”的意思。', '“不可以已”中的“不”否定停止，强调不可停学。', '本段以“学不可以已”开篇，再用比喻阐释。', '《劝学》强调学习积累与持之以恒。', '荀子，战国。古今词义可能不同，须结合语境。'],
} as const

function ContextExample() {
  const [word, setWord] = useState<'学' | '已'>('已')
  const [layer, setLayer] = useState(0)
  const layers = ['词', '句', '段', '篇', '时代']
  return <div className="tour-example">
    <div className="tour-example-meta"><span>《劝学》· 操作示例</span><span>不计入学习记录</span></div>
    <p className="tour-example-passage"><button type="button" aria-label="查看学的示例语境" aria-pressed={word === '学'} onClick={() => { setWord('学'); setLayer(0) }}>学</button><span>不可以</span><button type="button" aria-label="查看已的示例语境" aria-pressed={word === '已'} onClick={() => { setWord('已'); setLayer(0) }}>已</button><span>。</span></p>
    <p className="tour-example-hint">先点“学”或“已”，再点下方标签，看看解释怎样变化。</p>
    <div className="tour-context-layers" role="group" aria-label="示例语境层级">{layers.map((name, index) => <button type="button" key={name} aria-pressed={layer === index} onClick={() => setLayer(index)}>{name}</button>)}</div>
    <p className="tour-context-answer" aria-live="polite"><strong>{layers[layer]} · {word}</strong>{contexts[word][layer]}</p>
  </div>
}

function PageIllustration({ step }: { step: TourStep }) {
  if (step === 1) return <ContextExample />
  if (step === 2) return <ol className="tour-training-flow">
    {[
      ['先试着回答', '按题目要求，选择你理解的词义。'], ['选择一处依据', '选原文上下文，或选本句字词注释；注释会记录为辅助。'], ['理由可选填', '展开理由框记录自己的想法；不写也能继续，收起不会丢失。'], ['再检查一次', '对照原文核对判断；规则通过不等于理由已经审核。'], ['换一句试试', '把刚学到的方法用到新语句里，这叫“迁移挑战”。'],
    ].map(([title, detail], index) => <li key={title}><span aria-hidden="true">{index + 1}</span><div><strong>{title}</strong><p>{detail}</p></div></li>)}
  </ol>
  if (step === 3) return <div className="tour-next-paths">
    <div className="tour-primary-path"><span className="tour-section-label">先从这里开始</span><h2>今日训练</h2><p>在首页点击“开始今日关卡”，跟着题目完成一轮练习。</p></div>
    <p className="tour-section-label tour-secondary-label">练过之后，再按需要选择</p>
    <dl>{[['复习', '想把练过的内容再做一次。'], ['专项练习', '想集中练习某一类问题。'], ['能力试测', '想看看当前答题表现和未测到的部分。'], ['学习报告', '想回看训练记录和学习变化。']].map(([name, detail]) => <div key={name}><dt>{name}</dt><dd>{detail}</dd></div>)}</dl>
    <p className="tour-boundary-note">能力试测提供参考结果，不等于正式能力认证。</p>
  </div>
  return <div className="tour-start-path" aria-label="开始使用的三个步骤">
    <h2>看完介绍，接下来这样做</h2>
    <ol>{[['完善学习资料', '首次填写昵称，选择初中或高中；已有档案无需重填。'], ['查看推荐文章', '首页会展示所选学段的训练文章，先选一篇开始。'], ['开始今日关卡', '先读原文，再选择词义和依据；自己的理由选填。']].map(([title, detail], index) => <li key={title}><span aria-hidden="true">{index + 1}</span><div><strong>{title}</strong><p>{detail}</p></div></li>)}</ol>
    <p className="tour-start-note">不用先掌握所有术语，跟着一轮训练慢慢熟悉。</p>
  </div>
}

export type ProductTourProps = {
  initialStep?: TourStep
  mode?: TourMode
  onAdvance?: (step: TourStep) => Promise<TourStep | void>
  onComplete: () => void | Promise<void>
  onClose?: () => void
  onLogout?: () => void | Promise<void>
  busy?: boolean
  error?: string | null
  needsRecheck?: boolean
  onRecheck?: () => void
}

export function ProductTour({ initialStep = 0, mode = 'first', onAdvance, onComplete, onClose, onLogout, busy = false, error, needsRecheck = false, onRecheck }: ProductTourProps) {
  const [step, setStep] = useState<TourStep>(initialStep)
  const [inFlight, setInFlight] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const locked = useRef(false)
  const touch = useRef<{ x: number; y: number; time: number } | null>(null)
  useEffect(() => { setStep(initialStep) }, [initialStep])
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
    // This page uses document scrolling on short mobile viewports, not an
    // inner overflow scroller. Reset both so a long page cannot strand the
    // next page at its footer. Instant movement also respects reduced motion.
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    content.current?.scrollTo({ top: 0, behavior: 'instant' })
  }, [step])
  const move = async (delta: -1 | 1) => {
    if (locked.current || busy || needsRecheck) return
    if (delta === -1) { setStep(current => Math.max(0, current - 1) as TourStep); return }
    locked.current = true; setInFlight(true)
    try {
      if (step === 3) await onComplete()
      else { const next = (step + 1) as TourStep; const accepted = await onAdvance?.(next); setStep(accepted ?? next) }
    } catch { /* The boundary preserves the server result and renders an explicit recovery action. */ }
    finally { locked.current = false; setInFlight(false) }
  }
  const startTouch = (event: TouchEvent) => {
    if (event.touches.length !== 1 || (event.target as HTMLElement).closest('button, a, input, textarea, select, [role="group"]')) { touch.current = null; return }
    touch.current = { x: event.touches[0].clientX, y: event.touches[0].clientY, time: Date.now() }
  }
  const endTouch = (event: TouchEvent) => {
    const origin = touch.current; touch.current = null
    if (!origin || !event.changedTouches.length) return
    const direction = tourSwipeDirection(event.changedTouches[0].clientX - origin.x, event.changedTouches[0].clientY - origin.y, Date.now() - origin.time)
    // The final page always requires an explicit click on “开始使用”.
    if (direction && !(direction === 1 && step === 3)) void move(direction)
  }
  const pending = busy || inFlight
  return <main className="product-tour" aria-label={mode === 'first' ? '首次使用产品导览' : '产品功能介绍'} aria-busy={pending} onKeyDown={event => { if (event.key === 'Escape' && mode !== 'first' && onClose) { event.preventDefault(); onClose() } }}>
    <header className="tour-header"><span className="tour-brand">文言<span>·</span>推理</span><div>{mode !== 'first' && onClose ? <button type="button" className="tour-quiet" onClick={onClose}>返回产品</button> : onLogout ? <button type="button" className="tour-quiet" disabled={pending} onClick={() => { void onLogout() }}>退出登录</button> : null}</div></header>
    <div className="tour-content" ref={content} onTouchStart={startTouch} onTouchEnd={endTouch} onTouchCancel={() => { touch.current = null }}>
      <div className="tour-page" key={step}>
        <section className="tour-copy"><p className="tour-eyebrow">产品导览 · {tourPages[step].label}</p><h1 ref={heading} tabIndex={-1}>{tourPages[step].title}</h1><p className="tour-description">{tourPages[step].description}</p>{mode === 'preview' && <p className="tour-mode-note">本地演示，不保存账号导览进度。</p>}</section>
        <div className="tour-visual"><PageIllustration step={step} /></div>
      </div>
    </div>
    <footer className="tour-footer">
      {error && <div className="tour-save-error" role="alert"><p>{error}</p>{needsRecheck && onRecheck && <button className="tour-quiet" type="button" disabled={pending} onClick={onRecheck}>重新读取进度</button>}</div>}
      <div className="tour-footer-row"><button type="button" className="tour-back" disabled={step === 0 || pending || needsRecheck} onClick={() => { void move(-1) }}>上一步</button><div className="tour-progress" aria-label={`第 ${step + 1} 页，共 4 页`}><span>{step + 1} / 4</span><div aria-hidden="true">{tourPages.map((_, index) => <i key={index} className={index === step ? 'current' : index < step ? 'read' : ''} />)}</div></div><button type="button" className="tour-next" disabled={pending || needsRecheck} onClick={() => { void move(1) }}>{pending ? mode === 'first' ? '正在保存…' : '正在切换…' : step === 3 ? mode === 'first' ? '开始使用' : '返回产品' : '下一步'}<span aria-hidden="true">→</span></button></div>
    </footer>
  </main>
}

type TourContextValue = { replayTour: () => void }
const TourContext = createContext<TourContextValue>({ replayTour: () => {} })
export const useProductTour = () => useContext(TourContext)

export type ProductTourBoundaryProps = { session: AuthSession; children: ReactNode; onLogout?: () => void | Promise<void> }
export function ProductTourBoundary(props: ProductTourBoundaryProps) {
  return <AccountProductTourBoundary key={`${props.session.mode}:${props.session.user?.id ?? 'local'}`} {...props} />
}

function AccountProductTourBoundary({ session, children, onLogout }: ProductTourBoundaryProps) {
  const account = tourNeedsAccount(session)
  const [state, setState] = useState<ProductTourState | null>(null)
  const [loading, setLoading] = useState(account)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsRecheck, setNeedsRecheck] = useState(false)
  const [replay, setReplay] = useState(false)
  const alive = useRef(true)
  const pendingRead = useRef<AbortController | null>(null)
  const operation = useRef(false)
  const previousFocus = useRef<HTMLElement | null>(null)
  const previousScroll = useRef({ x: 0, y: 0 })
  const read = useCallback(async () => {
    if (!account) return
    pendingRead.current?.abort()
    const controller = new AbortController(); pendingRead.current = controller
    setLoading(true); setError(null)
    try {
      const loaded = await experienceTourApi.get(controller.signal)
      if (!alive.current || controller.signal.aborted) return
      setState(loaded); setNeedsRecheck(false)
    } catch (failure) {
      if (!alive.current || controller.signal.aborted) return
      setError(`暂时无法读取产品导览进度。${errorMessage(failure)}`)
    } finally { if (alive.current && !controller.signal.aborted) setLoading(false) }
  }, [account])
  useEffect(() => { alive.current = true; void read(); return () => { alive.current = false; pendingRead.current?.abort() } }, [read])
  const closeReplay = () => {
    setReplay(false)
    requestAnimationFrame(() => {
      window.scrollTo({ top: previousScroll.current.y, left: previousScroll.current.x, behavior: 'instant' })
      if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true })
    })
  }
  const replayTour = () => {
    previousFocus.current = document.activeElement as HTMLElement | null
    previousScroll.current = { x: window.scrollX, y: window.scrollY }
    setReplay(true)
  }
  const logout = onLogout ? async () => {
    if (operation.current) return
    operation.current = true; setSaving(true)
    try { await onLogout() }
    catch (failure) { if (alive.current) setError(`退出登录尚未完成。${errorMessage(failure)} 请稍后再试。`) }
    finally { operation.current = false; if (alive.current) setSaving(false) }
  } : undefined
  const save = async (step: TourStep, complete: boolean): Promise<TourStep> => {
    if (!state || operation.current || needsRecheck) throw new Error('TOUR_NOT_READY')
    if (!complete && step <= state.step) return step
    operation.current = true; setSaving(true); setError(null)
    try {
      const result = await experienceTourApi.save(step, complete)
      if (!alive.current) throw new Error('SESSION_CHANGED')
      if (result.step < step || (complete && !result.completed)) throw new Error('INVALID_RESPONSE')
      setState(result)
      return step
    } catch (failure) {
      if (alive.current) {
        setNeedsRecheck(true)
        setError(`导览进度尚未确认，暂不继续。${errorMessage(failure)} 请先重新读取进度，我们不会自动重复提交。`)
      }
      throw failure
    } finally { if (alive.current) setSaving(false); operation.current = false }
  }
  let surface: ReactNode
  if (account && (!state || loading)) {
    surface = <main className="tour-loading" aria-busy={loading || saving}><p className="tour-brand">文言<span>·</span>推理</p><h1>{loading ? '正在读取产品导览' : '暂时无法打开产品导览'}</h1><p role={error ? 'alert' : 'status'}>{error ?? '即将开始，不会改动你的学习记录。'}</p>{!loading && <button type="button" className="tour-next" disabled={saving} onClick={() => { void read() }}>重新读取</button>}{logout && <button type="button" className="tour-quiet" disabled={saving} onClick={() => { void logout() }}>退出登录</button>}</main>
  } else if (account && state && !state.completed) {
    surface = <ProductTour initialStep={state.step} onAdvance={step => save(step, false)} onComplete={async () => { await save(3, true) }} onLogout={logout} busy={saving} error={error} needsRecheck={needsRecheck} onRecheck={() => { void read() }} />
  } else {
    surface = <><div hidden={replay}>{children}</div>{replay && <ProductTour mode={account ? 'replay' : 'preview'} onClose={closeReplay} onComplete={closeReplay} />}</>
  }
  return <TourContext.Provider value={{ replayTour }}>{surface}</TourContext.Provider>
}
