import type { Achievements, AdminLesson, AdminLessonInput, CommandType, DailyMission, LearnerProfile, LearningSummary, Lesson, Mistake, PracticePlanGroupBy, PracticePlans, ReviewSession, SchoolStage, TrainingSession } from './types'

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
type MistakesResponse = { mistakes: Mistake[] }
type LearningSummaryResponse = { summary: LearningSummary }
type DailyMissionResponse = { mission: DailyMission }
type PracticePlansResponse = PracticePlans
type AchievementsResponse = Achievements
type LessonsResponse = { lessons: Lesson[] }
type AdminLessonsResponse = { lessons: AdminLesson[] }
type AdminLessonResponse = { lesson: AdminLesson }

type ErrorResponse = { error?: { code?: string } }

const apiRoot = import.meta.env.VITE_API_ROOT ?? ''

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiRoot}${path}`, init)
  const body = (await response.json().catch(() => null)) as T & ErrorResponse
  if (!response.ok) throw new Error(body?.error?.code ?? 'REQUEST_FAILED')
  return body
}

export const trainingApi = {
  createSession: (profileId: string, lessonId: string) =>
    request<SessionResponse>('/api/v1/training/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId, lesson_id: lessonId }),
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
  listMistakes: (profileId: string) => request<MistakesResponse>(`/api/v1/profiles/${profileId}/mistakes`),
  getLearningSummary: (profileId: string) => request<LearningSummaryResponse>(`/api/v1/profiles/${profileId}/learning-summary`),
  getDailyMission: (profileId: string) => request<DailyMissionResponse>(`/api/v1/profiles/${profileId}/daily-mission`),
  getAchievements: (profileId: string) => request<AchievementsResponse>(`/api/v1/profiles/${profileId}/achievements`),
  getPracticePlans: (profileId: string, groupBy: PracticePlanGroupBy) =>
    request<PracticePlansResponse>(`/api/v1/profiles/${profileId}/practice-plans?group_by=${encodeURIComponent(groupBy)}`),
}

export const lessonApi = {
  list: (schoolStage: SchoolStage) =>
    request<LessonsResponse>(`/api/v1/lessons?school_stage=${encodeURIComponent(schoolStage)}`),
}

export const adminLessonApi = {
  list: () => request<AdminLessonsResponse>('/api/v1/admin/lessons'),
  get: (lessonId: string) => request<AdminLessonResponse>(`/api/v1/admin/lessons/${encodeURIComponent(lessonId)}`),
  create: (payload: AdminLessonInput) => request<AdminLessonResponse>('/api/v1/admin/lessons', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }),
  update: (lessonId: string, payload: AdminLessonInput) => request<AdminLessonResponse>(`/api/v1/admin/lessons/${encodeURIComponent(lessonId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }),
  publish: (lessonId: string) => request<AdminLessonResponse>(`/api/v1/admin/lessons/${encodeURIComponent(lessonId)}/publish`, {
    method: 'POST',
  }),
}
