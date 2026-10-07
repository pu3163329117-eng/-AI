import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/navigation.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } })
const { readRoute, routeHash, optionIndex, jumpTo, pageLabels } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)

test('all ordinary pages round-trip to distinct bookmarks', () => {
  for (const page of Object.keys(pageLabels).filter(page => page !== 'training')) {
    assert.deepEqual(readRoute(routeHash({ page })), { page })
  }
})
test('training bookmarks bind the exact session UUID', () => {
  const route = { page: 'training', sessionId: '01234567-89ab-cdef-0123-456789abcdef' }
  assert.deepEqual(readRoute(routeHash(route)), route)
})
test('assessment is a distinct restorable page without a training UUID', () => {
  assert.deepEqual(readRoute('#/assessment'), { page: 'assessment' })
  assert.equal(pageLabels.assessment, '能力试测')
  assert.equal(routeHash({ page: 'assessment' }), '#/assessment')
})
test('missing or malformed training identifiers safely lead to review', () => {
  for (const hash of ['#/training', '#/training/no-such-id', '#/training/%2F']) assert.deepEqual(readRoute(hash), { page: 'review' })
  assert.equal(routeHash({ page: 'training' }), '#/review')
})
test('unknown and unexpected path shapes safely lead home', () => {
  for (const hash of ['', '#/unknown', '#/home/extra', '#/training/a/b', 'https://example.com', '#/home?unsafe']) assert.deepEqual(readRoute(hash), { page: 'home' })
})
test('tab arrows wrap and Home / End select the endpoints', () => {
  assert.equal(optionIndex('ArrowRight', 2, 3), 0)
  assert.equal(optionIndex('ArrowLeft', 0, 3), 2)
  assert.equal(optionIndex('ArrowDown', 0, 3), 1)
  assert.equal(optionIndex('ArrowUp', 2, 3), 1)
  assert.equal(optionIndex('Home', 2, 3), 0)
  assert.equal(optionIndex('End', 0, 3), 2)
  assert.equal(optionIndex('Enter', 0, 3), null)
  assert.equal(optionIndex('Home', 0, 0), null)
})
test('reading shortcuts focus their target and respect reduced motion', () => {
  let reduced = false
  const calls = []
  globalThis.window = { matchMedia: () => ({ matches: reduced }) }
  globalThis.document = { getElementById: id => id === 'reader' ? { scrollIntoView: options => calls.push(options), focus: options => calls.push(options) } : null }
  try {
    jumpTo('reader'); reduced = true; jumpTo('reader'); jumpTo('absent')
    assert.deepEqual(calls, [{ behavior: 'smooth', block: 'start' }, { preventScroll: true }, { behavior: 'auto', block: 'start' }, { preventScroll: true }])
  } finally { delete globalThis.window; delete globalThis.document }
})
