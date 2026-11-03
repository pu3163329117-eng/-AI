import type { CommandType, LearnerProfile, TrainingSession } from './types'

/** A resolved request is not necessarily a validated answer. Inspect server ready flags. */
export type TrainingCommandOutcome =
  | { status: 'confirmed'; session: TrainingSession }
  | { status: 'definitive_failure' | 'unknown' | 'blocked' | 'stale' }

export type TrainingCommandIntent = {
  sessionId: string; version: number; type: CommandType
  payload: Record<string, unknown>; key: string
}

export type TrainingCommandResponse = { session: TrainingSession; profile?: LearnerProfile }

type CommandExecution = {
  lock: { current: boolean }
  owner: { current: symbol | null }
  isCurrent: (intent: TrainingCommandIntent) => boolean
  isAlive: () => boolean
  send: (intent: TrainingCommandIntent) => Promise<TrainingCommandResponse>
  accept: (response: TrainingCommandResponse) => void
  begin: (type: CommandType) => void
  finish: () => void
  isUnknown: (error: unknown) => boolean
  unknown: (intent: TrainingCommandIntent, error: unknown) => void
  failure: (error: unknown) => void
  conflict: () => Promise<void>
}

/** The single App executor, with explicit outcomes; no retries or second write queue. */
export async function executeTrainingCommand(intent: TrainingCommandIntent, io: CommandExecution): Promise<TrainingCommandOutcome> {
  if (!io.isCurrent(intent)) return { status: 'stale' }
  if (io.lock.current) return { status: 'blocked' }
  const token = Symbol('training-command')
  io.owner.current = token
  io.lock.current = true
  io.begin(intent.type)
  const current = () => io.owner.current === token && io.isCurrent(intent)
  try {
    const response = await io.send(intent)
    if (!current()) return { status: 'stale' }
    // A replay receipt must not replace a newer snapshot or another learner's data.
    if (response.session.state_version !== intent.version + 1) {
      io.unknown(intent, new Error('INVALID_RESPONSE'))
      return { status: 'unknown' }
    }
    io.accept(response)
    return { status: 'confirmed', session: response.session }
  } catch (error) {
    if (!current()) return { status: 'stale' }
    if (io.isUnknown(error)) {
      io.unknown(intent, error)
      return { status: 'unknown' }
    }
    if (error instanceof Error && error.message === 'VERSION_CONFLICT') {
      await io.conflict()
    } else io.failure(error)
    return { status: 'definitive_failure' }
  } finally {
    // A stale completion can neither unlock a newer operation nor touch its UI.
    if (io.owner.current === token) {
      io.owner.current = null
      io.lock.current = false
      if (io.isAlive()) io.finish()
    }
  }
}
