import type { TrainingSession } from './types'

/** A saved chain is the latest intent; selected_answer can be an older attempt. */
export function restoredAnswer(session: Pick<TrainingSession, 'reasoning_graph' | 'selected_answer'>): string | null {
  return session.reasoning_graph?.conclusion ?? session.selected_answer
}
