import type { TrainingSession } from '../types'
import { trainingNextStep, type TrainingDestination } from '../trainingWayfinding'
import './trainingWayfinding.css'

export function TrainingWayfinding({ session, answer, dirty, busy, recoveryNeeded, onLocate }: {
  session: TrainingSession; answer: string | null; dirty: boolean; busy: boolean; recoveryNeeded: boolean
  onLocate: (target: TrainingDestination) => void
}) {
  const step = trainingNextStep(session, answer, dirty, busy, recoveryNeeded)
  if (!step) return null
  return <section className="training-wayfinding" aria-labelledby="training-next-title" data-mode={step.mode}>
    <div><p className="eyebrow">{session.stage === 'CORE' ? '当前：原文推理' : '当前：陌生文迁移'} · 下一步怎么做</p><h2 id="training-next-title">{step.title}</h2><p>{step.detail}</p></div>
    <div className="training-wayfinding-actions"><button type="button" className="button button-primary" onClick={() => onLocate(step.target)}>{step.label}<span aria-hidden="true"> ↓</span></button><button type="button" className="text-button" onClick={() => onLocate('fulltext-title')}>回原文找线索</button></div>
    <ol aria-label="一轮训练的操作路线"><li>看题，选择词义</li><li>读原文，保存证据与理由</li><li>提交判断，再去迁移或总结</li></ol>
  </section>
}
