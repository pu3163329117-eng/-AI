import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { restoreBeforeUxTrainingApp, restoreBeforeUxTrainingEditor } from './helpers/uxTrainingResetBaseline.mjs'
import { restoreBeforeGuidedTrainingApp, restoreBeforeGuidedTrainingMain } from './helpers/guidedTrainingBaseline.mjs'
import { restoreGuidedEvidence } from './helpers/guidedEvidenceBaseline.mjs'
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const sha = text => createHash('sha256').update(text).digest('hex')
const editorialUpdateApp = read('../src/App.tsx')
const editorialUpdateDelta = JSON.parse(read('./fixtures/editorialUpdate.delta.json'))
function undoEditorialUpdate(value) {
  for (const {before, after} of [...editorialUpdateDelta.edits].reverse()) {
    if (!after || value.split(after).length !== 2) throw Error('Editorial update exact fragment changed')
    value = value.replace(after, before)
  }
  return value
}
const trainingCreateApp = undoEditorialUpdate(editorialUpdateApp)
const trainingCreateDelta = JSON.parse(read('./fixtures/trainingCreate.delta.json'))
function undoTrainingCreate(value) {
  for (const {before, after} of [...trainingCreateDelta.edits].reverse()) {
    if (!after || value.split(after).length !== 2) throw Error('Training create exact fragment changed')
    value = value.replace(after, before)
  }
  return value
}
const trainingUnknownApp = undoTrainingCreate(trainingCreateApp)
const trainingDelta = JSON.parse(read('./fixtures/trainingUnknown.delta.json'))
function undoTrainingUnknown(value) {
  for (const {before, after} of [...trainingDelta.edits].reverse()) {
    if (!after || value.split(after).length !== 2) throw Error('Training unknown exact fragment changed')
    value = value.replace(after, before)
  }
  return value
}
const editorialApp = undoTrainingUnknown(trainingUnknownApp)
const editorialDelta = JSON.parse(read('./fixtures/editorial.delta.json'))
function undoEditorial(value) {
  if (value.replace(/\r\n/g, '').includes('\n') || value.replace(/\r\n/g, '').includes('\r')) throw Error('Editorial line endings changed')
  value = value.replace(/\r\n/g, '\n')
  for (const {before, after} of [...editorialDelta.edits].reverse()) {
    if (!after || value.split(after).length !== 2) throw Error('Editorial exact fragment changed')
    value = value.replace(after, before)
  }
  return value
}
const recoveryApp = undoEditorial(editorialApp)
const recoveryDelta = JSON.parse(read('./fixtures/sessionRecovery.delta.json'))
function undoRecovery(value) {
  for (const {before, after} of [...recoveryDelta.edits].reverse()) {
    if (!after || value.split(after).length !== 2) throw Error('Session recovery exact fragment changed')
    value = value.replace(after, before)
  }
  return value
}
const app = undoRecovery(recoveryApp)
const delta = JSON.parse(read('./fixtures/dual-access.delta.json'))
const expectedOriginalR3 = '36421675c4287db51ec85879c28df39de8a6149d7dac2d26518d4a7db9fe56c2'
const expectedDual = 'ffdeb7099707c4627951366b22e8c3986b27d2e6c5d934d8a78588e23b1c7d92'
const expectedDeployed = '7c779e1ac5c1288df8140b8e099c1e65c8c044fb18c439533215f344669bc3fe'
function undoDual(value) {
  for (const {before, after} of [...delta.edits].reverse()) {
    if (!after || value.split(after).length !== 2) throw Error('Dual access exact fragment changed')
    value = value.replace(after,before)
  }
  return value
}
test('dual and UX exact reversals bind to original r3 and deployed baseline', () => {
  assert.equal(delta.original_r3_sha256,expectedOriginalR3); assert.equal(delta.dual_access_sha256,expectedDual)
  assert.equal(sha(app),expectedDual); const r3=undoDual(app); assert.equal(sha(r3),expectedOriginalR3)
  assert.equal(sha(restoreBeforeUxTrainingApp(r3)),expectedDeployed)
})
test('changed and duplicated dual fragments cannot be hidden', () => {
  const after=delta.edits[0].after; const altered=app.replace(after, after.slice(0,20)+'/* altered */'+after.slice(20))
  assert.notEqual(altered,app); assert.throws(()=>undoDual(altered)); assert.throws(()=>undoDual(app+after))
})
test('unrelated App mutations survive both reversal stages', () => {
  const changed=app.replace('function OnboardingPage','function MutatedOnboardingPage'); assert.notEqual(changed,app)
  const restored=restoreBeforeUxTrainingApp(undoDual(changed)); assert.match(restored,/function MutatedOnboardingPage/); assert.notEqual(sha(restored),expectedDeployed)
})
test('changed and duplicated UX fragments cannot be hidden', () => {
  const r3=undoDual(app); const changed=r3.replace('function OnboardingPage','function MutatedOnboardingPage'); assert.notEqual(sha(restoreBeforeUxTrainingApp(changed)),expectedDeployed)
  const ux=JSON.parse(read('./fixtures/uxTrainingReset.baseline.json')); const after=ux.appEdits.at(-1).after; const middle=Math.floor(after.length/2); const altered=r3.replace(after,after.slice(0,middle)+'/* altered */'+after.slice(middle)); assert.notEqual(altered,r3); assert.throws(()=>restoreBeforeUxTrainingApp(altered)); assert.throws(()=>restoreBeforeUxTrainingApp(r3+after))
})
test('only the exact approved editor restores its original optional-reason baseline', () => {
  const editor=read('../src/components/ReasoningEditor.tsx'); assert.equal(sha(restoreBeforeUxTrainingEditor(editor)),'d829dc4f17e3c0d96abdabccb79913647a78aa4ec25720253c8c148b2be8f2c6'); assert.throws(()=>restoreBeforeUxTrainingEditor(editor+'\n// altered'))
})

