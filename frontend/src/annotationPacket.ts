/** Saved editorial material only; never a teacher certificate or learner export. */
export const ANNOTATION_PACKET_MAX_BYTES = 8 * 1024 * 1024
export type AnnotationPacketDocument = {
  id: string; source: string; author: string; era: string
  extent: 'FULL' | 'CHAPTER' | 'EXCERPT' | 'PROMPT'
  text_version: string; work_note: string; source_url: string; paragraphs: string[]
}
export type AnnotationPacketItem = {
  id: string; document_id: string; paragraph_index: number; start: number; end: number
  token: string; sentence: string; sense_key: string; meaning: string; part_of_speech: string
  variability: 'CONTEXTUAL' | 'STABLE'; reasoning: string; status: 'DRAFT' | 'APPROVED'
  version: number; citation: string; source_url: string
}
export type AnnotationPacket = {
  version: 'annotation-review-packet-v1'; document: AnnotationPacketDocument
  summary: { annotations: number; draft: number; approved: number; missing_citation: number; missing_source_url: number; missing_either: number }
  items: AnnotationPacketItem[]; snapshot_sha256: string
}
const documentKeys = ['id', 'source', 'author', 'era', 'extent', 'text_version', 'work_note', 'source_url', 'paragraphs']
const itemKeys = ['id', 'document_id', 'paragraph_index', 'start', 'end', 'token', 'sentence', 'sense_key', 'meaning', 'part_of_speech', 'variability', 'reasoning', 'status', 'version', 'citation', 'source_url']
const summaryKeys = ['annotations', 'draft', 'approved', 'missing_citation', 'missing_source_url', 'missing_either'] as const
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const validPacketDocumentId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown, max: number, nonempty = false): value is string => typeof value === 'string'
  && value.length <= max * 2 && Array.from(value).length <= max && (!nonempty || !packetFieldBlank(value))
  && !Array.from(value).some(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff)
// Python str.strip whitespace, including NEL and the four information separators.
export const packetFieldBlank = (value: string) => /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/.test(value)

export function validAnnotationPacket(value: unknown): value is AnnotationPacket {
  if (!record(value) || !exact(value, ['version', 'document', 'summary', 'items', 'snapshot_sha256'])
    || value.version !== 'annotation-review-packet-v1' || typeof value.snapshot_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.snapshot_sha256)
    || !record(value.document) || !exact(value.document, documentKeys) || !record(value.summary) || !exact(value.summary, summaryKeys)
    || !Array.isArray(value.items) || value.items.length > 2000) return false
  const doc = value.document
  if (!validPacketDocumentId(doc.id) || !text(doc.source, 200, true) || !text(doc.author, 200) || !text(doc.era, 200)
    || typeof doc.extent !== 'string' || !['FULL', 'CHAPTER', 'EXCERPT', 'PROMPT'].includes(doc.extent) || !text(doc.text_version, 200)
    || !text(doc.work_note, 4000) || !text(doc.source_url, 2000) || !Array.isArray(doc.paragraphs)
    || doc.paragraphs.length > 500 || !doc.paragraphs.every(p => text(p, 20000))) return false
  const paragraphs = (doc.paragraphs as string[]).map(p => Array.from(p))
  const counts = { annotations: value.items.length, draft: 0, approved: 0, missing_citation: 0, missing_source_url: 0, missing_either: 0 }
  const seen = new Set<string>()
  let previous: AnnotationPacketItem | null = null
  for (const raw of value.items) {
    if (!record(raw) || !exact(raw, itemKeys) || !validPacketDocumentId(raw.id) || raw.document_id !== doc.id
      || seen.has(raw.id.toLowerCase()) || !integer(raw.paragraph_index) || !integer(raw.start) || !integer(raw.end)
      || raw.end <= raw.start || !integer(raw.version) || !text(raw.token, 100, true) || !text(raw.sentence, 20000, true)
      || !text(raw.sense_key, 160) || !text(raw.meaning, 2000, true) || !text(raw.part_of_speech, 80, true)
      || !text(raw.reasoning, 4000, true) || !text(raw.citation, 2000) || !text(raw.source_url, 2000)
      || typeof raw.variability !== 'string' || !['CONTEXTUAL', 'STABLE'].includes(raw.variability)
      || typeof raw.status !== 'string' || !['DRAFT', 'APPROVED'].includes(raw.status)) return false
    const item = raw as unknown as AnnotationPacketItem
    const paragraph = paragraphs[item.paragraph_index]
    if (!paragraph || item.end > paragraph.length || paragraph.slice(item.start, item.end).join('') !== item.token) return false
    if (previous) {
      const comparison = item.paragraph_index - previous.paragraph_index || item.start - previous.start || item.end - previous.end
        || (item.id < previous.id ? -1 : item.id > previous.id ? 1 : 0)
      if (comparison <= 0) return false
    }
    previous = item; seen.add(item.id.toLowerCase())
    counts[item.status === 'DRAFT' ? 'draft' : 'approved']++
    const missingCitation = packetFieldBlank(item.citation), missingUrl = packetFieldBlank(item.source_url)
    if (missingCitation) counts.missing_citation++
    if (missingUrl) counts.missing_source_url++
    if (missingCitation || missingUrl) counts.missing_either++
  }
  const summary = value.summary
  if (!summaryKeys.every(key => integer(summary[key]) && summary[key] === counts[key])) return false
  return new TextEncoder().encode(JSON.stringify(value)).length <= ANNOTATION_PACKET_MAX_BYTES
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
/** Mirrors Python ensure_ascii=False / sort_keys / compact separators. */
export function canonicalAnnotationPacket(packet: AnnotationPacket): string {
  return JSON.stringify(canonical({ version: packet.version, document: packet.document, summary: packet.summary, items: packet.items }))
}
const verified = new WeakSet<object>()
function freeze(value: unknown): void {
  if (value && typeof value === 'object') { for (const nested of Object.values(value)) freeze(nested); Object.freeze(value) }
}
export async function verifyAnnotationPacket(value: unknown): Promise<AnnotationPacket | null> {
  if (!validAnnotationPacket(value)) return null
  const bytes = new TextEncoder().encode(canonicalAnnotationPacket(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const sha = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
  if (sha !== value.snapshot_sha256) return null
  freeze(value); verified.add(value)
  return value
}
/** Only a verified immutable saved snapshot; no GET, external send, or draft. */
export function downloadAnnotationPacket(packet: AnnotationPacket): void {
  if (!verified.has(packet) || !validAnnotationPacket(packet)) throw new Error('INVALID_RESPONSE')
  const filename = `annotation-review-${packet.document.id.toLowerCase()}-${packet.snapshot_sha256.slice(0, 12)}.json`
  const blob = new Blob([JSON.stringify(packet)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  try { anchor.href = url; anchor.download = filename; anchor.hidden = true; document.body.appendChild(anchor); anchor.click() }
  finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
}
