/** Editorial bookkeeping only: counts do not certify correctness or reviewer identity. */
export type AnnotationCounts = { annotations: number; draft: number; approved: number; missing_citation: number; missing_source_url: number }
export type AnnotationQualityDocument = AnnotationCounts & { id: string; source: string }
export type AnnotationQuality = { version: 'annotation-quality-v1'; totals: AnnotationCounts & { documents: number }; documents: AnnotationQualityDocument[] }

const countKeys = ['annotations', 'draft', 'approved', 'missing_citation', 'missing_source_url'] as const
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
function validCounts(value: Record<string, unknown>): boolean {
  if (!countKeys.every(key => count(value[key]))) return false
  const row = value as AnnotationCounts
  return Number.isSafeInteger(row.draft + row.approved) && row.annotations === row.draft + row.approved
    && row.missing_citation <= row.annotations && row.missing_source_url <= row.annotations
}
export function validAnnotationQuality(value: unknown): value is AnnotationQuality {
  if (!record(value) || !exact(value, ['version', 'totals', 'documents']) || value.version !== 'annotation-quality-v1'
    || !record(value.totals) || !exact(value.totals, [...countKeys, 'documents']) || !validCounts(value.totals)
    || !Array.isArray(value.documents) || value.documents.length > 1000
    || value.totals.documents !== value.documents.length) return false
  const seen = new Set<string>()
  const documents = value.documents
  const totals = value.totals
  for (const row of documents) {
    if (!record(row) || !exact(row, ['id', 'source', ...countKeys]) || !validCounts(row)
      || typeof row.id !== 'string' || !uuid.test(row.id) || seen.has(row.id.toLowerCase())
      || typeof row.source !== 'string' || !row.source.trim() || row.source.length > 500) return false
    seen.add(row.id.toLowerCase())
  }
  return countKeys.every(key => {
    const sum = documents.reduce((total: number, row: AnnotationQualityDocument) => total + row[key], 0)
    return Number.isSafeInteger(sum) && sum === totals[key]
  })
}
