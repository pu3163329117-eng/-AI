import type { CommandType, TrainingSession } from './types'

type SessionResponse = { session_id: string; session: TrainingSession }

type CommandResponse = {
  session_id: string
  state: string
  state_version: number
  session: TrainingSession
}

type ErrorResponse = { error?: { code?: string } }

const apiRoot = import.meta.env.VITE_API_ROOT ?? ''

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiRoot}${path}`, init)
  const body = (await response.json().catch(() => null)) as T & ErrorResponse
  if (!response.ok) throw new Error(body?.error?.code ?? 'REQUEST_FAILED')
  return body
}

export const trainingApi = {
  createSession: () =>
    request<SessionResponse>('/api/v1/training/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  command: (sessionId: string, expectedStateVersion: number, type: CommandType, payload = {}) =>
    request<CommandResponse>(`/api/v1/training/sessions/${sessionId}/commands`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        type,
        payload,
        expected_state_version: expectedStateVersion,
      }),
    }),
}
