import { useEffect, useRef, useState } from 'react'
import { assessmentApi, assessmentRequestId } from '../assessmentApi'
import { answerCounts, assessmentDimensions, assessmentPassageLabel, assessmentReasonLabel, dimensionLabels, safeSourceUrl } from '../assessment'
import type { AssessmentAvailability, AssessmentCommand, AssessmentMode, AssessmentSession, AssessmentSummary, SelfAnswers } from '../assessment'
import { errorMessage, RequestError, uncertainWrite } from '../http'
import '../assessment.css'

type Risk = 'working' | 'uncertain' | 'dirty' | null
type Props = { profileId: string | null; onCreateProfile: () => void; onHome: () => void; onRiskChange?: (risk: Risk) => void }
type Pending = { id: string; key: string; command: AssessmentCommand }
const survey = [
  { field: 'level', title: '你目前觉得自己处在哪个起点？', options: [['L1', '基础起步：借助注释理解'], ['L2', '进阶阅读：尝试通篇理解'], ['L3', '深入理解：关注深层含义'], ['UNSURE', '暂时不确定']] },
  { field: 'goal', title: '这次最想改善什么？', options: [['FOUNDATION', '打牢字词基础'], ['READING', '独立读懂文章'], ['EXAM', '准备学校学习与考试'], ['INTEREST', '兴趣阅读与积累']] },
  { field: 'word_strategy', title: '碰到不熟悉的词，你通常怎么做？', options: [['CONTEXT', '先联系上下文推断'], ['NOTES', '先查注释再读原文'], ['GUESS', '先凭熟悉的意思尝试'], ['UNSURE', '还没有固定方法']] },
  { field: 'reading_experience', title: '最近的文言阅读经历更接近哪一种？', options: [['NEW', '刚开始或很久没接触'], ['GUIDED', '主要跟随老师或注释'], ['INDEPENDENT', '会尝试独立阅读'], ['UNSURE', '不好判断']] },
] as const
const entryKey = (profileId: string) => `wenyan-assessment:${profileId}`
const surveyKey = (profileId: string) => `wenyan-assessment-survey:${profileId}`
function storeEntry(profileId: string, id: string) { try { localStorage.setItem(entryKey(profileId), id) } catch { /* Server still owns all confirmed answers. */ } }
function readEntry(profileId: string) { try { return localStorage.getItem(entryKey(profileId)) } catch { return null } }
function readSurvey(profileId: string | null): Partial<SelfAnswers> {
  if (!profileId) return {}
  try {
    const value = JSON.parse(localStorage.getItem(surveyKey(profileId)) ?? '{}')
    const clean: Partial<SelfAnswers> = {}
    for (const item of survey) if (item.options.some(option => option[0] === value?.[item.field])) Object.assign(clean, { [item.field]: value[item.field] })
    return clean
  } catch { return {} }
}
function time(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN') }
function assessmentError(error: unknown) {
  const code = error instanceof Error ? error.message : ''
  const messages: Record<string, string> = {
    ASSESSMENT_VERSION_CONFLICT: '另一页面已更新这份试卷，本次没有覆盖。请重新读取服务端进度。',
    VERSION_CONFLICT: '另一页面已更新这份试卷，本次没有覆盖。请重新读取服务端进度。',
    ASSESSMENT_NOT_FOUND: '未找到这份试卷，请回到试测记录重新选择。',
    ASSESSMENT_INCOMPLETE: '还有未作答且未明确跳过的题，请先完成确认。',
    ASSESSMENT_UNANSWERED: '还有未作答且未明确跳过的题，请先完成确认。',
    ASSESSMENT_BANK_INSUFFICIENT: '候选题库分层题量不足，暂不拼凑试卷。',
    ASSESSMENT_SOURCE_DIVERSITY_INSUFFICIENT: '题库来源覆盖不足，无法组成符合跨材料要求的试卷。请先继续已有训练。',
    ASSESSMENT_DISABLED: '能力评测暂未启用，请先继续已有训练。',
    ASSESSMENT_OPTION_INVALID: '选项不属于当前题目，本次未保存。请重新读取这份试卷。',
    IDEMPOTENCY_KEY_REUSED: '提交标识对应的内容不一致，已停止写入。请重新读取服务端进度。',
    FORMAL_ASSESSMENT_UNAVAILABLE: '通过审核的正式题量还不足，暂不开放正式分级。',
    ASSESSMENT_FORMAL_UNAVAILABLE: '通过审核的正式题量还不足，暂不开放正式分级。',
    ASSESSMENT_NOT_ACTIVE: '这份试卷已结束，请重新读取查看结果。',
    ASSESSMENT_ALREADY_ACTIVE: '已有进行中的试卷，请从记录继续。',
  }
  return messages[code] ?? errorMessage(error)
}

export function AssessmentPage({ profileId, onCreateProfile, onHome, onRiskChange }: Props) {
  const [availability, setAvailability] = useState<AssessmentAvailability | null>(null)
  const [sessions, setSessions] = useState<AssessmentSummary[]>([])
  const [session, setSession] = useState<AssessmentSession | null>(null)
  const [index, setIndex] = useState(0)
  const [draft, setDraft] = useState<string | null>(null)
  const [selfAnswers, setSelfAnswers] = useState<Partial<SelfAnswers>>(() => readSurvey(profileId))
  const [showSurvey, setShowSurvey] = useState(false)
  const [selectedMode, setSelectedMode] = useState<AssessmentMode>('PILOT')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [createUnknown, setCreateUnknown] = useState(false)
  const [retry, setRetry] = useState(0)
  const lock = useRef(false)
  const alive = useRef(true)
  const readController = useRef<AbortController | null>(null)
  const question = session?.questions[index]
  const dirty = !!(session?.status === 'IN_PROGRESS' && question && draft !== (session.answers[question.id] ?? null))
  const risk: Risk = busy ? 'working' : pending || createUnknown ? 'uncertain' : dirty ? 'dirty' : null
  useEffect(() => { onRiskChange?.(risk) }, [risk, onRiskChange])
  useEffect(() => () => onRiskChange?.(null), [onRiskChange])
  useEffect(() => { alive.current = true; return () => { alive.current = false; readController.current?.abort() } }, [])
  useEffect(() => {
    const controller = new AbortController()
    readController.current?.abort()
    setLoading(true); setError(''); setSession(null); setSelfAnswers(readSurvey(profileId)); setShowSurvey(false)
    async function load() {
      try {
        const [available, records] = await Promise.all([assessmentApi.availability(controller.signal), profileId ? assessmentApi.list(profileId, controller.signal) : Promise.resolve([])])
        if (controller.signal.aborted) return
        setAvailability(available); setSessions(records)
        if (profileId) {
          const saved = readEntry(profileId)
          const restore = records.find(record => record.id === saved && record.status !== 'ABANDONED') ?? records.find(record => record.status === 'IN_PROGRESS')
          if (restore) {
            const restored = await assessmentApi.get(restore.id, controller.signal)
            if (controller.signal.aborted) return
            if (restored.profile_id !== profileId) throw new RequestError('INVALID_RESPONSE', 200)
            setSession(restored); setIndex(restored.current_index); setDraft(restored.answers[restored.questions[restored.current_index].id] ?? null)
          }
        }
      } catch (reason) { if (!controller.signal.aborted) setError(assessmentError(reason)) }
      finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void load()
    return () => controller.abort()
  }, [profileId, retry])

  function install(next: AssessmentSession) {
    if (next.profile_id !== profileId) throw new RequestError('INVALID_RESPONSE', 200)
    setSession(next); setIndex(next.current_index); setDraft(next.answers[next.questions[next.current_index].id] ?? null)
    if (profileId) storeEntry(profileId, next.id)
    setNotice(next.status === 'COMPLETED' ? '交卷已确认，结果与题库版本已保存。' : '服务端已确认保存，可刷新恢复。')
  }
  async function open(id: string) {
    if (lock.current || pending || createUnknown) return
    if (dirty && !window.confirm('当前选项还未保存。放弃本题未保存的改动并重新读取吗？')) return
    lock.current = true; setBusy(true); setError('')
    const controller = new AbortController(); readController.current = controller
    try { const next = await assessmentApi.get(id, controller.signal); if (alive.current && !controller.signal.aborted) install(next) }
    catch (reason) { if (alive.current && !controller.signal.aborted) setError(assessmentError(reason)) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  async function create() {
    if (!profileId || lock.current || pending || createUnknown || survey.some(item => !selfAnswers[item.field])) return
    lock.current = true; setBusy(true); setError('')
    try {
      const answers = selfAnswers as SelfAnswers
      const next = await assessmentApi.create(profileId, selectedMode, answers.level === 'UNSURE' ? null : answers.level, answers, assessmentRequestId())
      if (alive.current) { install(next); setShowSurvey(false) }
    } catch (reason) { if (alive.current) { setError(assessmentError(reason)); if (uncertainWrite(reason)) setCreateUnknown(true) } }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  async function recoverCreation() {
    if (!profileId || lock.current) return
    lock.current = true; setBusy(true); setError('')
    const controller = new AbortController(); readController.current = controller
    try {
      const records = await assessmentApi.list(profileId, controller.signal)
      if (!alive.current || controller.signal.aborted) return
      setSessions(records)
      const active = records.find(record => record.status === 'IN_PROGRESS')
      if (active) { const next = await assessmentApi.get(active.id, controller.signal); if (alive.current && !controller.signal.aborted) { install(next); setCreateUnknown(false); setShowSurvey(false) } }
      else { setCreateUnknown(false); setNotice('重新读取后未发现进行中的试卷，可再次明确创建。') }
    } catch (reason) { if (alive.current && !controller.signal.aborted) setError(assessmentError(reason)) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  async function send(request: Pending) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      const next = await assessmentApi.command(request.id, request.command, request.key)
      if (alive.current) { install(next); setPending(null) }
    } catch (reason) {
      if (alive.current) { setError(assessmentError(reason)); if (uncertainWrite(reason)) setPending(request); else setPending(null) }
    } finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  function command(type: AssessmentCommand['type'], payload: AssessmentCommand['payload'] = {}) {
    if (!session || busy || pending) return
    void send({ id: session.id, key: assessmentRequestId(), command: { type, expected_state_version: session.state_version, payload } })
  }
  function move(target: number) {
    if (!session || busy || pending) return
    if (dirty && !window.confirm('本题选项还未保存。放弃这个改动并切换题目吗？')) return
    setIndex(target); setDraft(session.answers[session.questions[target].id] ?? null); setNotice('切换题目未改写答案；点击保存或明确跳过后，服务端会确认题位。')
  }
  function chooseSelf(field: keyof SelfAnswers, value: string) {
    const next = { ...selfAnswers, [field]: value }; setSelfAnswers(next)
    if (profileId) try { localStorage.setItem(surveyKey(profileId), JSON.stringify(next)) } catch { /* Explicit creation still stores the four responses. */ }
  }
  const disabled = busy || !!pending || createUnknown
  const counts = session ? answerCounts(session) : null
  const active = sessions.find(record => record.status === 'IN_PROGRESS')
  return <main className="assessment-page" aria-labelledby="assessment-title">
    <header className="assessment-heading"><div><p className="eyebrow">能力评测 · {session?.mode === 'FORMAL' ? '正式评测' : '待审核题库试测'}</p><h1 id="assessment-title">{session?.status === 'COMPLETED' ? '看见表现，也看见边界。' : session?.status === 'IN_PROGRESS' ? '在原文中，独立作判断。' : '从四个维度，了解你的阅读。'}</h1></div><button className="button button-secondary" onClick={onHome} disabled={busy}>返回学习首页</button></header>
    {error && <div className="assessment-message" role="alert"><p>{error}</p>{!pending && !createUnknown && !busy && <button className="button button-secondary" onClick={() => session ? void open(session.id) : setRetry(value => value + 1)}>重新读取进度</button>}</div>}
    {pending && <div className="assessment-message" role="alert"><p>上一次提交的结果尚未确认。请不要在其他页面重交；恢复时只重发同一标识和同一份内容，不会创建第二条命令。</p><button className="button button-secondary" disabled={busy} onClick={() => void send(pending)}>恢复上一次提交</button></div>}
    {createUnknown && <div className="assessment-message" role="alert"><p>创建结果尚未确认。先从服务端找回进行中的试卷，不重新创建。</p><button className="button button-secondary" disabled={busy} onClick={() => void recoverCreation()}>重新读取并找回试卷</button></div>}
    <p className="assessment-save-state" role="status" aria-live="polite">{busy ? '正在等待服务端确认，请勿重复操作…' : dirty ? '当前选项尚未保存。' : notice}</p>
    {loading ? <section className="assessment-state" aria-busy="true"><h2>正在读取题库与试测进度…</h2><p>已确认的答案保存在服务端。</p></section> : !profileId ? <section className="assessment-state"><h2>先建立学习档案。</h2><p>试测需要关联学习档案；已有训练记录不会重置。</p><button className="button button-primary" onClick={onCreateProfile}>建立学习档案</button></section> : session?.status === 'COMPLETED' ? <AssessmentResults session={session} onReturn={() => { setSession(null); setRetry(value => value + 1); try { localStorage.removeItem(entryKey(profileId)) } catch { /* no effect on server */ } }} /> : session?.status === 'ABANDONED' ? <section className="assessment-state"><h2>这份试卷已明确放弃。</h2><p>历史记录保留，不生成能力结果。</p><button className="button button-secondary" onClick={() => { setSession(null); setRetry(value => value + 1) }}>查看试测入口</button></section> : session && question && counts ? <>
      <div className="assessment-progress"><div><b>{dimensionLabels[question.dimension]}</b><span>第 {index + 1} / {session.questions.length} 题 · {question.difficulty} 要求</span></div><progress max={session.questions.length} value={counts.resolved} aria-label="已确认作答或跳过的题数" /><p>已答 {counts.answered} · 已跳过 {counts.skipped} · 未处理 {counts.remaining}</p></div>
      <div className="assessment-workspace"><section className="assessment-passage" aria-labelledby="assessment-source"><p className="eyebrow">{assessmentPassageLabel(question)}</p><h2 id="assessment-source">{question.source}</h2><blockquote>{question.passage}</blockquote><p className="assessment-note">独立作答期间不显示字词释义、答案和解析。来源出处在交卷后回看。</p></section><section className="assessment-question" aria-labelledby="assessment-question-title"><fieldset disabled={disabled}><legend id="assessment-question-title">{question.stem}</legend><div className="assessment-options">{question.options.map((option, position) => <label key={option.id} className={draft === option.id ? 'is-selected' : ''}><input type="radio" name={`assessment-${question.id}`} checked={draft === option.id} onChange={() => setDraft(option.id)} /><span className="assessment-option-index" aria-hidden="true">{String.fromCharCode(65 + position)}</span><span>{option.text}</span></label>)}</div></fieldset><div className="assessment-actions"><button className="button button-primary" disabled={disabled || !draft} onClick={() => command('SAVE_ANSWER', { question_id: question.id, option_id: draft!, current_index: Math.min(index + 1, session.questions.length - 1) })}>{index < session.questions.length - 1 ? '保存并下一题' : '保存本题'}</button><button className="button button-secondary" disabled={disabled} onClick={() => { if ((draft || session.answers[question.id]) && !window.confirm('明确跳过会将本题记为未得分，并替换此前答案。确认跳过吗？')) return; command('SKIP_QUESTION', { question_id: question.id, current_index: Math.min(index + 1, session.questions.length - 1) }) }}>明确跳过本题</button></div></section></div>
      <nav className="assessment-question-nav" aria-label="试卷题目导航"><button className="button button-secondary" disabled={disabled || index === 0} onClick={() => move(index - 1)}>上一题</button><button className="button button-secondary" disabled={disabled || index === session.questions.length - 1} onClick={() => move(index + 1)}>下一题（不保存）</button><details><summary>查看题目进度与定位</summary><div className="assessment-number-grid">{session.questions.map((item, position) => <button key={item.id} type="button" aria-current={position === index ? 'step' : undefined} disabled={disabled} onClick={() => move(position)} aria-label={`第 ${position + 1} 题，${Object.hasOwn(session.answers, item.id) ? session.answers[item.id] === null ? '已跳过' : '已答' : '未处理'}`}>{position + 1}<small>{Object.hasOwn(session.answers, item.id) ? session.answers[item.id] === null ? '跳过' : '已答' : '待答'}</small></button>)}</div></details></nav>
      <footer className="assessment-finish"><p>{counts.remaining ? `还有 ${counts.remaining} 题未确认；作答或明确跳过后才能交卷。` : '所有题目已处理。交卷后答案锁定，才会展示解析。'}</p><button className="button button-primary" disabled={disabled || dirty || counts.remaining !== 0} onClick={() => window.confirm('确认交卷？交卷后无法修改答案，试测仅生成规则参考结果，不定正式等级。') && command('COMPLETE_ASSESSMENT')}>确认交卷并查看结果</button><button className="assessment-text-action" disabled={disabled} onClick={() => window.confirm('确认放弃本次试测？已确认的作答保留为历史，但不会生成结果。') && command('ABANDON_ASSESSMENT')}>放弃本次试测</button></footer>
    </> : availability && <>
      <section className="assessment-intro"><p>字词、句式、语境、篇章，各 6 题，共 24 题。题目和选项顺序在创建后固定；每次保存由服务端确认，刷新可继续。</p><div className="assessment-boundary"><b>当前先开放能力试测，不做正式定级。</b><p>试测题目尚待实际教研审核。参考分是规则试算，不代表经过校准的能力等级；翻译、迁移本轮不评估。</p><p>正式审核题：{availability.approved_question_count} · 候选试测题：{availability.pilot_question_count}</p><p>{availability.reason}</p></div>
      {active && <div className="assessment-resume"><h2>有一份试卷可以继续。</h2><p>{time(active.updated_at)} · 已答 {active.answered_count} / {active.question_count} · 跳过 {active.skipped_count}</p><button className="button button-primary" disabled={disabled} onClick={() => void open(active.id)}>继续上次试测</button></div>}
      {!showSurvey && <div className="assessment-actions"><button className="button button-primary" disabled={disabled || !availability.pilot_available || !!active} onClick={() => { setSelectedMode('PILOT'); setShowSurvey(true) }}>先做四道轻自评，再开始试测</button><button className="button button-secondary" disabled={disabled || !availability.formal_available || !!active} onClick={() => { setSelectedMode('FORMAL'); setShowSurvey(true) }}>正式测评{!availability.formal_available ? '（尚未开放）' : ''}</button></div>}
      {!availability.pilot_available && <p className="assessment-note">题库不足，暂不拼凑试卷。可以先回学习首页继续现有训练。</p>}
      </section>
      {showSurvey && <section className="assessment-survey" aria-labelledby="assessment-survey-title"><h2 id="assessment-survey-title">先说说你的起点与目标。</h2><p>自评不计入客观得分。创建试卷时四项一同保存；此刻只是尚未提交的本机草稿。</p>{survey.map(item => <fieldset key={item.field} disabled={disabled}><legend>{item.title}</legend>{item.options.map(option => <label key={option[0]}><input type="radio" name={`self-${item.field}`} checked={selfAnswers[item.field] === option[0]} onChange={() => chooseSelf(item.field, option[0])} />{option[1]}</label>)}</fieldset>)}<button className="button button-primary" disabled={disabled || survey.some(item => !selfAnswers[item.field])} onClick={() => void create()}>创建 {selectedMode === 'PILOT' ? '24 题试测' : '正式测评'}</button></section>}
      <section className="assessment-history"><h2>试测记录</h2>{sessions.length ? <ul>{sessions.map(record => <li key={record.id}><div><b>{record.mode === 'PILOT' ? '能力试测' : '正式测评'} · {record.status === 'COMPLETED' ? '已交卷' : record.status === 'ABANDONED' ? '已放弃' : '进行中'}</b><p>{time(record.updated_at)} · 已答 {record.answered_count} · 跳过 {record.skipped_count}</p></div>{record.status !== 'ABANDONED' && <button className="button button-secondary" disabled={disabled} onClick={() => void open(record.id)}>{record.status === 'COMPLETED' ? '查看结果' : '继续作答'}</button>}</li>)}</ul> : <p>尚无试测记录。旧训练档案保持不变。</p>}</section>
    </>}
  </main>
}

function AssessmentResults({ session, onReturn }: { session: AssessmentSession; onReturn: () => void }) {
  const result = session.result!
  const [reviewIndex, setReviewIndex] = useState(0)
  const question = session.questions[reviewIndex]
  const review = result.review.find(item => item.question_id === question.id)
  const url = safeSourceUrl(question.source_url)
  const sufficiency = { HIGH: '高', MEDIUM: '中', LOW: '低', INSUFFICIENT: '不足' }[result.sufficiency]
  return <div className="assessment-results"><section className="assessment-result-intro"><div><p className="eyebrow">{session.mode === 'PILOT' ? '试测规则参考分 · 不定正式等级' : '当前测评结果'}</p><strong className="assessment-score">{result.overall_score === null ? '待评估' : result.overall_score.toFixed(1)}{result.overall_score !== null && <small>/ 100</small>}</strong></div><div><h2>{session.mode === 'PILOT' ? '正式能力等级：待审核与校准' : result.suggested_level ? `建议学习起点：${result.suggested_level}` : '建议起点：待确认'}</h2><p>{result.explanation}</p><p>评估充分度：{sufficiency}。这是完成情况和样本覆盖的规则提示，不是统计置信区间。</p><ul>{result.sufficiency_reasons.map((reason, index) => <li key={index}>{assessmentReasonLabel(reason)}</li>)}</ul></div></section>
    <section className="assessment-dimensions" aria-labelledby="assessment-dimensions-title"><h2 id="assessment-dimensions-title">四维表现与样本</h2>{assessmentDimensions.map(dimension => { const value = result.dimensions[dimension]; return <article key={dimension}><div><b>{dimensionLabels[dimension]}</b><span>{value.score === null ? '待评估' : `${value.score.toFixed(1)} 分`}</span></div>{value.score === null ? <p className="assessment-no-observation">本维没有有效作答，不显示能力分数。</p> : <meter min={0} max={100} value={value.score} aria-label={`${dimensionLabels[dimension]}${value.score}分`} />}<p>呈现 {value.presented_count} 题 · 作答 {value.answered_count} · 跳过 {value.skipped_count} · 答对 {value.correct_count}</p></article> })}<p className="assessment-note">翻译：待评估 · 迁移：待评估。本轮选择题不测量开放理由的推理质量。</p></section>
    <section className="assessment-result-notes"><div><h2>本次相对优势</h2>{result.strengths.length ? <ul>{result.strengths.map((value, index) => <li key={index}>{dimensionLabels[value as keyof typeof dimensionLabels] ?? value}</li>)}</ul> : <p>目前不足以确定优势，保留真实样本。</p>}</div><div><h2>可继续补强</h2>{result.weaknesses.length ? <ul>{result.weaknesses.map((value, index) => <li key={index}>{dimensionLabels[value as keyof typeof dimensionLabels] ?? value}</li>)}</ul> : <p>没有明确补强项，不补造弱项。</p>}</div></section>
    {session.self_answers && <details className="assessment-self-review"><summary>回看创建时的学习目标自评（不计分）</summary><ul>{survey.map(item => <li key={item.field}>{item.title}：{item.options.find(option => option[0] === session.self_answers?.[item.field])?.[1] ?? '未记录'}</li>)}</ul></details>}
    <section className="assessment-review"><h2>交卷后逐题回看</h2><label>选择题目<select value={reviewIndex} onChange={event => setReviewIndex(Number(event.target.value))}>{session.questions.map((item, index) => <option key={item.id} value={index}>第 {index + 1} 题 · {dimensionLabels[item.dimension]}</option>)}</select></label><h3>{question.stem}</h3><blockquote>{question.passage}</blockquote><p>我的选择：{question.options.find(option => option.id === session.answers[question.id])?.text ?? '明确跳过'}</p><p>参考答案：{question.options.find(option => option.id === review?.correct_option_id)?.text ?? '未提供'}</p><p>{review?.explanation}</p><p>{question.source}{url && <> · <a href={url} target="_blank" rel="noopener noreferrer">查看原文出处</a></>}</p></section>
    <p className="assessment-note">题库版本 {session.bank_version} · 评分版本 {session.scoring_version} · {time(session.updated_at)}。旧结果不会随规则变更静默重算。</p><button className="button button-secondary" onClick={onReturn}>查看试测入口与历史</button>
  </div>
}
