import { RequestError, requestJson } from './http'
import { previewRequest, validFeedbackPreview } from './aiFeedback'

const apiRoot = import.meta.env.VITE_API_ROOT ?? ''
export const aiFeedbackApi = {
  available: async (signal: AbortSignal) => {
    const value = await requestJson<Record<string, unknown>>(`${apiRoot}/api/v1/ai/status`, { signal })
    if (typeof value.local_preview_available !== 'boolean') throw new RequestError('INVALID_RESPONSE')
    return value.local_preview_available
  },
  preview: async (sessionId: string, version: number, signal: AbortSignal) => {
    const value = await requestJson(`${apiRoot}/api/v1/ai/sessions/${encodeURIComponent(sessionId)}/reason-feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(previewRequest(version)), signal,
    }, 8000)
    if (!validFeedbackPreview(value)) throw new RequestError('INVALID_RESPONSE')
    return value.feedback
  },
}
