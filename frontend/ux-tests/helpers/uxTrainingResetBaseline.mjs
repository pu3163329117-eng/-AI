// Historical assertions retain their original hashes. Reverse only the exact
// approved UX delta; unrelated handler changes survive and fail the old guard.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const hash = text => createHash('sha256').update(text).digest('hex')
const raw = readFileSync(new URL('../fixtures/uxTrainingReset.baseline.json', import.meta.url), 'utf8')
if (hash(raw) !== 'ead03f0779b0de45a7dffc45f468a44c0a2226b4010758a07cec9cc6f4785df9') throw Error('UX original delta fixture changed')
const delta = JSON.parse(raw)

export function restoreBeforeUxTrainingApp(source) {
  for (const { before, after } of [...delta.appEdits].reverse()) {
    if (!after || source.split(after).length !== 2) throw Error('UX exact App allowlist changed')
    source = source.replace(after, before)
  }
  return source
}

export function restoreBeforeUxTrainingEditor(source) {
  if (hash(source) !== delta.editor.after_sha256 || hash(delta.editor.before) !== delta.editor.before_sha256) throw Error('UX approved editor source changed')
  return delta.editor.before
}
