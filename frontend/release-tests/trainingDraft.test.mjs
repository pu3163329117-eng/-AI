import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { importSource } from './import-source.mjs'
const { trainingDraftIsDirty } = await importSource('trainingDraft.ts')
test('an unsubmitted radio choice is protected independently from reasoning edits', () => {
  assert.equal(trainingDraftIsDirty(null, null, false, false), false)
  assert.equal(trainingDraftIsDirty('跟从求教', null, false, false), true)
  assert.equal(trainingDraftIsDirty('跟从求教', '来自', false, false), true)
  assert.equal(trainingDraftIsDirty('来自', '来自', false, false), false)
  assert.equal(trainingDraftIsDirty('来自', '来自', true, false), true)
  assert.equal(trainingDraftIsDirty('来自', '来自', true, true), false)
})
test('training combines option and reasoning drafts while unified submission preserves the save prerequisite internally', async () => {
  const app = await readFile(new URL('../src/components/GuidedTrainingPage.tsx', import.meta.url), 'utf8')
  assert.match(app, /onDirtyChange\(trainingDraftIsDirty\(answer, persistedAnswer, reasoningDirty, session.completed\)\)/)
  assert.match(app, /onSubmitDraft=\{submitAndContinue\}/)
  assert.match(app, /ready && reasoningDirty/)
  assert.doesNotMatch(app, /依据已保存，去核对|读好了，开始判断/)
  const chain = await readFile(new URL('../src/guidedSubmission.ts', import.meta.url), 'utf8')
  assert.ok(chain.indexOf("send('SAVE_REASONING', payload)") < chain.indexOf("send('SUBMIT_ATTEMPT', { answer })"))
  assert.match(chain, /if \(!draftMatchesSavedGraph\(confirmed, payload\)\) return stop\('stale', 'SAVE_REASONING'\)/)
  assert.doesNotMatch(app, /setReasoningDirty\(dirty\); onDirtyChange\(dirty\)/)
})
