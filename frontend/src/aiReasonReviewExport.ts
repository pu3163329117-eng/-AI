/** Read-only editorial handoff. Field equality is not certified consensus. */
import { validReviewDetail, validReviewQueue, type ReviewDetail, type ReviewQueue } from './aiReasonReview'

export const reviewBundleLimit = 8 * 1024 * 1024
export const comparisonFields = ['decision', 'context_sufficiency', 'suggested_labels'] as const
export const comparisonStatuses = ['NO_OPINION', 'ONE_OPINION', 'FIELDS_DIFFER', 'FIELDS_MATCH'] as const
export type ComparisonStatus = typeof comparisonStatuses[number]
export type ReviewComparison = { case_id: string; note_count: number; status: ComparisonStatus; differing_fields: (typeof comparisonFields[number])[] }
export type ReviewBundle = Pick<ReviewQueue, 'review_status' | 'reviewer_identity_verified' | 'semantic_accuracy_verified' | 'may_update_learning' | 'live_ai_release_gate_satisfied' | 'suite_version' | 'suite_digest'> & { format_version: 'ai-reason-review-bundle-v1'; generated_at: string; contains_self_entered_names: true; queue: ReviewQueue; cases: ReviewDetail[]; comparison: ReviewComparison[] }
const gateKeys = ['review_status', 'reviewer_identity_verified', 'semantic_accuracy_verified', 'may_update_learning', 'live_ai_release_gate_satisfied']
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, expected: readonly string[]) => Object.keys(v).length === expected.length && Object.keys(v).every(key => expected.includes(key))
const utcTime = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19)

export function compareReviewNotes(detail: ReviewDetail): ReviewComparison {
  const first = detail.notes[0]
  const differing = first ? comparisonFields.filter(field => detail.notes.some(note => field === 'suggested_labels'
    ? note.fields.suggested_labels.length !== first.fields.suggested_labels.length || note.fields.suggested_labels.some(label => !first.fields.suggested_labels.includes(label))
    : note.fields[field] !== first.fields[field])) : []
  return { case_id: detail.case_id, note_count: detail.notes.length, status: detail.notes.length === 0 ? 'NO_OPINION' : detail.notes.length === 1 ? 'ONE_OPINION' : differing.length ? 'FIELDS_DIFFER' : 'FIELDS_MATCH', differing_fields: differing }
}

export function validReviewBundle(v: unknown): v is ReviewBundle {
  if (!object(v) || !keys(v, [...gateKeys, 'suite_version', 'suite_digest', 'format_version', 'generated_at', 'contains_self_entered_names', 'queue', 'cases', 'comparison']) || v.review_status !== 'NOT_VERIFIED' || !gateKeys.slice(1).every(key => v[key] === false) || v.format_version !== 'ai-reason-review-bundle-v1' || !utcTime(v.generated_at) || v.contains_self_entered_names !== true || !validReviewQueue(v.queue) || v.suite_version !== v.queue.suite_version || v.suite_digest !== v.queue.suite_digest || !Array.isArray(v.cases) || !Array.isArray(v.comparison) || v.cases.length !== v.queue.total || v.comparison.length !== v.queue.total) return false
  const noteIds = new Set<string>()
  for (let index = 0; index < v.cases.length; index++) {
    const detail = v.cases[index], item = v.queue.items[index], summary = v.comparison[index]
    if (!validReviewDetail(detail) || detail.case_id !== item.case_id || detail.suite_digest !== v.suite_digest || detail.suite_version !== v.suite_version || detail.input_digest !== item.input_digest || detail.source !== item.source || detail.payload.target !== item.target || detail.payload.stage !== item.stage || detail.revision !== item.revision || (detail.notes.at(-1)?.fields.decision ?? null) !== item.decision) return false
    for (const note of detail.notes) { if (noteIds.has(note.id)) return false; noteIds.add(note.id) }
    const expected = compareReviewNotes(detail)
    if (!object(summary) || !keys(summary, ['case_id', 'note_count', 'status', 'differing_fields']) || summary.case_id !== expected.case_id || summary.note_count !== expected.note_count || summary.status !== expected.status || !Array.isArray(summary.differing_fields) || summary.differing_fields.length !== expected.differing_fields.length || !summary.differing_fields.every((field, position) => field === expected.differing_fields[position])) return false
  }
  return true
}

export function reviewBundleCounts(bundle: ReviewBundle): Record<ComparisonStatus, number> {
  const result = { NO_OPINION: 0, ONE_OPINION: 0, FIELDS_DIFFER: 0, FIELDS_MATCH: 0 }
  for (const detail of bundle.cases) result[compareReviewNotes(detail).status]++
  return result
}

/** Bound bytes while streaming, before parsing; Content-Length alone is not trusted. */
export async function readReviewBundle(response: Response): Promise<ReviewBundle> {
  const length = response.headers.get('Content-Length')
  if (length && Number(length) > reviewBundleLimit) { await response.body?.cancel(); throw new Error('AI_REVIEW_EXPORT_TOO_LARGE') }
  if (!response.body) throw new Error('INVALID_RESPONSE')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > reviewBundleLimit) { await reader.cancel(); throw new Error('AI_REVIEW_EXPORT_TOO_LARGE') }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new Error('INVALID_RESPONSE') }
  if (!validReviewBundle(value)) throw new Error('INVALID_RESPONSE')
  return value
}

/** Called only after the user's explicit download click and privacy acknowledgement. */
export function downloadReviewBundle(bundle: ReviewBundle) {
  if (!validReviewBundle(bundle)) throw new Error('INVALID_RESPONSE')
  const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json;charset=utf-8' })
  if (blob.size > reviewBundleLimit) throw new Error('AI_REVIEW_EXPORT_TOO_LARGE')
  const url = URL.createObjectURL(blob), anchor = document.createElement('a')
  try { anchor.href = url; anchor.download = 'wenyan-ai-review-bundle.json'; document.body.append(anchor); anchor.click() }
  finally { anchor.remove(); URL.revokeObjectURL(url) }
}
