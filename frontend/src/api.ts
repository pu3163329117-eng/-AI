import type { CommandType, LearnerProfile, ReviewSession, SchoolStage, TrainingSession } from './types'

type SessionResponse = { session_id: string; session: TrainingSession }

type CommandResponse = {
  session_id: string
  state: string
  state_version: number
  session: TrainingSession
  profile?: LearnerProfile
}

type ProfileResponse = { profile: LearnerProfile }
type ReviewSessionsResponse = { sessions: ReviewSession[] }

type ErrorResponse = { error?: { code?: string } }

const apiRoot = import.meta.env.VITE_API_ROOT ?? ''

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiRoot}${path}`, init)
  const body = (await response.json().catch(() => null)) as T & ErrorResponse
  if (!response.ok) throw new Error(body?.error?.code ?? 'REQUEST_FAILED')
  return body
}

export const trainingApi = {
  createSession: (profileId: string) =>
    request<SessionResponse>('/api/v1/training/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId }),
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
  getSession: (sessionId: string) => request<{ session: TrainingSession }>(`/api/v1/training/sessions/${sessionId}`),
}

export const profileApi = {
  create: (displayName: string, schoolStage: SchoolStage) =>
    request<ProfileResponse>('/api/v1/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: displayName, school_stage: schoolStage }),
    }),
  get: (profileId: string) => request<ProfileResponse>(`/api/v1/profiles/${profileId}`),
  listSessions: (profileId: string) => request<ReviewSessionsResponse>(`/api/v1/profiles/${profileId}/sessions`),
}
