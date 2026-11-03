import type { TrainingSession } from './types'

export type GuidedTrainingStep = 'READ' | 'CHOOSE' | 'BASIS' | 'CHECK'
export const guidedTrainingSteps: Array<{ id: GuidedTrainingStep; label: string }> = [
  { id: 'READ', label: '读原文' }, { id: 'CHOOSE', label: '选词义' }, { id: 'BASIS', label: '找依据' }, { id: 'CHECK', label: '核对判断' },
]

export function guidedFirstJudgment(session: TrainingSession): boolean {
  const trace = session.learning_trace?.stages[session.stage]
  return !!trace && trace.first_attempt === null
}

/** Resume confirmed server state only; local screen navigation never creates a learning event. */
export function initialGuidedStep(session: TrainingSession): GuidedTrainingStep {
  if (session.completed || session.transfer_ready || session.summary_ready) return 'CHECK'
  if (session.reasoning_graph) return guidedFirstJudgment(session) ? 'CHOOSE' : 'CHECK'
  const trace = session.learning_trace?.stages[session.stage]
  return trace && trace.first_attempt !== null ? 'BASIS' : 'READ'
}

export function canOpenGuidedStep(step: GuidedTrainingStep, session: TrainingSession, answer: string | null, dirty: boolean): boolean {
  const ready = session.transfer_ready || session.summary_ready || session.completed
  if (step === 'READ') return true
  if (step === 'CHOOSE') return !ready
  if (step === 'BASIS') return !guidedFirstJudgment(session) && !!answer
  return !dirty && (ready || !guidedFirstJudgment(session) && !!session.reasoning_graph && session.reasoning_graph.conclusion === answer)
}

export function canSubmitGuidedJudgment(session: TrainingSession, answer: string | null, dirty: boolean, locked: boolean): boolean {
  return !!answer && !locked && !dirty && !session.completed && !session.transfer_ready && !session.summary_ready
    && (guidedFirstJudgment(session) || !!session.reasoning_graph && session.reasoning_graph.conclusion === answer)
}

/** Unified task screens: reading is part of the question; checking is not a separate user step. */
export function initialUnifiedTrainingStep(session: TrainingSession): 'CHOOSE' | 'BASIS' {
  if (session.transfer_ready || session.summary_ready || session.completed) return 'BASIS'
  if (session.reasoning_graph) return guidedFirstJudgment(session) ? 'CHOOSE' : 'BASIS'
  return session.learning_trace?.stages[session.stage]?.first_attempt != null ? 'BASIS' : 'CHOOSE'
}
