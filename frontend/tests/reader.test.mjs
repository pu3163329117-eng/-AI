import test from 'node:test'
import assert from 'node:assert/strict'
import { importSource } from './import-source.mjs'
const { tokensFor, sentenceAt, readingIndex } = await importSource('reader.ts')

test('longest words win without losing punctuation or text', () => {
  const text = '君子曰：学不可以已。'
  const tokens = tokensFor(text, ['君', '君子', '可以', '', '君子'], false)
  assert.equal(tokens[0].token, '君子')
  assert.equal(tokens.map(item => item.token + item.suffix).join(''), text)
})
test('positions are Unicode codepoints, not UTF-16 offsets', () => {
  const tokens = tokensFor('𠮷者，君子。', ['君子'], false)
  assert.deepEqual(tokens.map(({ token, start, end }) => ({ token, start, end })), [{ token: '𠮷', start: 0, end: 1 }, { token: '者', start: 1, end: 2 }, { token: '君子', start: 3, end: 5 }])
})
test('range mode exposes each character while retaining source positions', () => {
  const tokens = tokensFor('君子曰。', ['君子'], true)
  assert.deepEqual(tokens.map(item => item.start), [0, 1, 2])
  assert.deepEqual(tokens.map(item => item.token), ['君', '子', '曰'])
})
test('sentence expansion preserves semicolon context', () => {
  assert.equal(sentenceAt('前句。青，取之于蓝；冰，水为之。后句。', 8, 9), '青，取之于蓝；冰，水为之。')
})
test('roving focus moves within and between paragraphs without wrap surprises', () => {
  const targets = [{ paragraph: 0, start: 0 }, { paragraph: 0, start: 5 }, { paragraph: 2, start: 0 }, { paragraph: 2, start: 4 }]
  assert.equal(readingIndex('ArrowLeft', 0, targets), 0)
  assert.equal(readingIndex('ArrowRight', 3, targets), 3)
  assert.equal(readingIndex('Home', 1, targets), 0)
  assert.equal(readingIndex('End', 2, targets), 3)
  assert.equal(readingIndex('ArrowDown', 1, targets), 3)
  assert.equal(readingIndex('ArrowUp', 3, targets), 1)
  assert.equal(readingIndex('Enter', 1, targets), null)
  assert.equal(readingIndex('ArrowDown', 0, []), null)
})
