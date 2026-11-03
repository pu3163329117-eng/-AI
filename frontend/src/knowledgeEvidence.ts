/** Untrusted admin read contract. Availability is a binding check, not approval. */
export const EVIDENCE_MAX_BYTES = 256 * 1024
export const evidenceTokens = ['从', '假', '去', '坐', '属', '归', '穷', '贻'] as const
export type EvidenceItem = {
  id: string; token: string; document_id: string; source: string; corpus_hash: string; text_version: string
  extent: 'FULL' | 'CHAPTER' | 'EXCERPT'; paragraph_index: number; start: number; end: number
  sentence: string; annotation_id: string; sense_key: string; availability: 'AVAILABLE' | 'UNAVAILABLE'
  annotation_version: number | null; annotation_status: 'DRAFT' | 'APPROVED' | null
  evidence_kind: 'ORIGINAL_CONTEXT'; catalog_status: 'CANDIDATE'; source_title: string; source_url: string
  source_locator: string; source_quote: string; source_checked_on: string; version_note: string
  interpretation_source_status: 'NOT_PROVIDED'; related_ids: string[]
}
export type KnowledgeEvidence = {
  version: 'knowledge-evidence-v1'; batch_id: 'core-eight-20261025'
  summary: { targets: number; candidates: number; available: number; unavailable: number; original_context: number; interpretation_sources: number; applied: number }
  items: EvidenceItem[]
}
const itemKeys = 'id token document_id source corpus_hash text_version extent paragraph_index start end sentence annotation_id sense_key availability annotation_version annotation_status evidence_kind catalog_status source_title source_url source_locator source_quote source_checked_on version_note interpretation_source_status related_ids'.split(' ')
const summaryKeys = 'targets candidates available unavailable original_context interpretation_sources applied'.split(' ')
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const string = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
export const validEvidenceDocument = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
const id = (v: unknown): v is string => typeof v === 'string' && /^core-eight-20261025:[a-z]+-[a-z]+$/.test(v)
function sourceUrl(v: unknown) {
  if (!string(v, 2048)) return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.search && !u.hash
      && ['zh.wikisource.org', 'en.wikisource.org'].includes(u.hostname) && u.pathname !== '/'
  } catch { return false }
}
/** Strict shape and correlated counters, never guess meaning or rewrite source text. */
export function verifyKnowledgeEvidence(value: unknown, document: string | null = null): KnowledgeEvidence | null {
  if (document !== null && !validEvidenceDocument(document)) return null
  if (!record(value) || !exact(value, ['version', 'batch_id', 'summary', 'items'])
    || value.version !== 'knowledge-evidence-v1' || value.batch_id !== 'core-eight-20261025'
    || !record(value.summary) || !exact(value.summary, summaryKeys)
    || !summaryKeys.every(k => integer(value.summary && (value.summary as Record<string, unknown>)[k]))
    || !Array.isArray(value.items) || value.items.length > 16) return null
  const items: EvidenceItem[] = []
  for (const v of value.items) {
    if (!record(v) || !exact(v, itemKeys) || !id(v.id) || !validEvidenceDocument(v.document_id)
      || !validEvidenceDocument(v.annotation_id) || (document !== null && v.document_id !== document)
      || typeof v.token !== 'string' || !(evidenceTokens as readonly string[]).includes(v.token)
      || !string(v.source, 200) || !string(v.text_version) || !string(v.sentence) || !string(v.sense_key, 200)
      || typeof v.corpus_hash !== 'string' || !/^[0-9a-f]{64}$/.test(v.corpus_hash)
      || typeof v.extent !== 'string' || !['FULL', 'CHAPTER', 'EXCERPT'].includes(v.extent)
      || !integer(v.paragraph_index) || !integer(v.start) || !integer(v.end) || v.end - v.start !== [...v.token].length
      || !v.sentence.includes(v.token) || typeof v.availability !== 'string' || !['AVAILABLE', 'UNAVAILABLE'].includes(v.availability)
      || v.evidence_kind !== 'ORIGINAL_CONTEXT' || v.catalog_status !== 'CANDIDATE'
      || v.interpretation_source_status !== 'NOT_PROVIDED' || !string(v.source_title) || !sourceUrl(v.source_url)
      || !string(v.source_locator) || !string(v.source_quote) || !string(v.version_note)
      || v.source_checked_on !== '2026-10-25' || !Array.isArray(v.related_ids) || v.related_ids.length !== 1
      || !v.related_ids.every(id) || v.related_ids.includes(v.id)) return null
    if (v.availability === 'AVAILABLE' ? !integer(v.annotation_version) || typeof v.annotation_status !== 'string' || !['DRAFT', 'APPROVED'].includes(v.annotation_status)
      : v.annotation_version !== null || v.annotation_status !== null) return null
    items.push(v as unknown as EvidenceItem)
  }
  if (new Set(items.map(v => v.id)).size !== items.length || new Set(items.map(v => v.annotation_id)).size !== items.length) return null
  for (const item of items) {
    const peers = items.filter(v => v.token === item.token)
    if (peers.length > 2 || peers.some(v => v.id !== item.id && (!item.related_ids.includes(v.id) || !v.related_ids.includes(item.id)))) return null
  }
  const summary = value.summary
  const available = items.filter(v => v.availability === 'AVAILABLE').length
  if (summary.targets !== new Set(items.map(v => v.token)).size || summary.candidates !== items.length
    || summary.available !== available || summary.unavailable !== items.length - available
    || summary.original_context !== items.length || summary.interpretation_sources !== 0 || summary.applied !== 0) return null
  return value as unknown as KnowledgeEvidence
}
