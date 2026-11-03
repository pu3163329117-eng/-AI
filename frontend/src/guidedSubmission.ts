import type { CommandType, TrainingSession } from './types'
import type { TrainingCommandOutcome } from './trainingCommandOutcome'

export type GuidedSubmissionStep = 'SAVE_REASONING' | 'SUBMIT_ATTEMPT' | 'CONTINUE_TO_TRANSFER' | 'COMPLETE_SESSION'
export type GuidedSubmissionResult = {
  status: TrainingCommandOutcome['status'] | 'needs_revision'
  session: TrainingSession
  stoppedAt?: GuidedSubmissionStep
}
export type VerifiedGuidedFeedback = {
  stage: TrainingSession['stage']
  stateVersion: number
  source: string
  feedback: string
}

/** Compare the submitted identifiers/position, never client-provided annotation prose. */
export function draftMatchesSavedGraph(session: TrainingSession, payload: Record<string, unknown>): boolean {
  const graph = session.reasoning_graph
  if (!graph || graph.stage !== session.stage) return false
  const kind = payload.basis_kind ?? 'CONTEXT'
  return graph.conclusion === payload.conclusion && graph.reason === payload.reason
    && graph.evidence.paragraph_index === payload.paragraph_index && graph.evidence.start === payload.start && graph.evidence.end === payload.end
    && (kind === 'ANNOTATION'
      ? graph.basis_kind === 'ANNOTATION' && !!graph.annotation && graph.annotation.id === payload.annotation_id && graph.annotation.version === payload.annotation_version
      : kind === 'CONTEXT' && graph.basis_kind !== 'ANNOTATION')
}

/** One explicit intent, original commands, no retries/effects/network client of its own. */
export async function runGuidedSubmission({ session, answer, payload, execute, isCurrent, onProgress, onVerified }: {
  session: TrainingSession
  answer: string
  payload: Record<string, unknown>
  execute: (type: CommandType, payload?: Record<string, unknown>, expectedVersion?: number) => Promise<TrainingCommandOutcome>
  isCurrent: (confirmed: TrainingSession) => boolean
  onProgress?: (step: GuidedSubmissionStep) => void
  onVerified?: (feedback: VerifiedGuidedFeedback) => void
}): Promise<GuidedSubmissionResult> {
  let confirmed = session
  const stage = session.stage
  const stop = (status: GuidedSubmissionResult['status'], stoppedAt?: GuidedSubmissionStep): GuidedSubmissionResult => ({ status, session: confirmed, stoppedAt })
  const initiallyReady = stage === 'CORE' ? session.transfer_ready : session.summary_ready
  if (session.completed || !initiallyReady && (!answer || payload.conclusion !== answer) || !isCurrent(confirmed)) return stop('blocked')
  const send = async (type: GuidedSubmissionStep, body?: Record<string, unknown>): Promise<GuidedSubmissionResult | null> => {
    if (!isCurrent(confirmed)) return stop('stale', type)
    onProgress?.(type)
    let outcome: TrainingCommandOutcome
    // A rejected transport Promise must never let the chain proceed or invent a receipt.
    try { outcome = await execute(type, body, confirmed.state_version) } catch { return stop('unknown', type) }
    if (outcome.status !== 'confirmed') return stop(outcome.status, type)
    const next = outcome.session
    if (!Number.isSafeInteger(next.state_version) || next.state_version <= confirmed.state_version) return stop('stale', type)
    if (type === 'CONTINUE_TO_TRANSFER' ? next.stage !== 'TRANSFER' || next.completed
      : type === 'COMPLETE_SESSION' ? !next.completed
      : next.stage !== stage || next.completed) return stop('stale', type)
    confirmed = next
    return null
  }
  const ready = () => stage === 'CORE' ? confirmed.transfer_ready : confirmed.summary_ready
  if (!ready()) {
    // No synthetic first-attempt record: only the explicit first CTA can create it.
    if (session.learning_trace?.stages[stage]?.first_attempt === null) return stop('blocked')
    if (!draftMatchesSavedGraph(confirmed, payload)) {
      const failed = await send('SAVE_REASONING', payload)
      if (failed) return failed
      if (!draftMatchesSavedGraph(confirmed, payload)) return stop('stale', 'SAVE_REASONING')
    }
    const failed = await send('SUBMIT_ATTEMPT', { answer })
    if (failed) return failed
    if (!ready()) return stop('needs_revision', 'SUBMIT_ATTEMPT')
  }
  if (!isCurrent(confirmed)) return stop('stale')
  // Retain the exact ready receipt before the next command replaces session.feedback.
  // Historical absent/blank feedback is unknown, not a reason to invent success prose.
  if (typeof confirmed.feedback === 'string' && confirmed.feedback.trim()) onVerified?.({
    stage, stateVersion: confirmed.state_version,
    source: confirmed.source, feedback: confirmed.feedback,
  })
  const failed = await send(stage === 'CORE' ? 'CONTINUE_TO_TRANSFER' : 'COMPLETE_SESSION')
  return failed ?? stop('confirmed')
}
