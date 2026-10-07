import { RequestError, requestJson } from './http'
import { validObservationReport } from './observations'

export const observationsApi = {
  async report(profileId: string, signal?: AbortSignal) {
    const data = await requestJson<unknown>(`${import.meta.env.VITE_API_ROOT ?? ''}/api/v1/profiles/${encodeURIComponent(profileId)}/observations/report`, { signal })
    if (!validObservationReport(data) || data.report.profile_id !== profileId) throw new RequestError('INVALID_RESPONSE', 200)
    return data.report
  },
}
