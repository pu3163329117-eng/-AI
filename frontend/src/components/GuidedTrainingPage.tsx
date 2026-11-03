import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ContextReader } from './ContextReader'
import { ReasoningEditor, ReasoningHistory } from './ReasoningEditor'
import { ReasonFeedback } from './ReasonFeedback'
import { SessionObservations } from './SessionObservations'
import { TrainingReaderDialog } from './TrainingReaderDialog'
import { jumpTo } from '../navigation'
import { restoredAnswer } from '../reasoning'
import { trainingDraftIsDirty } from '../trainingDraft'
import { guidedFirstJudgment, initialUnifiedTrainingStep } from '../guidedTraining'
import { runGuidedSubmission, type GuidedSubmissionStep, type VerifiedGuidedFeedback } from '../guidedSubmission'
import { basisMatchesGraph, type AnnotationBasisSelection, type ContextBasisSelection } from '../evidenceBasis'
import type { TrainingCommandOutcome } from '../trainingCommandOutcome'
import type { CommandType, TrainingSession } from '../types'
import './guidedTraining.css'

export type GuidedTrainingProps = {
  sessionId: string; session: TrainingSession; busy: boolean; pendingCommand: CommandType | null
  error: string | null; recoveryNeeded: boolean; onRecover: () => void
  onCommand: (type: CommandType, payload?: Record<string, unknown>, expectedVersion?: number) => Promise<TrainingCommandOutcome>
  onReturnHome: () => void; onDirtyChange: (dirty: boolean) => void
  renderSummary: (summary: NonNullable<TrainingSession['summary']>) => ReactNode
}

export function GuidedTrainingPage(props: GuidedTrainingProps) { return <GuidedTrainingBody key={props.sessionId} {...props} /> }

