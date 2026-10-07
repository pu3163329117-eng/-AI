import { useEffect, useState } from 'react'
import { observationsApi } from '../observationsApi'
import { assistanceLabels, assistanceStatusLabels, observationRate, observationStageLabels } from '../observations'
import type { AttemptGroup, ObservationRecord, ObservationReportData, StageObservationTotals } from '../observations'
import { errorMessage } from '../http'
import '../observations.css'

function time(value: string | null) { if (!value) return '时间未记录'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : `${date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）` }
function Group({ name, value }: { name: string; value: AttemptGroup }) { return <article className="observation-group"><h4>{name}</h4><strong>{observationRate(value.accuracy)}</strong><p>首次词义选择正确率</p><p>样本 {value.count} · 选项正确 {value.correct_count} · 预设证据覆盖 {value.evidence_matched_count}</p></article> }
function StageSummary({ name, value }: { name: string; value: StageObservationTotals }) { return <section className="observation-stage-summary"><h3>{name}</h3><div className="observation-groups"><Group name="首次判断前未记录辅助" value={value.first_no_recorded_assistance} /><Group name="首次判断前已记录辅助" value={value.first_assisted} /></div><p className="observation-note">有首次观测 {value.observed_stages} 阶段 · 旧辅助未知 {value.unknown_stages} 阶段 · 新观测规则核验完成 {value.validated_stages} · 新观测后续重答完成 {value.retry_validated_stages}</p></section> }
function RecordItem({ record, onOpenSession }: { record: ObservationRecord; onOpenSession?: (id: string) => void }) {
  const validationLabel = record.validated ? '已完成规则核验' : record.assistance_status === 'UNKNOWN' ? '历史核验记录未完整保存' : '未完成规则核验'
  return <li>
    <div className="observation-record-heading"><b>{observationStageLabels[record.stage]} · {record.source ?? '旧原文来源未保存'}</b><span>{validationLabel}</span></div>
    <p>{assistanceStatusLabels[record.assistance_status]}</p>
    <p>{record.first_answer === null ? '首次答案未记录' : `首次词义选择：“${record.first_answer}” · ${record.first_correct ? '选项正确' : '选项尚未正确'}`}</p>
    <p>首次预设证据覆盖：{record.first_evidence_rule_matched === null ? '未知' : record.first_evidence_rule_matched ? '已覆盖' : '未覆盖'} · 实际提交 {record.attempt_count} 次 · 后续重答完成：{record.retry_completed === null ? '未知' : record.retry_completed ? '是' : '否'}</p>
    {record.assistance_kinds.length > 0 && <p>首次判断前辅助：{record.assistance_kinds.map(kind => assistanceLabels[kind]).join('、')}</p>}
    <p className="observation-note">开放理由：{record.reason_review_status === 'UNKNOWN' ? '历史复核状态未知' : '待人工或模型复核，未作语义评分'}</p>
    <p className="observation-note">首次提交 {time(record.first_submitted_at)} · 核验完成 {time(record.validated_at)} · 原文版本 {record.text_version ?? '未知'}</p>
    <div className="observation-record-footer"><small>来源会话 {record.session_id}{record.lesson_id && ` · 课程 ${record.lesson_id}`}</small>{onOpenSession && <button type="button" className="button button-secondary" onClick={() => onOpenSession(record.session_id)}>回看这份训练</button>}</div>
  </li>
}
export function ObservationReport({ profileId, onOpenSession }: { profileId: string | null; onOpenSession?: (id: string) => void }) {
  const [report, setReport] = useState<ObservationReportData | null>(null)
  const [storedLoading, setLoading] = useState(!!profileId)
  const [storedError, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [readFor, setReadFor] = useState('')
  const readKey = `${profileId ?? ''}:${retry}`
  const loading = !!profileId && (storedLoading || readFor !== readKey)
  const error = readFor === readKey ? storedError : ''
  useEffect(() => {
    const controller = new AbortController(); setReport(null); setError(''); setLoading(!!profileId)
    if (profileId) observationsApi.report(profileId, controller.signal).then(data => { if (!controller.signal.aborted) { setReport(data); setReadFor(readKey); setLoading(false) } }).catch(reason => { if (!controller.signal.aborted) { setError(errorMessage(reason)); setReadFor(readKey); setLoading(false) } })
    return () => controller.abort()
  }, [profileId, retry, readKey])
  return <section className="observations observation-report" aria-labelledby="observation-report-title"><header className="observation-report-heading"><p className="eyebrow">学习行为报告 · 首次与后续分别记录</p><h2 id="observation-report-title">表现有过程，不只看最终答对。</h2></header>{loading ? <p role="status" aria-busy="true">正在读取首次判断、辅助与来源记录…</p> : error ? <div className="observation-message" role="alert"><p>{error}</p><button className="button button-secondary" onClick={() => setRetry(value => value + 1)}>重新读取行为报告</button></div> : !profileId ? <p>建立学习档案后可读取真实学习行为。没有档案时不生成统计。</p> : report && <><p>{report.explanation}</p><p className="observation-note">新跟踪训练 {report.totals.new_sessions} 份 · 旧训练 {report.totals.legacy_sessions} 份。以下是学习模式的词义判断与证据覆盖记录，不更新正式能力等级、翻译或独立迁移分数。</p>{report.totals.observed_stages + report.totals.unknown_stages === 0 ? <div className="observation-empty"><h3>尚无已提交的判断记录。</h3><p>完成一次实际判断后才产生首次样本；打开或刷新报告不会追加记录。</p></div> : <><StageSummary name="全部学习阶段" value={report.totals} /><div className="observation-split-stages"><StageSummary name="核心判断" value={report.totals.CORE} /><StageSummary name="迁移判断" value={report.totals.TRANSFER} /></div></>}<p className="observation-note">“首次未记录辅助”不是闭卷独立证明；辅助后完成也有学习价值，两组不是因果对照。正确率来自实际选项规则，开放理由仍待复核。</p>
      <details className="observation-trend"><summary>按日查看真实样本（{report.trend.length} 天）</summary>{report.trend.length ? <ol>{report.trend.map(day => <li key={day.date}><b>{day.date}</b><p>首次未记录辅助 {day.first_no_recorded_assistance_count} 次，选项正确 {day.first_no_recorded_assistance_correct_count} 次；首次已辅助 {day.first_assisted_count} 次，选项正确 {day.first_assisted_correct_count} 次。</p><p className="observation-note">当天首次样本 {day.observed_stages} · 后续重答完成 {day.retry_validated_stages} 阶段</p></li>)}</ol> : <p>没有可追溯日期的首次样本。旧未知记录不补造日期趋势。</p>}</details>
      <details className="observation-sources"><summary>查看最近来源记录（{report.records.length} 条，最多 50 条）</summary><p className="observation-note">上方统计基于全部真实样本，此处只回看最近记录；读取与刷新不会重复增加样本。</p>{report.records.length ? <ol>{report.records.map(record => <RecordItem key={`${record.session_id}:${record.stage}`} record={record} onOpenSession={onOpenSession} />)}</ol> : <p>尚无可回看的来源记录。</p>}</details>
    </>}</section>
}