test('session recovery delta binds to the dual baseline and rejects altered, duplicated and unrelated changes', () => {
  assert.equal(recoveryDelta.baseline_sha256, expectedDual)
  assert.equal(sha(recoveryApp), recoveryDelta.session_recovery_sha256)
  assert.equal(sha(app), expectedDual)
  const after = recoveryDelta.edits[0].after
  const altered = recoveryApp.replace(after, after.slice(0,20) + '/* altered */' + after.slice(20))
  assert.notEqual(altered, recoveryApp); assert.throws(() => undoRecovery(altered)); assert.throws(() => undoRecovery(recoveryApp + after))
  const unrelated = recoveryApp.replace('function OnboardingPage', 'function MutatedOnboardingPage')
  assert.notEqual(unrelated, recoveryApp); assert.notEqual(sha(undoRecovery(unrelated)), expectedDual)
})

test('editorial stage binds to the exact session recovery version and rejects tampering', () => {
  assert.equal(editorialDelta.session_sha256, 'c2b98ae7f82ee53ecc27d075c036f2eadafd2e71e4af233ec4d0a1928d323218')
  assert.equal(editorialDelta.editorial_sha256, 'c85d682caac9bd2d077758750f1d15c996f1c6306d80b0f95c6f996a13afa1a6')
  assert.equal(sha(editorialApp), editorialDelta.editorial_sha256); assert.equal(sha(recoveryApp), editorialDelta.session_sha256)
  const after=editorialDelta.edits[0].after.replace(/\n/g, '\r\n'), at=Math.floor(after.length/2)
  const altered=editorialApp.replace(after,after.slice(0,at)+'/* altered */'+after.slice(at))
  assert.notEqual(altered,editorialApp); assert.throws(()=>undoEditorial(altered)); assert.throws(()=>undoEditorial(editorialApp+after))
  const unrelated=editorialApp.replace('function OnboardingPage','function MutatedOnboardingPage')
  assert.notEqual(unrelated,editorialApp); assert.notEqual(sha(undoEditorial(unrelated)),editorialDelta.session_sha256)
})

test('training unknown stage binds to exact editorial App and rejects tampering', () => {
  assert.equal(trainingDelta.editorial_sha256, 'c85d682caac9bd2d077758750f1d15c996f1c6306d80b0f95c6f996a13afa1a6')
  assert.equal(trainingDelta.training_unknown_sha256, 'dff13f23bc5f49e24d4e363aedb1e217a8961ffd6dcdd060d14e967e7ad63b5c')
  assert.equal(sha(trainingUnknownApp), trainingDelta.training_unknown_sha256)
  assert.equal(sha(editorialApp), trainingDelta.editorial_sha256)
  const after=trainingDelta.edits[0].after, at=Math.floor(after.length/2)
  const altered=trainingUnknownApp.replace(after,after.slice(0,at)+'/* altered */'+after.slice(at))
  assert.notEqual(altered,trainingUnknownApp); assert.throws(()=>undoTrainingUnknown(altered)); assert.throws(()=>undoTrainingUnknown(trainingUnknownApp+after))
  const unrelated=trainingUnknownApp.replace('function OnboardingPage','function MutatedOnboardingPage')
  assert.notEqual(unrelated,trainingUnknownApp); assert.notEqual(sha(undoTrainingUnknown(unrelated)),trainingDelta.editorial_sha256)
})

test('training create stage binds to exact prior App and rejects tampering', () => {
  assert.equal(trainingCreateDelta.prior_sha256, 'dff13f23bc5f49e24d4e363aedb1e217a8961ffd6dcdd060d14e967e7ad63b5c')
  assert.equal(trainingCreateDelta.training_create_sha256, '7dbc0b36a5693fb843c6b803068a505b115daf78a132dcb2fb97fc48384040e1')
  assert.equal(sha(trainingCreateApp),trainingCreateDelta.training_create_sha256); assert.equal(sha(trainingUnknownApp),trainingCreateDelta.prior_sha256)
  const after=trainingCreateDelta.edits[0].after, at=Math.floor(after.length/2)
  const altered=trainingCreateApp.replace(after,after.slice(0,at)+'/* altered */'+after.slice(at))
  assert.notEqual(altered,trainingCreateApp); assert.throws(()=>undoTrainingCreate(altered)); assert.throws(()=>undoTrainingCreate(trainingCreateApp+after))
  const unrelated=trainingCreateApp.replace('function displayActivityDate','function MutatedActivityDate')
  assert.notEqual(unrelated,trainingCreateApp); assert.notEqual(sha(undoTrainingCreate(unrelated)),trainingCreateDelta.prior_sha256)
})

