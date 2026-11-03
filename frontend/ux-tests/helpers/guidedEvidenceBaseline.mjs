// Historical presentation-only assertions do not describe this approved behavior change.
// Restore only an exact, independently reviewed candidate to its pinned public predecessor.
// Changed bytes fail closed; new behavior is exercised by optional/guided tests and HTTP QA.
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {restoreBeforeUxTrainingEditor} from './uxTrainingResetBaseline.mjs'
const map={
  "contracts.ts": [
    "ba53a8acf0b71636402971d4b63a9200dd0c8d1e81555325617bef3a46e2293a",
    "26fc40ddc201077c2efd8f339fd1b7187d0c84130d885b15c48bb8c48cb785b3"
  ],
  "components/ReasoningEditor.tsx": [
    "d829dc4f17e3c0d96abdabccb79913647a78aa4ec25720253c8c148b2be8f2c6",
    "763f5c6ca6d0466db992725d02d54e2e7c70337cb62fec294e51f671b3f8a19e"
  ],
  "components/ContextReader.tsx": [
    "8501ef20672239c9cd7f8275f15dfbffce8cc5d2dec4036efc85d96724b5f16d",
    "4a95016bc9a36706198c71f306156a936f00689e0aa61237ed2575b220cefb76"
  ],
  "components/ReasonFeedback.tsx": [
    "21afb1b1b746c14e39fd9456019cba2acaba7f966fcadfc320db1f036710506b",
    "43f5e03d17be3a0bd1ab83faf2f2859929af0a4df1b4d1e4b17b76db3b19a01b"
  ],
  "observations.ts": [
    "a904a5530ded27f469a276f5d72434765c1f2eb21d352bf4e5b19f75987aa090",
    "e5fa4c849b621cfe4143a2e054b30723f8341852efb22241af7693e9b298b9dd"
  ]
}
const hash=s=>createHash('sha256').update(s).digest('hex')
export function restoreGuidedEvidence(path, source) {
  if(path==='components/ReasoningEditor.tsx') source=restoreBeforeUxTrainingEditor(source)
  if(!map[path]) return source
  const [after,before]=map[path]
  if(hash(source)!==after) throw Error('Guided evidence reviewed source changed: '+path)
  const original=readFileSync(new URL('../fixtures/guided-before-'+path.replaceAll('/','-')+'.txt',import.meta.url),'utf8')
  if(hash(original)!==before)throw Error('Guided original source changed: '+path)
  return original
}
