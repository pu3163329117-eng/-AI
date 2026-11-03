import { assistanceLabels, assistanceStatusLabels, observationStageLabels } from '../observations'
import type { LearningTrace, ObservationStage } from '../observations'
import '../observations.css'

export function SessionObservations({ trace, currentStage, completed }: { trace?: LearningTrace | null; currentStage: ObservationStage; completed: boolean }) {
  return <section className="observations session-observations" aria-labelledby="session-observations-title">
    <header><p className="eyebrow">学习行为记录</p><h2 id="session-observations-title">先看首次判断，再看后续完成。</h2></header>
    {trace ? <>
      <div className="observation-stage-records">{(['CORE', 'TRANSFER'] as ObservationStage[]).map(stage => {
        const value = trace.stages[stage]; const first = value.first_attempt
        return <article key={stage} aria-current={!completed && stage === currentStage ? 'step' : undefined}>
          <h3>{observationStageLabels[stage]}{!completed && stage === currentStage ? ' · 当前阶段' : ''}</h3>
          {first ? <>
            <p><b>{assistanceStatusLabels[first.assistance_status]}</b></p>
            <p>首次词义选择：“{first.answer}” · {first.correct ? '词义选项正确' : '词义选项尚未正确'}</p>
          </> : <p>首次判断尚未提交，不预填正确率或辅助分类。</p>}
          <p>实际提交 {value.attempt_count} 次 · {value.validated ? '本阶段已完成规则核验' : '本阶段尚未完成规则核验'}</p>
          {value.validated && value.attempt_count > 1 && <p>后续重答完成，与首次表现分开保留。</p>}
          <details>
            <summary>查看本阶段记录依据</summary>
            {first && <>
              <p>首次预设证据覆盖：{first.evidence_rule_matched ? '已覆盖' : '未覆盖'}；不代表开放理由已通过语义审核。</p>
              {first.assistance_kinds.length > 0 && <p>首次判断前记录：{first.assistance_kinds.map(kind => assistanceLabels[kind]).join('、')}</p>}
              <p className="observation-note">{first.source} · 原文版本 {first.text_version} · {first.reason_review_status === 'NOT_PROVIDED' ? '理由未补充（选填），不评价开放表达' : '开放理由待复核'}</p>
            </>}
            <p className="observation-note">本阶段已记录的全部辅助：{value.assistance_kinds.length > 0 ? value.assistance_kinds.map(kind => assistanceLabels[kind]).join('、') : '尚无'}</p>
          </details>
        </article>
      })}</div>
      <p className="observation-note">未记录辅助不证明闭卷独立表现，本记录不替代正式能力评测。</p>
    </> : <p>这份旧训练没有新版首次判断与辅助字段。保留原记录为未知，不从最终答对倒推出首次独立表现。</p>}
  </section>
}
