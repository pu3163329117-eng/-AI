import { RequestError, requestJson } from './http'
import { validateResponse } from './contracts'
import { validAbilityResponse, validRecommendationResponse, validRecommendationTask } from './learningPath'
import type { AbilityLevel } from './assessment'
import type { RecommendationTask } from './learningPath'
import type { TrainingSession } from './types'

const root = import.meta.env.VITE_API_ROOT ?? ''
const profilePath = (id: string) => `/api/v1/profiles/${encodeURIComponent(id)}`
export function pathRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}
async function readPlan(profileId: string, init: RequestInit = {}) {
  const data = await requestJson<unknown>(`${root}${profilePath(profileId)}/recommendations`, init)
  if (!validRecommendationResponse(data) || data.plan && data.plan.profile_id !== profileId) throw new RequestError('INVALID_RESPONSE', 200)
  return data.plan
}
export const learningPathApi = {
  async ability(profileId: string, signal?: AbortSignal) {
    const data = await requestJson<unknown>(`${root}${profilePath(profileId)}/ability`, { signal })
    if (!validAbilityResponse(data) || data.ability.profile_id !== profileId) throw new RequestError('INVALID_RESPONSE', 200)
    return data.ability
  },
  recommendations: (profileId: string, signal?: AbortSignal) => readPlan(profileId, { signal }),
  async generate(profileId: string, practiceLevel: AbilityLevel | null, key: string) {
    const plan = await readPlan(profileId, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ practice_level: practiceLevel }) })
    if (!plan) throw new RequestError('INVALID_RESPONSE', 200)
    return plan
  },
  async start(profileId: string, taskId: string, key: string) {
    const data = await requestJson<{ session_id: string; session: TrainingSession; task: RecommendationTask }>(`${root}${profilePath(profileId)}/recommendations/${encodeURIComponent(taskId)}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: '{}' })
    if (typeof data.session_id !== 'string' || !data.session_id || !validateResponse(`/api/v1/training/sessions/${encodeURIComponent(data.session_id)}`, { session: data.session }) || !validRecommendationTask(data.task) || data.task.id !== taskId || data.task.session_id !== data.session_id || data.session.profile_id !== undefined && data.session.profile_id !== profileId) throw new RequestError('INVALID_RESPONSE', 200)
    return data
  },
}
