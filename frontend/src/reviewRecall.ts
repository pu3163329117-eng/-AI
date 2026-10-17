import type { Mistake } from './types'

export type ReviewOrder = 'recent' | 'frequent' | 'oldest'
function attemptTime(value: string | null): number | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}
/** Search visible prompts only: concealed hints must not leak through search. */
export function selectReviewItems(items: readonly Mistake[], query: string, order: ReviewOrder): Mistake[] {
  const needle = query.trim().toLocaleLowerCase('zh-CN')
  return items.filter(item => !needle || [item.title, item.source, item.variable, item.passage]
    .some(value => value.toLocaleLowerCase('zh-CN').includes(needle)))
    .sort((a, b) => {
      if (order === 'frequent' && a.wrong_attempts !== b.wrong_attempts) return b.wrong_attempts - a.wrong_attempts
      const at = attemptTime(a.latest_attempt_at), bt = attemptTime(b.latest_attempt_at)
      if (at === null && bt !== null) return 1
      if (bt === null && at !== null) return -1
      if (at !== null && bt !== null && at !== bt) return order === 'oldest' ? at - bt : bt - at
      return a.lesson_id.localeCompare(b.lesson_id)
    })
}
export function reviewAttemptLabel(value: string | null): string {
  const time = attemptTime(value)
  if (time === null) return '最近作答时间待同步'
  return `最近作答 ${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(time)}`
}
/** Remount disclosures when their underlying learning material changes. */
export function reviewContentKey(item: Mistake): string {
  return JSON.stringify([item.lesson_id, item.title, item.source, item.variable, item.passage, item.review_hint, item.latest_attempt_at, item.wrong_attempts])
}
