/** Pure decoration math. Layout, semantics and real text never depend on it. */
export const TITLE_REPEL_RADIUS = 110
export const TITLE_REPEL_MAX = 16
export const TITLE_RETURN_MS = 320
export const TITLE_GRAPHEME_LIMIT = 96

export type TitleGrapheme = { text: string; start: number; end: number }
export type TitlePoint = { x: number; y: number }

/** UTF-16 offsets are for DOM Range; grapheme boundaries never split a glyph. */
export function segmentTitle(text: string): TitleGrapheme[] {
  if (typeof Intl.Segmenter !== 'function') return [] // Static fallback, no unsafe Array.from split.
  const segments: TitleGrapheme[] = []
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (segments.length >= TITLE_GRAPHEME_LIMIT) return []
    segments.push({ text: part.segment, start: part.index, end: part.index + part.segment.length })
  }
  return segments
}

/** A bounded, smoothly vanishing push away from the untransformed baseline. */
export function titleRepulsion(center: TitlePoint, pointer: TitlePoint): TitlePoint {
  if (![center.x, center.y, pointer.x, pointer.y].every(Number.isFinite)) return { x: 0, y: 0 }
  const dx = center.x - pointer.x, dy = center.y - pointer.y
  const distance = Math.hypot(dx, dy)
  if (distance >= TITLE_REPEL_RADIUS) return { x: 0, y: 0 }
  const proximity = 1 - distance / TITLE_REPEL_RADIUS
  const amount = TITLE_REPEL_MAX * proximity * proximity * (3 - 2 * proximity)
  if (distance < 0.001) return { x: 0, y: -amount }
  return { x: dx / distance * amount, y: dy / distance * amount }
}