function GuidedTrainingBody({ sessionId, session, busy, pendingCommand, error, recoveryNeeded, onRecover, onCommand, onReturnHome, onDirtyChange, renderSummary }: GuidedTrainingProps) {
  const [answer, setAnswer] = useState<string | null>(restoredAnswer(session))
  const [step, setStep] = useState<'CHOOSE' | 'BASIS'>(() => initialUnifiedTrainingStep(session))
  const [readerOpen, setReaderOpen] = useState(false)
  const [reasoningDirty, setReasoningDirty] = useState(false)
  const [annotationSelection, setAnnotationSelection] = useState<AnnotationBasisSelection | null>(null)
  const [contextBasisSelection, setContextBasisSelection] = useState<ContextBasisSelection | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submissionStep, setSubmissionStep] = useState<GuidedSubmissionStep | null>(null)
  const [submissionMessage, setSubmissionMessage] = useState('')
  const [verifiedFeedback, setVerifiedFeedback] = useState<(VerifiedGuidedFeedback & { sessionId: string }) | null>(null)
  // Only a definite newer receipt/read can release a locally unconfirmed command.
  const [unknownVersion, setUnknownVersion] = useState<number | null>(null)
  const inFlight = useRef(false)
  const locked = busy || recoveryNeeded || submitting || unknownVersion !== null && session.state_version <= unknownVersion
  const lastStage = useRef({ stage: session.stage, completed: session.completed })
  const live = useRef({ sessionId, stage: session.stage, version: session.state_version, locked, mounted: true })
  live.current.sessionId = sessionId; live.current.stage = session.stage; live.current.version = session.state_version; live.current.locked = locked
  const reportReasoningDirty = useCallback((dirty: boolean) => setReasoningDirty(dirty), [])
  const firstJudgment = guidedFirstJudgment(session)
  const ready = session.transfer_ready || session.summary_ready
  const stageTrace = session.learning_trace?.stages[session.stage]
  const persistedAnswer = restoredAnswer(session)
  const currentIntent = () => live.current.mounted && !inFlight.current && !live.current.locked
    && live.current.sessionId === sessionId && live.current.stage === session.stage && live.current.version === session.state_version
  useEffect(() => { live.current.mounted = true; return () => { live.current.mounted = false } }, [])
  useEffect(() => setAnswer(restoredAnswer(session)), [session.selected_answer, session.stage, session.reasoning_graph?.conclusion])
  useEffect(() => { onDirtyChange(trainingDraftIsDirty(answer, persistedAnswer, reasoningDirty, session.completed)) }, [answer, persistedAnswer, reasoningDirty, session.completed, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  useEffect(() => {
    if (lastStage.current.stage === session.stage && lastStage.current.completed === session.completed) return
    lastStage.current = { stage: session.stage, completed: session.completed }
    setAnnotationSelection(null); setContextBasisSelection(null); setReaderOpen(false); setReasoningDirty(false)
    setSubmissionMessage(''); setSubmissionStep(null); setUnknownVersion(null); setStep(initialUnifiedTrainingStep(session))
    const frame = requestAnimationFrame(() => jumpTo(session.completed ? 'summary-title' : 'guided-task-title'))
    return () => cancelAnimationFrame(frame)
  }, [session.stage, session.completed])
  useEffect(() => {
    if (!recoveryNeeded) return
    const frame = requestAnimationFrame(() => jumpTo('command-recovery-title'))
    return () => cancelAnimationFrame(frame)
  }, [recoveryNeeded])
  useEffect(() => {
    if (!submissionMessage || recoveryNeeded || unknownVersion !== null) return
    const frame = requestAnimationFrame(() => jumpTo('training-feedback'))
    return () => cancelAnimationFrame(frame)
  }, [submissionMessage, recoveryNeeded, unknownVersion])
  const go = (next: 'CHOOSE' | 'BASIS') => {
    if (!currentIntent() || session.completed || next === 'CHOOSE' && ready || next === 'BASIS' && !ready && (firstJudgment || !answer)) return
    setStep(next); setReaderOpen(false)
    requestAnimationFrame(() => jumpTo(next === 'BASIS' ? 'reasoning-title' : 'guided-task-title'))
  }
  const openReader = () => { if (currentIntent() && !session.completed) setReaderOpen(true) }
  const closeReader = () => { if (currentIntent()) setReaderOpen(false) }
  const selectContext = (selection: ContextBasisSelection) => {
    if (!currentIntent() || ready || session.completed || selection.sessionId !== sessionId || selection.stage !== session.stage || firstJudgment) return
    if (!basisMatchesGraph({ kind: 'CONTEXT', evidence: selection.selection }, session.reasoning_graph)) setReasoningDirty(true)
    setAnnotationSelection(null); setContextBasisSelection(selection); setReaderOpen(false); setStep('BASIS')
    requestAnimationFrame(() => jumpTo('reasoning-title'))
  }
  const selectAnnotation = (selection: AnnotationBasisSelection) => {
    if (!currentIntent() || ready || session.completed || selection.sessionId !== sessionId || selection.stage !== session.stage || firstJudgment) return
    if (!basisMatchesGraph({ kind: 'ANNOTATION', annotation: selection }, session.reasoning_graph)) setReasoningDirty(true)
    setContextBasisSelection(null); setAnnotationSelection(selection); setReaderOpen(false); setStep('BASIS')
    requestAnimationFrame(() => jumpTo('reasoning-title'))
  }
  const auxiliary = (type: CommandType, payload?: Record<string, unknown>) => {
    if (!currentIntent()) return
    return onCommand(type, payload, session.state_version)
  }
  const confirmFirst = async () => {
    if (!currentIntent() || !answer || !firstJudgment || session.completed || ready) return
    inFlight.current = true; setSubmitting(true); setSubmissionMessage(''); setSubmissionStep('SUBMIT_ATTEMPT')
    const origin = { sessionId, stage: session.stage, version: session.state_version }
    try {
      const outcome = await onCommand('SUBMIT_ATTEMPT', { answer }, origin.version)
      if (!live.current.mounted || live.current.sessionId !== origin.sessionId || live.current.stage !== origin.stage) return
      if (outcome.status === 'confirmed' && outcome.session.stage === origin.stage && outcome.session.state_version > origin.version
        && live.current.version <= outcome.session.state_version && !guidedFirstJudgment(outcome.session)) {
        setStep('BASIS'); setReaderOpen(false)
        requestAnimationFrame(() => jumpTo('reasoning-title'))
      } else if (outcome.status === 'unknown') { setUnknownVersion(origin.version); setSubmissionMessage('首次判断的结果尚未确认，请先核对，不会自动再次提交。') }
    } catch {
      if (live.current.mounted && live.current.sessionId === origin.sessionId && live.current.stage === origin.stage) { setUnknownVersion(origin.version); setSubmissionMessage('首次判断的结果尚未确认。请刷新读取进度，勿重复提交。') }
    } finally {
      inFlight.current = false
      if (live.current.mounted) { setSubmitting(false); setSubmissionStep(null) }
    }
  }
  const submitAndContinue = async (payload: Record<string, unknown>) => {
    if (!currentIntent() || !ready && (!answer || firstJudgment) || session.completed || ready && reasoningDirty) return
    inFlight.current = true; setSubmitting(true); setSubmissionMessage('')
    const origin = { sessionId, stage: session.stage, version: session.state_version }
    const scopeCurrent = (snapshot: TrainingSession) => live.current.mounted && live.current.sessionId === origin.sessionId
      && live.current.stage === origin.stage && live.current.version >= origin.version && live.current.version <= snapshot.state_version
    try {
      const result = await runGuidedSubmission({ session, answer: answer ?? '', payload, execute: onCommand, isCurrent: scopeCurrent, onProgress: setSubmissionStep,
        onVerified: feedback => {
          if (!live.current.mounted || live.current.sessionId !== origin.sessionId || live.current.stage !== origin.stage
            || live.current.version < origin.version || live.current.version > feedback.stateVersion) return
          setVerifiedFeedback(previous => previous?.sessionId === origin.sessionId && previous.stateVersion > feedback.stateVersion
            ? previous : { ...feedback, sessionId: origin.sessionId })
        },
      })
      if (!live.current.mounted || live.current.sessionId !== origin.sessionId || live.current.stage !== origin.stage) return
      if (result.status === 'unknown') setUnknownVersion(result.session.state_version)
      if (result.status === 'needs_revision') setSubmissionMessage('本题暂未通过，请查看反馈，调整词义或依据后再提交。')
      else if (result.status !== 'confirmed' && result.status !== 'stale') setSubmissionMessage(
        result.stoppedAt === 'CONTINUE_TO_TRANSFER' || result.stoppedAt === 'COMPLETE_SESSION'
          ? '本题已核验，下一步尚未确认。已保存记录保留，不会重新保存或重复核验。'
          : result.stoppedAt === 'SUBMIT_ATTEMPT' ? '依据已保存，判断核验尚未完成。草稿和已保存记录都会保留。'
          : '本次操作未完成，仍在当前题；请查看提示后处理。')
    } finally {
      inFlight.current = false
      if (live.current.mounted) { setSubmitting(false); setSubmissionStep(null) }
    }
  }
  const pendingLabels: Partial<Record<CommandType, string>> = {
    SUBMIT_ATTEMPT: firstJudgment ? '正在确认首次词义…' : '正在核验本题…', SAVE_REASONING: '正在保存依据与可选理由…',
    CONTINUE_TO_TRANSFER: '正在进入陌生文迁移…', COMPLETE_SESSION: '正在保存本关总结…',
    REQUEST_MORE_CONTEXT: '正在记录点读语境…', RECORD_ASSISTANCE: '正在记录解释辅助…',
  }
  const pendingLabel = pendingLabels[submissionStep ?? pendingCommand ?? 'SUBMIT_ATTEMPT'] ?? '正在处理当前操作…'
  const variableIndex = session.passage.indexOf(session.variable)
  const beforeVariable = variableIndex < 0 ? session.passage : session.passage.slice(0, variableIndex)
  const afterVariable = variableIndex < 0 ? '' : session.passage.slice(variableIndex + session.variable.length)
  const canReturnBasis = ready || !firstJudgment && !!answer

  return <main className="training-page inkroom-training guided-training">
    <div className="training-shell"><section className="lesson guided-task-card" aria-labelledby={session.completed ? 'summary-title' : 'guided-task-title'}>
      <div className="lesson-meta"><span>{session.source}</span><span>{session.stage === 'CORE' ? '原文推理 · 1 / 2' : '陌生文迁移 · 2 / 2'}</span></div>
      {session.completed && session.summary ? renderSummary(session.summary) : <>
        <header className="guided-task-heading"><h1 id="guided-task-title" tabIndex={-1}>{step === 'CHOOSE' ? '读原句，选词义。' : ready ? '本题已核验。' : '选依据，再继续。'}</h1>
          <button type="button" className="text-button guided-reader-trigger" disabled={locked} onClick={openReader}>读全文与五层语境</button></header>
        <section className="guided-screen training-task" id="training-question" tabIndex={-1} hidden={step !== 'CHOOSE'} data-step="CHOOSE">
          <p className="passage">{beforeVariable}{variableIndex >= 0 && <span>{session.variable}</span>}{afterVariable}</p>
          <h2 id="question-title">{session.question}</h2><div className="choice-list" role="radiogroup" aria-label="选择词义">{session.choices.map(choice => <label key={choice} className={`choice-option${answer === choice ? ' selected' : ''}`}><input type="radio" name={`answer-${sessionId}-${session.stage}`} value={choice} checked={answer === choice} disabled={locked || ready} onChange={() => { if (currentIntent() && !ready) setAnswer(choice) }} /><span>{choice}</span></label>)}</div>
          <p className="knowledge-note">{firstJudgment ? '先确认你的首次判断，再找依据。查解释会如实记录辅助；换选项不会自动提交。' : stageTrace ? '首次判断已记录，调整当前选择不会改写首次记录。' : '旧训练首答未知，保持原记录，不补造历史。'}</p>
          <div className="guided-task-primary"><button type="button" className="button button-primary submit" disabled={locked || !answer || ready} onClick={firstJudgment ? confirmFirst : () => go('BASIS')}>{submitting ? pendingLabel : firstJudgment ? '确认词义，找依据' : '保留选择，回到依据'}</button></div>
        </section>
        <section className="guided-screen" hidden={step !== 'BASIS'} data-step="BASIS">
          <p>当前词义：<strong>{answer ?? '尚未选择'}</strong>{!ready && <button type="button" className="text-button" disabled={locked} onClick={() => go('CHOOSE')}>修改选择</button>}</p>
          <ReasoningEditor key={`${sessionId}:${session.stage}`} sessionId={sessionId} session={session} answer={answer} busy={locked || firstJudgment} onCommand={auxiliary} onDirtyChange={reportReasoningDirty} annotationSelection={annotationSelection} contextBasisSelection={contextBasisSelection} onRequestContext={openReader} onSubmitDraft={submitAndContinue} submissionLabel={submitting ? pendingLabel : '提交本题并继续'} submissionHint={submitting ? pendingLabel : undefined} />
          {ready && <div className="guided-task-primary"><button type="button" className="button button-primary" disabled={locked || reasoningDirty} onClick={() => submitAndContinue({ conclusion: answer })}>{submitting ? pendingLabel : session.transfer_ready ? '本题已核验，继续下一题' : '本题已核验，查看总结'}</button></div>}
        </section>
        <div id="training-feedback" tabIndex={-1} className={`feedback ${ready ? 'success' : ''}`} aria-live="polite"><h2 className="training-feedback-label">{locked ? '操作状态' : error ? '操作未完成' : '判断反馈'}</h2><p>{submitting || busy ? pendingLabel : error ? `${recoveryNeeded ? '操作结果未确认' : '操作未完成'}：${error}` : session.feedback}</p>{submissionMessage && <p role="status">{submissionMessage}</p>}</div>
        {recoveryNeeded && <div className="command-recovery" role="alert"><h3 id="command-recovery-title" tabIndex={-1}>刚才操作的结果尚未确认。</h3><p>先核对原请求，避免重复记录。已成功的步骤不会从头重做；刷新只读取进度，不自动提交。</p><button type="button" className="button button-secondary" disabled={busy || submitting} onClick={onRecover}>{busy ? '正在核对…' : '核对并重试刚才操作'}</button></div>}
        {unknownVersion !== null && !recoveryNeeded && session.state_version <= unknownVersion && <p role="alert">结果尚未确认，请刷新读取服务器进度。本页不会自动重发或继续下一题。</p>}
        <TrainingReaderDialog open={readerOpen} onClose={closeReader} identity={`${sessionId}:${session.stage}`} busy={locked}>
          <ContextReader key={`${sessionId}:${session.stage}`} sessionId={sessionId} session={session} busy={locked} onCommand={auxiliary} meaningMode={session.learning_trace ? 'TRACKED' : 'LEGACY'} isMeaningAllowed={stageTrace?.assistance_kinds.includes('WORD_MEANING') ?? false}
            onRevealMeaning={selection => { auxiliary('RECORD_ASSISTANCE', { kind: 'WORD_MEANING', paragraph_index: selection.paragraph_index, start: selection.start, end: selection.end }) }} onUseAnnotation={firstJudgment ? undefined : selectAnnotation} annotationDisabled={locked || ready} onUseContext={firstJudgment ? undefined : selectContext}
            onReturnToReasoning={() => go('BASIS')} reasoningReturnDisabled={locked || !canReturnBasis} reasoningReturnHint={firstJudgment ? '先确认首次词义判断，再选择依据。' : !answer ? '请先选择一个词义。' : undefined}
            onReturnToQuestion={() => go(ready ? 'BASIS' : 'CHOOSE')} questionReturnLabel={ready ? '回到本题结果' : '回到题目'} questionReturnDisabled={locked} />
        </TrainingReaderDialog>
        <details className="guided-secondary reasoning-tools" id="training-tools"><summary>更多帮助 · 提示与暂放</summary><div className="reasoning-tools-content">
          <button type="button" className="knowledge-action" disabled={locked} onClick={openReader}>在原文中找依据</button>
          <button type="button" className="quiet-action" disabled={locked || session.deferred} onClick={() => { if (!session.deferred) auxiliary('DEFER_VARIABLE') }}>{session.deferred ? '已暂放，先扩大语境' : '先暂放这个字'}</button>
          {session.deferred && <button type="button" className="quiet-action revisit-action" disabled={locked} onClick={() => auxiliary('REVISIT_VARIABLE')}>回看这个字，继续判断</button>}
          <button type="button" className="quiet-action" disabled={locked} onClick={() => auxiliary('REQUEST_HINT')}>需要一点提示</button>{session.hint && <p className="hint">第 {session.hint_level} 条提示：{session.hint}</p>}
          <details className="guided-ai"><summary>理由反馈（可选试用）</summary><ReasonFeedback key={`${sessionId}-${session.stage}-${session.state_version}`} sessionId={sessionId} session={session} disabled={locked} dirty={reasoningDirty} onRequestContext={openReader} /></details>
        </div></details>
        <button type="button" className="text-button guided-return" disabled={locked} onClick={() => { if (currentIntent()) onReturnHome() }}>返回今日训练</button>
      </>}
      {verifiedFeedback?.sessionId === sessionId && <details className="guided-secondary guided-previous-feedback"><summary>{session.completed ? '最后一题反馈' : verifiedFeedback.stage === session.stage ? '本题已核验反馈' : '上一题反馈'}</summary><p className="eyebrow">{verifiedFeedback.source} · {verifiedFeedback.stage === 'CORE' ? '原文推理' : '陌生文迁移'}</p><p>{verifiedFeedback.feedback}</p></details>}
      <details className="training-records guided-secondary"><summary>查看本次训练的学习行为记录</summary><SessionObservations trace={session.learning_trace} currentStage={session.stage} completed={session.completed} /></details>
      <ReasoningHistory sessionId={sessionId} version={session.state_version} />
    </section></div>
  </main>
}
