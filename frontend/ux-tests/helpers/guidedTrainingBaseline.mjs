import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { restoreBeforeUxTrainingApp } from './uxTrainingResetBaseline.mjs'
const original = readFileSync(new URL('../fixtures/guidedTraining.baseline.txt', import.meta.url), 'utf8')
if (createHash('sha256').update(original).digest('hex') !== '55f435f208c6f9047101dfeb04694dcb67084ef638bc14ea9325db8b51eea8f4') throw Error('Guided original training fixture changed')
export const guidedImport = "import { GuidedTrainingPage, type GuidedTrainingProps } from './components/GuidedTrainingPage'\n"
export const guidedWrapper = `function TrainingPage(props: Omit<GuidedTrainingProps, 'renderSummary'>) {
  return <GuidedTrainingPage {...props} renderSummary={summary => <LessonSummary summary={summary} onReturnHome={props.onReturnHome} />} />
}

`
function undo(source, added, before = '') {
  if (source.split(added).length !== 2) throw Error('Guided exact allowlist changed')
  return source.replace(added, before)
}
export function restoreBeforeGuidedTrainingApp(source) {
  source = restoreBeforeUxTrainingApp(source)
  source = undo(source, guidedImport)
  return undo(source, guidedWrapper, original + '\n')
}
export function restoreBeforeGuidedTrainingMain(source) { return undo(source, "import './guidedStudy.css'\n") }
