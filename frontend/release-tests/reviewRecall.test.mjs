import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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
test('timezone-naive backend ISO timestamps are UTC even on a Shanghai phone', () => {
  const previous = process.env.TZ
  process.env.TZ = 'Asia/Shanghai'
  try {
    for (const value of ['2026-10-17T19:55:00', '2026-10-17T19:55:00.123456', '2026-10-17T19:55:00Z', '2026-10-18T03:55:00+08:00']) {
      assert.equal(reviewAttemptLabel(value), '最近作答 2026/10/18')
    }
    assert.equal(reviewAttemptLabel('2026-10-17'), '最近作答 2026/10/17')
    for (const value of ['2026-99-17T19:55:00', '2026-10-17T25:55:00', 'not a date']) assert.equal(reviewAttemptLabel(value), '最近作答时间待同步')
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

test('review order compares UTC-naive, Z and explicit-offset timestamps as real instants', () => {
  const previous = process.env.TZ
  process.env.TZ = 'Asia/Shanghai'
  try {
    const data = [
      item('b', { latest_attempt_at: '2026-10-17T19:55:00' }),
      item('a', { latest_attempt_at: '2026-10-18T03:55:00+08:00' }),
      item('newer', { latest_attempt_at: '2026-10-17T19:56:00Z' }),
      item('older', { latest_attempt_at: '2026-10-17T19:54:00Z' }),
      item('invalid', { latest_attempt_at: 'bad' }),
    ]
    assert.deepEqual(selectReviewItems(data, '', 'recent').map(value => value.lesson_id), ['newer', 'a', 'b', 'older', 'invalid'])
    assert.deepEqual(selectReviewItems(data, '', 'oldest').map(value => value.lesson_id), ['older', 'a', 'b', 'newer', 'invalid'])
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})
test('changed content, hints and attempt versions reset disclosure identity', () => {
  const data = item('a')
  assert.equal(reviewContentKey(data), reviewContentKey({ ...data }))
  for (const patch of [{ review_hint: '新提示' }, { passage: '新原句' }, { wrong_attempts: 3 }, { latest_attempt_at: null }]) assert.notEqual(reviewContentKey(data), reviewContentKey({ ...data, ...patch }))
})

test('review search and ordering fields use a phone-safe text size', async () => {
  const css = await readFile(new URL('../src/components/reviewRecall.css', import.meta.url), 'utf8')
  const fields = css.match(/\.recall-toolbar input, \.recall-toolbar select \{([^}]+)\}/)?.[1]
  assert.ok(fields)
  assert.match(fields, /font-size: 16px;/)
  assert.match(fields, /min-height: 48px;/)
})
