import type { TrainingSession } from './types'

export type TrainingDestination = 'training-question' | 'reasoning-title' | 'fulltext-title' | 'training-feedback' | 'command-recovery-title' | 'training-tools'
export type TrainingNextStep = { title: string; detail: string; label: string; target: TrainingDestination; mode: 'question' | 'reasoning' | 'continue' | 'recover' | 'waiting' | 'deferred' }

/** UI orientation only: never chooses an answer, submits, scores or infers truth. */
export function trainingNextStep(session: TrainingSession, answer: string | null, dirty: boolean, busy: boolean, recoveryNeeded: boolean): TrainingNextStep | null {
  if (session.completed) return null
  if (recoveryNeeded) return { title: '先核对上次操作', detail: '上次结果还未确认。不要重复提交，先到核对区确认当前进度。', label: '查看待核对操作', target: 'command-recovery-title', mode: 'recover' }
  if (busy) return { title: '正在保存当前操作', detail: '请稍候，确认结果后再继续。不会自动帮你答题或跳过步骤。', label: '查看操作状态', target: 'training-feedback', mode: 'waiting' }
  if (dirty) return { title: '先处理尚未保存的理由', detail: '你刚修改了证据或理由。先到理由区检查并保存，再考虑继续迁移或总结；此处不会替你保存或丢弃草稿。', label: '回到理由草稿', target: 'reasoning-title', mode: 'reasoning' }
  if (session.transfer_ready || session.summary_ready) return { title: session.transfer_ready ? '继续下一段训练' : '查看本次训练总结', detail: session.transfer_ready ? '当前阶段已达到规则要求。到判断反馈下方，点击“进入陌生文挑战”。' : '到判断反馈下方，点击“查看本关总结”，由服务保存完成记录。', label: session.transfer_ready ? '去进入陌生文挑战' : '去查看本关总结', target: 'training-feedback', mode: 'continue' }
  if (session.deferred) return { title: '先读上下文，再回看这个字', detail: '你已暂放这个字。读完原文后，在“提示与暂放”里点“回看这个字，继续判断”。', label: '找到回看入口', target: 'training-tools', mode: 'deferred' }
  if (!answer) return { title: '先看题目，选一个词义', detail: '正文可以点读，但点字不等于作答。请到题目区选择一个选项；需要时再回原文找线索。', label: '去看题目与选项', target: 'training-question', mode: 'question' }
  const first = session.learning_trace?.stages[session.stage]?.first_attempt === null
  if (first && !dirty) return { title: '可以先提交首次判断', detail: '你已选好词义。到题目区点击“提交首次词义判断”；也可以先整理证据与理由，提交由你决定。', label: '找到首次判断按钮', target: 'training-question', mode: 'question' }
  if (dirty || !session.reasoning_graph || session.reasoning_graph.conclusion !== answer) return { title: '接着找依据，保存词义结论', detail: '明确选择原文上下文或本句注释作为依据，再保存词义结论。手写理由选填，可以展开补充；点读不会自动保存依据。', label: '去整理依据与可选理由', target: 'reasoning-title', mode: 'reasoning' }
  return { title: '证据已保存，再提交判断', detail: '到题目区点击“提交判断”，再看规则反馈。保存理由不等于推理已被审核，也不会直接完成训练。', label: '找到提交判断按钮', target: 'training-question', mode: 'question' }
}
