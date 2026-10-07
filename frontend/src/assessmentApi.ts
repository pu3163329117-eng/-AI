import { RequestError, requestJson } from './http'
import { validAssessment, validAssessmentSummaries, validAvailability } from './assessment'
import type { AbilityLevel, AssessmentAvailability, AssessmentCommand, AssessmentMode, AssessmentSummary, SelfAnswers } from './assessment'

const root = import.meta.env.VITE_API_ROOT ?? ''
export function assessmentRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}
async function readSession(path: string, init: RequestInit = {}) {
  const data = await requestJson<{ assessment: unknown }>(`${root}${path}`, init)
  if (!validAssessment(data.assessment)) throw new RequestError('INVALID_RESPONSE', 200)
  return data.assessment
}
export const assessmentApi = {
  async availability(signal?: AbortSignal): Promise<AssessmentAvailability> {
    const data = await requestJson<unknown>(`${root}/api/v1/assessments/availability`, { signal })
    if (!validAvailability(data)) throw new RequestError('INVALID_RESPONSE', 200)
    return data
  },
  async list(profileId: string, signal?: AbortSignal): Promise<AssessmentSummary[]> {
    const data = await requestJson<unknown>(`${root}/api/v1/profiles/${encodeURIComponent(profileId)}/assessments`, { signal })
    if (!validAssessmentSummaries(data)) throw new RequestError('INVALID_RESPONSE', 200)
    return data.assessments
  },
  get: (id: string, signal?: AbortSignal) => readSession(`/api/v1/assessments/${encodeURIComponent(id)}`, { signal }),
  create: (profileId: string, mode: AssessmentMode, selfLevel: AbilityLevel | null, selfAnswers: SelfAnswers, key: string) => readSession('/api/v1/assessments', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ profile_id: profileId, mode, self_level: selfLevel, self_answers: selfAnswers }),
  }),
  command: (id: string, command: AssessmentCommand, key: string) => readSession(`/api/v1/assessments/${encodeURIComponent(id)}/commands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(command),
  }),
}
