import test from 'node:test'
import assert from 'node:assert/strict'
import { importSource } from './import-source.mjs'
const { selectReviewItems, reviewAttemptLabel, reviewContentKey } = await importSource('reviewRecall.ts')
const item = (lesson_id, patch = {}) => ({ lesson_id, title: '劝学', source: '荀子', variable: '于', passage: '青，取之于蓝，而青于蓝。', review_hint: '比较对象', wrong_attempts: 2, latest_attempt_at: '2026-10-14T18:00:00Z', ...patch })

test('filters titles, sources, variables and original text, not hidden hints', () => {
  const data = [item('a')]
  for (const query of ['  劝学 ', '荀子', '于', '取之']) assert.equal(selectReviewItems(data, query, 'recent').length, 1)
  assert.equal(selectReviewItems(data, '比较对象', 'recent').length, 0)
  assert.equal(selectReviewItems(data, '不存在', 'recent').length, 0)
  assert.equal(selectReviewItems([], '', 'recent').length, 0)
})
test('sorts by actual timestamps or wrong attempts without mutating the input', () => {
  const data = Object.freeze([item('b'), item('a', { latest_attempt_at: '2026-10-01T00:00:00Z', wrong_attempts: 7 }), item('c', { latest_attempt_at: null }), item('d', { latest_attempt_at: 'bad' })])
  const ids = order => selectReviewItems(data, '', order).map(value => value.lesson_id)
  assert.deepEqual(ids('recent'), ['b', 'a', 'c', 'd'])
  assert.deepEqual(ids('oldest'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(ids('frequent'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(data.map(value => value.lesson_id), ['b', 'a', 'c', 'd'])
  assert.deepEqual(selectReviewItems([item('b'), item('a')], '', 'recent').map(value => value.lesson_id), ['a', 'b'])
})
test('dates use Shanghai calendar days and label attempts rather than invented review events', () => {
  assert.equal(reviewAttemptLabel('2026-10-14T18:00:00Z'), '最近作答 2026/10/15')
  for (const value of [null, '', 'bad']) assert.equal(reviewAttemptLabel(value), '最近作答时间待同步')
})
test('changed content, hints and attempt versions reset disclosure identity', () => {
  const data = item('a')
  assert.equal(reviewContentKey(data), reviewContentKey({ ...data }))
  for (const patch of [{ review_hint: '新提示' }, { passage: '新原句' }, { wrong_attempts: 3 }, { latest_attempt_at: null }]) assert.notEqual(reviewContentKey(data), reviewContentKey({ ...data, ...patch }))
})
