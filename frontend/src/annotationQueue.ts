import type { ManagedAnnotation } from './types'

export type AnnotationGap = 'ALL' | 'MISSING_CITATION' | 'MISSING_SOURCE_URL' | 'MISSING_EITHER'
const gaps: readonly string[] = ['ALL', 'MISSING_CITATION', 'MISSING_SOURCE_URL', 'MISSING_EITHER']
const statuses = ['ALL', 'DRAFT', 'APPROVED']
// Match Python str.strip / SQLite editorial blank-field counting, including NEL
// and U+001C–001F, which JavaScript trim does not include.
const blank = (value: string | null) => value == null || /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/.test(value)

export function validQueueQuery(document: string, status: string, q: string, offset: number, gap: AnnotationGap): boolean {
  return typeof document === 'string' && document.length > 0 && document.length <= 36
    && statuses.includes(status) && typeof q === 'string' && q.length <= 80
    && Number.isSafeInteger(offset) && offset >= 0 && gaps.includes(gap)
}

/** Additional identity/filter checks after the existing managed-annotation shape guard. */
export function matchesAnnotationQueue(data: { total: number; items: ManagedAnnotation[] }, document: string,
  status: string, offset: number, gap: AnnotationGap): boolean {
  if (!Number.isSafeInteger(data.total) || data.total < 0 || data.items.length !== Math.min(25, Math.max(0, data.total - offset))) return false
  const seen = new Set<string>()
  return data.items.every(item => {
    if (seen.has(item.id.toLowerCase()) || item.document_id !== document || (status !== 'ALL' && item.status !== status)) return false
    seen.add(item.id.toLowerCase())
    const citationMissing = blank(item.citation), sourceMissing = blank(item.source_url)
    return gap === 'ALL' || (gap === 'MISSING_CITATION' && citationMissing)
      || (gap === 'MISSING_SOURCE_URL' && sourceMissing) || (gap === 'MISSING_EITHER' && (citationMissing || sourceMissing))
  })
}
