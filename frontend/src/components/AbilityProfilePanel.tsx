import { useEffect, useState } from 'react'
import { learningPathApi } from '../learningPathApi'
import { pathDimensions, pathDimensionLabels, pathReasonLabel } from '../learningPath'
import type { LearnerAbility } from '../learningPath'
import { errorMessage } from '../http'
import '../learningPath.css'

function time(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN') }
export function AbilityProfilePanel({ profileId, onAssessment, onPractice }: { profileId: string | null; onAssessment?: () => void; onPractice?: () => void }) {
  const [ability, setAbility] = useState<LearnerAbility | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController(); setAbility(null); setError(''); setLoading(!!profileId)
    if (profileId) learningPathApi.ability(profileId, controller.signal).then(data => { if (!controller.signal.aborted) { setAbility(data); setLoading(false) } }).catch(reason => { if (!controller.signal.aborted) { setError(errorMessage(reason)); setLoading(false) } })
    return () => controller.abort()
  }, [profileId, retry])
  return <section className="learning-path ability-profile-panel" aria-labelledby="ability-profile-title"><header className="path-section-heading"><div><p className="eyebrow">能力依据 · 与关卡积分分别记录</p><h2 id="ability-profile-title">正式档案与试测参考，分别看。</h2></div>{onAssessment && <button className="button button-secondary" onClick={onAssessment}>进入能力试测</button>}</header>
    {loading ? <p role="status" aria-busy="true">正在读取能力来源与历史…</p> : error ? <div className="path-message" role="alert"><p>{error}</p><button className="button button-secondary" onClick={() => setRetry(value => value + 1)}>重新读取能力档案</button></div> : !profileId ? <p>建立学习档案后，可以保存试测结果；尚未测评不等于零能力。</p> : ability && <>
      <section className="path-formal-profile" aria-labelledby="path-formal-title"><h3 id="path-formal-title">正式评测档案：{ability.level_status === 'UNASSESSED' ? '待评估' : `${ability.level} · 试行建议`}</h3><p>{ability.explanation}</p><div className="path-dimension-list">{pathDimensions.map(dimension => { const item = ability.dimensions[dimension]; return <article key={dimension}><div><b>{pathDimensionLabels[dimension]}</b><span>{item.score === null ? '待评估' : `${item.score.toFixed(1)} 分`}</span></div>{item.score !== null && <meter min={0} max={100} value={item.score} aria-label={`${pathDimensionLabels[dimension]}正式参考分${item.score}`} />}<p>呈现 {item.presented_count} 题 · 有效作答 {item.answered_count} · 答对 {item.correct_count}{item.score === null && (item.presented_count ? ' · 样本尚不足以评估' : ' · 尚无合格能力观测')}</p></article> })}</div><p className="path-note">翻译与独立迁移尚无本轮合格测量，保持待评估；完成学习关卡不会自动填入这些分数。</p>{ability.assessed_at && <p className="path-note">正式结果时间 {time(ability.assessed_at)} · 题库 {ability.bank_version} · 评分 {ability.scoring_version}</p>}</section>
      <section className="path-pilot-reference" aria-labelledby="path-pilot-title"><p className="eyebrow">独立参考区域 · 不写入正式能力分</p><h3 id="path-pilot-title">最近一次能力试测</h3>{ability.latest_pilot ? <><p>规则参考分：<b>{ability.latest_pilot.result.overall_score === null ? '待评估' : `${ability.latest_pilot.result.overall_score.toFixed(1)} / 100`}</b> · 不定正式等级</p><p>{ability.latest_pilot.result.explanation}</p><ul className="path-pilot-dimensions">{pathDimensions.slice(0, 4).map(dimension => { const item = ability.latest_pilot!.result.dimensions[dimension as 'vocabulary' | 'syntax' | 'context' | 'chapter']; return <li key={dimension}><b>{pathDimensionLabels[dimension]}</b><span>{item.score === null ? '待评估' : `${item.score.toFixed(1)} 分`} · 作答 {item.answered_count} / {item.presented_count} · 跳过 {item.skipped_count}</span></li> })}</ul><p>评估充分度：{{ HIGH: '高', MEDIUM: '中', LOW: '低', INSUFFICIENT: '不足' }[ability.latest_pilot.result.sufficiency]}（覆盖规则，不是统计置信度）</p><ul>{ability.latest_pilot.result.sufficiency_reasons.map((reason, index) => <li key={index}>{pathReasonLabel(reason)}</li>)}</ul><p className="path-note">{time(ability.latest_pilot.completed_at)} · 题库 {ability.latest_pilot.bank_version} · 评分 {ability.latest_pilot.scoring_version}</p></> : <p>尚无已交卷的能力试测。你可以先练习，以后再测；不为缺失记录编造参考分。</p>}</section>
      <details className="path-ability-history"><summary>查看测评来源历史（{ability.history.length} 条）</summary>{ability.history.length ? <ol>{ability.history.map(record => <li key={record.assessment_id}><b>{record.mode === 'PILOT' ? '试测参考' : '正式评测'} · {record.eligible_for_ability ? '满足正式档案采用条件' : '未作为正式能力依据'}</b><p>{time(record.completed_at)} · {record.result.overall_score === null ? '待评估' : `规则参考分 ${record.result.overall_score.toFixed(1)}`}</p><p>题库 {record.bank_version} · 评分 {record.scoring_version}</p><p>{record.reason}</p></li>)}</ol> : <p>没有完成的测评记录。旧课程积分和学习进度仍保留。</p>}</details>
      {onPractice && <button className="button button-secondary" onClick={onPractice}>暂不测评，先继续练习</button>}
    </>}
  </section>
}
