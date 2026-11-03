import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { restoreBeforeUxTrainingApp, restoreBeforeUxTrainingEditor } from './helpers/uxTrainingResetBaseline.mjs'
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const hash = source => createHash('sha256').update(source).digest('hex')
const app = read('../src/App.tsx'), editor = read('../src/components/ReasoningEditor.tsx')
const delta = JSON.parse(read('./fixtures/uxTrainingReset.baseline.json'))

test('exact UX App reversal preserves the captured complete original hash', () => {
  assert.equal(hash(restoreBeforeUxTrainingApp(app)), '63e8c7ab927fe7277b47aa87a3984239f4177b0cbea2408969da4d40a579c87c')
})
test('changed or duplicated approved App command edits fail closed', () => {
  const after = delta.appEdits.at(-1).after
  const middle = Math.floor(after.length / 2)
  assert.throws(() => restoreBeforeUxTrainingApp(app.replace(after, after.slice(0, middle)+'/* altered */'+after.slice(middle))))
  assert.throws(() => restoreBeforeUxTrainingApp(app+'\n'+after))
})
test('unrelated App changes survive reversal and cannot be hidden by the UX fixture', () => {
  const changed = app.replace('function OnboardingPage', 'function AlteredOnboardingPage')
  assert.notEqual(changed, app)
  const restored = restoreBeforeUxTrainingApp(changed)
  assert.match(restored, /function AlteredOnboardingPage/)
  assert.notEqual(hash(restored), '63e8c7ab927fe7277b47aa87a3984239f4177b0cbea2408969da4d40a579c87c')
})
test('only the exact new editor can restore the original optional-reason editor', () => {
  assert.equal(hash(restoreBeforeUxTrainingEditor(editor)), 'd829dc4f17e3c0d96abdabccb79913647a78aa4ec25720253c8c148b2be8f2c6')
  assert.throws(() => restoreBeforeUxTrainingEditor(editor+'\n// altered'))
})
