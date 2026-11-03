import { RequestError, requestJson } from './http'
import { sameComparisonAnchor, validAnnotationComparison, validComparisonAnchor, type ComparisonAnchor } from './annotationComparison'

/** Explicit cancellable GET; no automatic retries, edits or query-string personal data. */
export async function readAnnotationComparisons(anchor: ComparisonAnchor, offset: number, signal: AbortSignal) {
  if (!validComparisonAnchor(anchor) || !Number.isSafeInteger(offset) || offset < 0) throw new RequestError('INVALID_COMPARISON_REQUEST')
  const frozen = { ...anchor }
  const limit = 5
  const query = new URLSearchParams({ expected_version: String(frozen.version), offset: String(offset), limit: String(limit) })
  const root = import.meta.env.VITE_API_ROOT ?? ''
  const response = await requestJson<unknown>(`${root}/api/v1/admin/knowledge/annotations/${encodeURIComponent(frozen.id)}/comparisons?${query}`, { signal })
  if (!validAnnotationComparison(response) || !sameComparisonAnchor(response.anchor, frozen) || response.offset !== offset || response.limit !== limit) throw new RequestError('INVALID_RESPONSE', 200)
  return response
}
