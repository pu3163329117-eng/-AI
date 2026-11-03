import { RequestError, requestJson } from './http'

export const PRODUCT_TOUR_VERSION = '2026-10-v1' as const
export type TourStep = 0 | 1 | 2 | 3
export type ProductTourState = {
  version: typeof PRODUCT_TOUR_VERSION
  step: TourStep
  completed: boolean
  completed_at: string | null
}

export function validTourState(value: unknown): value is ProductTourState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as ProductTourState
  if (state.version !== PRODUCT_TOUR_VERSION || !Number.isInteger(state.step) || state.step < 0 || state.step > 3 || typeof state.completed !== 'boolean') return false
  if (!state.completed) return state.completed_at === null
  return state.step === 3 && typeof state.completed_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(state.completed_at) && Number.isFinite(Date.parse(state.completed_at))
}

export function tourSwipeDirection(dx: number, dy: number, elapsed: number): -1 | 0 | 1 {
  if (elapsed > 800 || Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.7) return 0
  return dx < 0 ? 1 : -1
}

export function tourNeedsAccount(session: { mode: 'local' | 'invite'; authenticated: boolean; user: unknown }) {
  return session.mode === 'invite' && session.authenticated && !!session.user
}

const apiRoot = import.meta.env.VITE_API_ROOT ?? ''
async function readResponse(init: RequestInit) {
  const state = await requestJson<unknown>(`${apiRoot}/api/v1/experience/tour`, init)
  if (!validTourState(state)) throw new RequestError('INVALID_RESPONSE', 200)
  return state
}

export const experienceTourApi = {
  get: (signal?: AbortSignal) => readResponse({ signal }),
  save: (step: TourStep, complete = false) => readResponse({
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: PRODUCT_TOUR_VERSION, step, complete }),
  }),
}
