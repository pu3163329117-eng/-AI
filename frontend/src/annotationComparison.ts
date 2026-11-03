/** Candidate bookkeeping, never a semantic equivalence or teacher certificate. */
export type ComparisonAnchor = { id: string; document_id: string; version: number; token: string; sense_key: string }
export type ComparisonItem = ComparisonAnchor & {
  source: string; paragraph_index: number; start: number; end: number; sentence: string
  meaning: string; part_of_speech: string; variability: 'CONTEXTUAL' | 'STABLE'; reasoning: string
  status: 'DRAFT' | 'APPROVED'; citation: string; source_url: string; match: 'SAME_KEY' | 'SAME_TOKEN'
}
export type AnnotationComparison = { version: 'annotation-comparison-v1'; anchor: ComparisonAnchor; offset: number; limit: number; total: number; items: ComparisonItem[] }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const anchorKeys = ['id', 'document_id', 'version', 'token', 'sense_key'] as const
const itemKeys = [...anchorKeys, 'source', 'paragraph_index', 'start', 'end', 'sentence', 'meaning', 'part_of_speech', 'variability', 'reasoning', 'status', 'citation', 'source_url', 'match'] as const
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown, max: number, nonempty = false): value is string => typeof value === 'string' && Array.from(value).length <= max && (!nonempty || !!value.trim())
export function validComparisonAnchor(value: unknown): value is ComparisonAnchor {
  return record(value) && exact(value, anchorKeys) && typeof value.id === 'string' && uuid.test(value.id)
    && typeof value.document_id === 'string' && uuid.test(value.document_id) && integer(value.version)
    && text(value.token, 100, true) && text(value.sense_key, 160)
}
export function sameComparisonAnchor(first: ComparisonAnchor, second: ComparisonAnchor): boolean {
  return anchorKeys.every(key => first[key] === second[key])
}
export function safeComparisonUrl(value: string): string | null {
  if (!value || value !== value.trim() || /[\u0000-\u0020\u007f]/.test(value)) return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password ? url.href : null
  } catch { return null }
}
export function validAnnotationComparison(value: unknown): value is AnnotationComparison {
  if (!record(value) || !exact(value, ['version', 'anchor', 'offset', 'limit', 'total', 'items'])
    || value.version !== 'annotation-comparison-v1' || !validComparisonAnchor(value.anchor)
    || !integer(value.offset) || !integer(value.limit) || value.limit < 1 || value.limit > 10 || !integer(value.total)
    || !Array.isArray(value.items) || value.items.length !== Math.min(value.limit, Math.max(0, value.total - value.offset))) return false
  const seen = new Set<string>()
  for (const item of value.items) {
    if (!record(item) || !exact(item, itemKeys) || !validComparisonAnchor(Object.fromEntries(anchorKeys.map(key => [key, item[key]])))
      || String(item.id).toLowerCase() === value.anchor.id.toLowerCase() || seen.has(String(item.id).toLowerCase())
      || !text(item.source, 200, true) || !integer(item.paragraph_index) || !integer(item.start) || !integer(item.end) || item.end <= item.start
      || item.end - item.start !== Array.from(String(item.token)).length || !text(item.sentence, 20000, true)
      || !text(item.meaning, 2000, true) || !text(item.part_of_speech, 80, true) || !text(item.reasoning, 4000, true)
      || !['CONTEXTUAL', 'STABLE'].includes(String(item.variability)) || !['DRAFT', 'APPROVED'].includes(String(item.status))
      || !text(item.citation, 2000) || !text(item.source_url, 2000)) return false
    const sameKey = !!value.anchor.sense_key.trim() && item.sense_key === value.anchor.sense_key
    if (item.match !== (sameKey ? 'SAME_KEY' : 'SAME_TOKEN') || (!sameKey && item.token !== value.anchor.token)) return false
    seen.add(String(item.id).toLowerCase())
  }
  return true
}