test('editorial update and exit-risk stage binds to prior App and rejects tampering', () => {
  assert.equal(editorialUpdateDelta.prior_sha256, '7dbc0b36a5693fb843c6b803068a505b115daf78a132dcb2fb97fc48384040e1')
  assert.equal(editorialUpdateDelta.editorial_update_sha256, 'b1fff1aba1b9f3fa701025528f26e445cb637e08bcbfd3ebc39fac536b9a7d43')
  assert.equal(sha(editorialUpdateApp),editorialUpdateDelta.editorial_update_sha256); assert.equal(sha(trainingCreateApp),editorialUpdateDelta.prior_sha256)
  const after=editorialUpdateDelta.edits[0].after, at=Math.floor(after.length/2)
  const altered=editorialUpdateApp.replace(after,after.slice(0,at)+'/* altered */'+after.slice(at))
  assert.notEqual(altered,editorialUpdateApp); assert.throws(()=>undoEditorialUpdate(altered)); assert.throws(()=>undoEditorialUpdate(editorialUpdateApp+after))
  const unrelated=editorialUpdateApp.replace('function displayActivityDate','function MutatedActivityDate')
  assert.notEqual(unrelated,editorialUpdateApp); assert.notEqual(sha(undoEditorialUpdate(unrelated)),editorialUpdateDelta.prior_sha256)
})

test('historical guided fixtures match their frozen digests and import successfully', () => {
  const fixtures = {
    'guidedTraining.baseline.txt':'55f435f208c6f9047101dfeb04694dcb67084ef638bc14ea9325db8b51eea8f4',
    'guided-before-contracts.ts.txt':'26fc40ddc201077c2efd8f339fd1b7187d0c84130d885b15c48bb8c48cb785b3',
    'guided-before-components-ReasoningEditor.tsx.txt':'763f5c6ca6d0466db992725d02d54e2e7c70337cb62fec294e51f671b3f8a19e',
    'guided-before-components-ContextReader.tsx.txt':'4a95016bc9a36706198c71f306156a936f00689e0aa61237ed2575b220cefb76',
    'guided-before-components-ReasonFeedback.tsx.txt':'43f5e03d17be3a0bd1ab83faf2f2859929af0a4df1b4d1e4b17b76db3b19a01b',
    'guided-before-observations.ts.txt':'e5fa4c849b621cfe4143a2e054b30723f8341852efb22241af7693e9b298b9dd',
  }
  for(const [file,digest] of Object.entries(fixtures)) assert.equal(sha(read('./fixtures/'+file)),digest,file)
})
test('guided evidence helpers restore only exact reviewed source and reject changed inputs', () => {
  for (const [path,digest] of [
    ['components/ReasoningEditor.tsx','763f5c6ca6d0466db992725d02d54e2e7c70337cb62fec294e51f671b3f8a19e'],
    ['components/ContextReader.tsx','4a95016bc9a36706198c71f306156a936f00689e0aa61237ed2575b220cefb76'],
    ['components/ReasonFeedback.tsx','43f5e03d17be3a0bd1ab83faf2f2859929af0a4df1b4d1e4b17b76db3b19a01b'],
    ['observations.ts','e5fa4c849b621cfe4143a2e054b30723f8341852efb22241af7693e9b298b9dd'],
  ]) { const source=read('../src/'+path); assert.equal(sha(restoreGuidedEvidence(path,source)),digest); assert.throws(()=>restoreGuidedEvidence(path,source+'\n// tampered')) }
  assert.throws(()=>restoreGuidedEvidence('contracts.ts',read('../src/contracts.ts')))
  assert.equal(restoreGuidedEvidence('unknown.ts','untouched'),'untouched')
})
test('guided training helper restores the pinned predecessor and rejects altered or duplicated fragments', () => {
  const r3=undoDual(app), restored=restoreBeforeGuidedTrainingApp(r3), original=read('./fixtures/guidedTraining.baseline.txt')
  assert.ok(restored.includes(original)); assert.ok(!restored.includes('import { GuidedTrainingPage, type GuidedTrainingProps }'))
  const changed=r3.replace('renderSummary={summary =>','renderSummary={other =>'); assert.notEqual(changed,r3); assert.throws(()=>restoreBeforeGuidedTrainingApp(changed))
  assert.equal(restoreBeforeGuidedTrainingMain("import './guidedStudy.css'\n"),'')
  assert.throws(()=>restoreBeforeGuidedTrainingMain("import './guidedStudy.css'\nimport './guidedStudy.css'\n"))
})
