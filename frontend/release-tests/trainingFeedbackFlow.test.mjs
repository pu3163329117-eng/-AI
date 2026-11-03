import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

// UX reset removes the unsafe pending-cleared judgment effect. Run the actual
// explicit-outcome focus and stage-reset effects; no API, account or DB is loaded.
const source = await readFile(new URL('../src/components/GuidedTrainingPage.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('GuidedTrainingPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const page = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'GuidedTrainingBody')
const effects = page.body.statements.filter(n => ts.isExpressionStatement(n) && n.expression.expression?.getText(ast) === 'useEffect')
const focusEffect = effects.find(n => n.getText(ast).includes('if (!submissionMessage'))
const stageEffect = effects.find(n => n.getText(ast).includes('lastStage.current.stage'))
assert.ok(focusEffect); assert.ok(stageEffect)
const focusNames = 'submissionMessage, recoveryNeeded, unknownVersion, requestAnimationFrame, cancelAnimationFrame, jumpTo'
const stageNames = 'lastStage, session, setAnnotationSelection, setContextBasisSelection, setReaderOpen, setReasoningDirty, setSubmissionMessage, setSubmissionStep, setUnknownVersion, setStep, initialUnifiedTrainingStep, requestAnimationFrame, cancelAnimationFrame, jumpTo'
const compile = (name, names, effect) => `export function ${name}(context) { const { ${names} } = context; let cleanup; const useEffect = run => { cleanup = run() }; ${effect.getText(ast)}; return cleanup }`
const compiled = ts.transpileModule(compile('focus', focusNames, focusEffect) + compile('stage', stageNames, stageEffect), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const transitions = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
function fixture() {
  const jumps = [], frames = new Map(); let nextFrame = 1, focusKey, stageKey, focusCleanup, stageCleanup
  const context = {
    submissionMessage: '', recoveryNeeded: false, unknownVersion: null,
    session: { stage: 'CORE', completed: false }, lastStage: { current: { stage: 'CORE', completed: false } },
    setAnnotationSelection() {}, setContextBasisSelection() {}, setReaderOpen() {}, setReasoningDirty() {}, setSubmissionStep() {}, setStep() {},
    setSubmissionMessage(value) { context.submissionMessage = value }, setUnknownVersion(value) { context.unknownVersion = value },
    initialUnifiedTrainingStep: () => 'CHOOSE', jumpTo: id => jumps.push(id),
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id }, cancelAnimationFrame: id => frames.delete(id),
  }
  return { context, jumps, update() {
    const nextStage = JSON.stringify([context.session.stage, context.session.completed])
    if (nextStage !== stageKey) { stageCleanup?.(); stageKey = nextStage; stageCleanup = transitions.stage(context) }
    const nextFocus = JSON.stringify([context.submissionMessage, context.recoveryNeeded, context.unknownVersion])
    if (nextFocus !== focusKey) { focusCleanup?.(); focusKey = nextFocus; focusCleanup = transitions.focus(context) }
  }, paint() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()) }, dispose() { focusCleanup?.(); stageCleanup?.() } }
}
test('a confirmed nonpassing judgment reveals feedback once; empty pending state is not success', () => {
  const e = fixture(); e.update(); e.paint(); assert.deepEqual(e.jumps, [])
  e.context.submissionMessage = '本题暂未通过，请查看反馈'; e.update(); e.paint(); assert.deepEqual(e.jumps, ['training-feedback'])
  e.update(); e.paint(); assert.equal(e.jumps.length, 1)
  assert.doesNotMatch(source, /lastJudgment\.current/)
})
test('point-reading, assistance, evidence saves and ordinary rerenders never interrupt reader scroll', () => {
  for (const pending of ['REQUEST_MORE_CONTEXT', 'SELECT_EVIDENCE', 'SAVE_REASONING', 'RECORD_ASSISTANCE']) {
    const e = fixture(); e.context.pendingCommand = pending; e.update(); e.context.pendingCommand = null; e.update(); e.paint(); assert.deepEqual(e.jumps, [])
  }
})
test('unknown outcomes and original recovery retain priority over generic result focus', () => {
  for (const patch of [{ recoveryNeeded: true }, { unknownVersion: 2 }]) {
    const e = fixture(); e.context.submissionMessage = '核验尚未确认'; Object.assign(e.context, patch); e.update(); e.paint(); assert.deepEqual(e.jumps, [])
  }
  const e = fixture(); e.context.submissionMessage = '待显示'; e.update(); e.context.recoveryNeeded = true; e.update(); e.paint(); assert.deepEqual(e.jumps, [], 'a queued focus is cancelled when recovery takes over')
})
test('stage and completed summary changes cancel old feedback and keep their own focus target', () => {
  for (const [patch, target] of [[{ stage: 'TRANSFER' }, 'guided-task-title'], [{ completed: true }, 'summary-title']]) {
    const e = fixture(); e.context.submissionMessage = '旧题反馈'; e.update(); Object.assign(e.context.session, patch); e.update(); e.paint()
    assert.deepEqual(e.jumps, [target]); assert.equal(e.context.submissionMessage, '')
  }
})
test('unmount cancels a queued confirmed-result scroll', () => {
  const e = fixture(); e.context.submissionMessage = '本题暂未通过'; e.update(); e.dispose(); e.paint(); assert.deepEqual(e.jumps, [])
})
test('judgment and summary anchors reserve space below sticky navigation', async () => {
  const css = await readFile(new URL('../src/functionalPages.css', import.meta.url), 'utf8')
  assert.match(css, /:is\(#training-feedback, #summary-title\)\s*\{\s*scroll-margin-top:\s*135px;/)
})
