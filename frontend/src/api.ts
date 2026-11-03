import type { Achievements, AdminLesson, AdminLessonInput, CommandType, DailyMission, KnowledgeCoverage, KnowledgeLookup, LearnerProfile, LearningSummary, Lesson, Mistake, PracticePlanGroupBy, PracticePlans, ReviewSession, SchoolStage, TrainingSession } from './types'
import { RequestError, requestJson } from './http'
import { validateResponse } from './contracts'
import { matchesAnnotationQueue, validQueueQuery } from './annotationQueue'
import type { AnnotationGap } from './annotationQueue'
import type { AnnotationDetail, AnnotationFields, ManagedAnnotation, ReasoningRecord } from './types'

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

const apiRoot = import.meta.env.VITE_API_ROOT ?? ''

// randomUUID requires a secure origin; LAN HTTP previews still have getRandomValues.
export function requestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const data = await requestJson<T>(`${apiRoot}${path}`, init)
  if (!validateResponse(path, data, init.method ?? 'GET')) throw new RequestError('INVALID_RESPONSE', 200)
  return data
}

// Compare JSON values without depending on object-key order. The saved body is
// compared only where the service promises to echo the submitted fields.
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => sameJson(item, right[index]))
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  const keys = Object.keys(a).sort(), other = Object.keys(b).sort()
  return sameJson(keys, other) && keys.every(key => sameJson(a[key], b[key]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function matchesCreatedLesson(lesson: AdminLesson, submitted: AdminLessonInput, allowExistingContent = false): boolean {
  const fields = ['school_stage', 'title', 'source', 'difficulty', 'estimated_minutes', 'summary', 'textbook_tags', 'theme', 'accumulation_points', 'reasoning_points', 'reasoning_level'] as const
  if (!fields.every(field => sameJson(lesson[field], submitted[field])) || !isRecord(lesson.content)) return false
  if (!submitted.content) return allowExistingContent || Object.keys(lesson.content).length === 0
  if (!isRecord(submitted.content) || !sameJson(Object.keys(lesson.content).sort(), Object.keys(submitted.content).sort())) return false
  for (const stage of Object.keys(submitted.content)) {
    const requested = submitted.content[stage], returned = lesson.content[stage]
    if (!isRecord(requested) || !isRecord(returned)) return false
    const { reading_context: supplied, ...original } = requested
    const { reading_context: resolved, ...echoed } = returned
    if (!sameJson(original, echoed)) return false
    if (supplied !== undefined) {
      if (!isRecord(supplied) || !isRecord(resolved) || !Array.isArray(supplied.paragraphs)) return false
      // Server accepts additional context keys but emits only this normalized projection.
      const expected = {
        paragraphs: supplied.paragraphs,
        full_text: supplied.paragraphs.join('\n\n'),
        author: supplied.author || '作者信息待教研补充', era: supplied.era || '时代信息待教研补充',
        work_note: supplied.work_note || '当前课内原文', extent: supplied.extent ?? 'EXCERPT',
        text_version: supplied.text_version || '课内资料 · 待教研逐篇校订', source_url: supplied.source_url || '', terms: supplied.terms ?? [],
      }
      if (!Object.entries(expected).every(([key, value]) => sameJson(resolved[key], value))) return false
    }
  }
  return true
}

export const trainingApi = {
  createSession: (profileId: string, lessonId: string) =>
    request<SessionResponse>('/api/v1/training/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId, lesson_id: lessonId }),
    }),
  command: (sessionId: string, expectedStateVersion: number, type: CommandType, payload = {}, idempotencyKey = requestId()) =>
    request<CommandResponse>(`/api/v1/training/sessions/${sessionId}/commands`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        type,
        payload,
        expected_state_version: expectedStateVersion,
      }),
    }),
  getSession: (sessionId: string) => request<{ session: TrainingSession }>(`/api/v1/training/sessions/${sessionId}`),
  reasoning: (sessionId: string, signal: AbortSignal) => request<{ records: ReasoningRecord[] }>(`/api/v1/training/sessions/${sessionId}/reasoning`, { signal }),
}

export const knowledgeApi = {
  coverage: (signal: AbortSignal) => request<KnowledgeCoverage>('/api/knowledge/coverage', { signal }),
  lookup: (sessionId: string, paragraphIndex: number, start: number, end: number, offset: number, signal: AbortSignal) => {
    const query = new URLSearchParams({ session_id: sessionId, paragraph_index: String(paragraphIndex), start: String(start), end: String(end), offset: String(offset), limit: '5' })
    return request<KnowledgeLookup>(`/api/knowledge/lookup?${query}`, { signal })
  },
}

export const annotationApi = {
  list: async (document: string, status: string, q: string, offset: number, signal: AbortSignal, gap: AnnotationGap = 'ALL') => {
    if (!validQueueQuery(document, status, q, offset, gap)) throw new RequestError('INVALID_INPUT', 400)
    const data = await request<{ total: number; items: ManagedAnnotation[] }>(`/api/v1/admin/knowledge/annotations?${new URLSearchParams({ document, status, q, offset: String(offset), gap })}`, { signal })
    if (!matchesAnnotationQueue(data, document, status, offset, gap)) throw new RequestError('INVALID_RESPONSE', 200)
    return data
  },
  get: (id: string, signal?: AbortSignal) => request<AnnotationDetail>(`/api/v1/admin/knowledge/annotations/${id}`, { signal }),
  edit: (id: string, expected_version: number, fields: AnnotationFields, actor: string, note: string) =>
    request<AnnotationDetail>(`/api/v1/admin/knowledge/annotations/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...fields, expected_version, actor, note }) }),
  review: (id: string, expected_version: number, actor: string, note: string) =>
    request<AnnotationDetail>(`/api/v1/admin/knowledge/annotations/${id}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_version, actor, note }) }),
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
  create: async (payload: AdminLessonInput) => {
    const body = JSON.stringify(payload)
    const submitted = JSON.parse(body) as AdminLessonInput
    const result = await request<AdminLessonResponse>('/api/v1/admin/lessons', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })
    if (!matchesCreatedLesson(result.lesson, submitted)) throw new RequestError('INVALID_RESPONSE', 200)
    return result
  },
  update: async (lessonId: string, payload: AdminLessonInput, expectedContentVersion: string) => {
    const body = JSON.stringify({ ...payload, expected_content_version: expectedContentVersion })
    const submitted = JSON.parse(body) as AdminLessonInput
    const result = await request<AdminLessonResponse>(`/api/v1/admin/lessons/${encodeURIComponent(lessonId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
    })
    if (result.lesson.id !== lessonId || !matchesCreatedLesson(result.lesson, submitted, true)) throw new RequestError('INVALID_RESPONSE', 200)
    return result
  },
  publish: (lessonId: string, expectedContentVersion: string) => request<AdminLessonResponse>(`/api/v1/admin/lessons/${encodeURIComponent(lessonId)}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected_content_version: expectedContentVersion }),
  }),
  review: async (lessonId: string, reviewer: string, note: string, expectedContentVersion: string) => {
    const result = await request<AdminLessonResponse>(`/api/v1/admin/lessons/${encodeURIComponent(lessonId)}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewer, note, expected_content_version: expectedContentVersion }),
    })
    const review = result.lesson.review
    if (result.lesson.id !== lessonId || !review || review.content_version !== expectedContentVersion || review.reviewer !== reviewer.trim() || review.note !== note) {
      throw new RequestError('INVALID_RESPONSE', 200)
    }
    return result
  },
}
