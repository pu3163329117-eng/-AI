import { useEffect, useRef, useState } from 'react'
import { aiReasonReviewApi } from '../aiReasonReviewApi'
import { editorialRequestId } from '../assessmentEditorialApi'
import { emptyReviewFields, normalizeReviewFields, reviewDecisions, reviewDecisionLabels, reviewLabels, reviewLabelNames, validReviewFields, validReviewWrite, type ReviewDetail, type ReviewFields, type ReviewQueue, type ReviewWrite } from '../aiReasonReview'
import { authResponseCheckpoint, errorMessage, RequestError, uncertainWrite } from '../http'
import { downloadReviewBundle, reviewBundleCounts, type ReviewBundle } from '../aiReasonReviewExport'
import type { ExitRisk } from '../usePageRoute'
import '../aiReasonReview.css'
import { useConfirmationDialog } from './ConfirmationDialog'

const storage = 'wenyan-ai-review-pending-v1'
const unknownResult = (reason: unknown) => !(reason instanceof RequestError) || uncertainWrite(reason) || reason.status === 408 || reason.status === 429
function readPending(): ReviewWrite | null { try { const value = JSON.parse(sessionStorage.getItem(storage) ?? 'null'); return validReviewWrite(value) ? value : null } catch { return null } }
function persist(value: ReviewWrite | null) { try { if (value) sessionStorage.setItem(storage, JSON.stringify(value)); else sessionStorage.removeItem(storage); return true } catch { return false } }
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
const contextLabels = { SUFFICIENT: '足以判断当前关系', INSUFFICIENT: '缺少必要语境', UNCERTAIN: '尚不能判断' }
function message(reason: unknown) {
  if (reason instanceof Error && reason.message === 'BETA_FEATURE_DISABLED') return '当前内测未开放 AI 样例核对，仅限本机教研环境使用。（BETA_FEATURE_DISABLED）'
  const map: Record<string, string> = { AI_LOCAL_PREVIEW_ONLY: 'AI 样例核对仅允许在这台电脑的本机地址使用，不开放内网或公网。', AI_REVIEW_VERSION_CONFLICT: '意见版本已变化，本次没有覆盖。请先复制自己的意见，再重新读取。', AI_REVIEW_SUITE_CHANGED: '样例已更新，本次未保存到新版本。请复制意见并重新读取后核对。', IDEMPOTENCY_KEY_REUSED: '原提交标识的内容不一致，已停止保存。请保留意见并重新读取。', AI_REVIEW_HISTORY_FULL: '当前样例已达 100 条意见上限，请整理分歧后再修订样例版本。', AI_REVIEW_INVALID: '请填写署名、实际依据和核对理由。' }
  return map[reason instanceof Error ? reason.message : ''] ?? errorMessage(reason)
}

function ReviewBundleExport({ blockedReason, onWorkingChange, onSelectCase }: { blockedReason: string | null; onWorkingChange: (working: boolean) => void; onSelectCase: (id: string) => void }) {
  const [acknowledged, setAcknowledged] = useState(false), [working, setWorking] = useState(false)
  const [error, setError] = useState(''), [snapshot, setSnapshot] = useState<ReviewBundle | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const alive = useRef(true), lock = useRef(false), controller = useRef<AbortController | null>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort() } }, [])
  async function download() {
    if (blockedReason || !acknowledged || lock.current) return
    lock.current = true; setWorking(true); onWorkingChange(true); setError(''); setSnapshot(null); setCancelled(false)
    const abort = new AbortController(); controller.current = abort
    try {
      const bundle = await aiReasonReviewApi.exportBundle(abort.signal)
      if (!alive.current || abort.signal.aborted) return
      downloadReviewBundle(bundle); setSnapshot(bundle)
    } catch (reason) {
      if (alive.current && !abort.signal.aborted) setError(reason instanceof Error && reason.message === 'AI_REVIEW_EXPORT_TOO_LARGE' ? '交接包超过 8 MiB，本次未下载。请联系维护者处理，不会自动拆分或外发。' : message(reason))
    } finally { lock.current = false; if (alive.current) { setWorking(false); onWorkingChange(false) } }
  }
  function cancel() {
    if (!working || controller.current?.signal.aborted) return
    controller.current?.abort(); setCancelled(true)
  }
  const counts = snapshot ? reviewBundleCounts(snapshot) : null
  const fieldNames = { decision: '本次意见', context_sufficiency: '语境充分性', suggested_labels: '建议标签' }
  return <section className="ai-review-export" aria-labelledby="ai-review-export-title">
    <div><p className="eyebrow">只读快照 · 不改变评分边界</p><h2 id="ai-review-export-title">教研交接包</h2><p>下载当前套件的原文、开发量表和已保存意见，便于离线逐项核对。快照可能比页面队列更新，不会覆盖当前编辑；未保存草稿不包含在文件中。</p></div>
    <div className="ai-review-export-controls"><label><input type="checkbox" checked={acknowledged} disabled={!!blockedReason || working} onChange={event => setAcknowledged(event.target.checked)} />我已知晓：JSON 文件包含自填署名和意见，仅下载到本机；转交前需检查隐私。</label><button type="button" className="button button-secondary" disabled={!!blockedReason || !acknowledged || working} aria-describedby="ai-review-export-help" onClick={() => void download()}>{working ? '正在整理交接包…' : '下载教研交接包 JSON'}</button><p id="ai-review-export-help" className="knowledge-note">{blockedReason ?? '仅比较意见字段，不按署名统计人数，不认证教师一致性或语义正确性。'}</p></div>
    {error && <p className="request-error" role="alert">{error}</p>}
    {working && <div className="ai-review-export-progress"><p role="status">正在读取只读快照，尚未下载。可取消整理后切换工作台；关闭页面会取消本次读取。</p><button type="button" className="button button-secondary" disabled={cancelled} onClick={cancel}>取消整理</button></div>}
    {cancelled && <p role="status">已取消读取，未发起下载。可重新整理或离开工作台。</p>}
    {snapshot && counts && <div className="ai-review-export-result" role="status"><p>已发起本机下载 · {time(snapshot.generated_at)} · {snapshot.suite_version}</p><dl><div><dt>尚无意见</dt><dd>{counts.NO_OPINION}</dd></div><div><dt>仅一条意见</dt><dd>{counts.ONE_OPINION}</dd></div><div><dt>字段有差异</dt><dd>{counts.FIELDS_DIFFER}</dd></div><div><dt>字段相同</dt><dd>{counts.FIELDS_MATCH}</dd></div></dl>{snapshot.queue.notes_total === 0 && <p>当前快照尚无意见可比对，可先逐项填写并保存核对意见。</p>}<p>字段相同不代表教师一致或语义正确，文字理由仍需人工核对。</p>{counts.FIELDS_DIFFER > 0 && <section aria-label="导出快照中的字段差异"><h3>定位字段差异</h3><p>下面是导出时快照，后续编辑不会自动同步。查看样例会重新读取当前记录，不自动替换已有草稿。</p><ul className="ai-review-export-differences">{snapshot.comparison.filter(item => item.status === 'FIELDS_DIFFER').map(item => <li key={item.case_id}><div><b>“{snapshot.cases.find(detail => detail.case_id === item.case_id)?.payload.target}” · {item.case_id}</b><p>差异字段：{item.differing_fields.map(field => fieldNames[field]).join('、')}</p></div><button type="button" className="knowledge-action" disabled={!!blockedReason || working} onClick={() => onSelectCase(item.case_id)}>查看该样例</button></li>)}</ul></section>}</div>}
  </section>
}

export function AIReasonReviewWorkbench({ onExitRiskChange }: { onExitRiskChange: (risk: ExitRisk) => void }) {
  const [queue, setQueue] = useState<ReviewQueue | null>(null), [listError, setListError] = useState(''), [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<ReviewDetail | null>(null), [fields, setFields] = useState<ReviewFields>(emptyReviewFields)
  const [target, setTarget] = useState('ALL'), [state, setState] = useState('ALL'), [refresh, setRefresh] = useState(0)
  const [operationBusy, setBusy] = useState(false), [exporting, setExporting] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [revealed, setRevealed] = useState(false)
  const [pending, setPending] = useState<ReviewWrite | null>(readPending), [durable, setDurable] = useState(true)
  const pendingRef = useRef<ReviewWrite | null>(pending)
  const lock = useRef(false), alive = useRef(true), controller = useRef<AbortController | null>(null), heading = useRef<HTMLHeadingElement>(null)
  const dirty = JSON.stringify(fields) !== JSON.stringify(emptyReviewFields())
  const busy = operationBusy || exporting
  const blocked = busy || !!pending
  const confirmation = useConfirmationDialog(JSON.stringify([detail?.case_id, detail?.revision, detail?.suite_digest, detail?.input_digest, fields, busy, pending]))
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort() } }, [])
  useEffect(() => { onExitRiskChange(busy ? 'working' : pending ? 'uncertain' : dirty ? 'dirty' : null) }, [busy, pending, dirty, onExitRiskChange])
  useEffect(() => () => onExitRiskChange(null), [onExitRiskChange])
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setListError('')
    aiReasonReviewApi.list(abort.signal).then(value => { if (!abort.signal.aborted) { setQueue(value); setLoading(false) } }).catch(reason => { if (!abort.signal.aborted) { setListError(message(reason)); setLoading(false) } })
    return () => abort.abort()
  }, [refresh])
  async function open(id: string, confirmed = false) {
    if (blocked || lock.current) return
    if (dirty && !confirmed) {
      confirmation.ask({ title: '放弃当前样例核对意见？', message: '有未保存的样例核对意见，确定放弃吗？请先复制需要保留的内容。', confirmLabel: '放弃意见并重新读取', onConfirm: () => void open(id, true) })
      return
    }
    lock.current = true; setBusy(true); setDetail(null); setError(''); setNotice(''); setRevealed(false)
    const abort = new AbortController(); controller.current = abort
    try {
      const value = await aiReasonReviewApi.get(id, abort.signal)
      if (!alive.current || abort.signal.aborted) return
      setDetail(value); setFields(emptyReviewFields())
      requestAnimationFrame(() => { heading.current?.focus({ preventScroll: true }); if (window.matchMedia('(max-width: 52rem)').matches) heading.current?.scrollIntoView({ block: 'start' }) })
    } catch (reason) { if (alive.current && !abort.signal.aborted) setError(message(reason)) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  function remember(operation: ReviewWrite | null) { pendingRef.current = operation; setPending(operation); setDurable(persist(operation)) }
  async function submit(recovery = false) {
    if (lock.current || (pendingRef.current && !recovery) || (!pendingRef.current && recovery)) return
    let operation = pendingRef.current
    if (!recovery) {
      const normalized = normalizeReviewFields(fields)
      if (!detail || !validReviewFields(normalized)) return
      operation = { key: editorialRequestId(), case_id: detail.case_id, body: { expected_suite_digest: detail.suite_digest, expected_input_digest: detail.input_digest, expected_revision: detail.revision, fields: normalized } }
      if (!persist(operation)) { setDurable(false); setError('浏览器无法保存提交恢复标识，本次未发送。请先恢复浏览器存储，再保存意见。'); return }
      pendingRef.current = operation; setPending(operation)
    }
    if (!operation) return
    const sameIdentity = authResponseCheckpoint()
    lock.current = true; setBusy(true); setError(''); setNotice('')
    let confirmed = false
    try {
      const receipt = await aiReasonReviewApi.write(operation)
      sameIdentity()
      if (!alive.current) return
      confirmed = true; remember(null); setFields(emptyReviewFields()); setRefresh(v => v + 1)
      setNotice(`已${receipt.replayed ? '确认原提交' : '追加保存'}第 ${receipt.saved.revision} 条本地意见。署名未核验，不代表已审核。`)
      setDetail(null)
      const value = await aiReasonReviewApi.get(operation.case_id)
      sameIdentity()
      if (alive.current) { setDetail(value); setRevealed(false) }
    } catch (reason) {
      try { sameIdentity() } catch { return }
      if (!alive.current) return
      // A confirmed receipt is cleared before the follow-up read. A failed
      // follow-up GET must not recreate an already-confirmed pending write.
      if (!confirmed && !recovery && !unknownResult(reason)) remember(null)
      setError(!confirmed && recovery ? '本次恢复未得到有效回执；原提交结果仍未知，请使用原标识继续核对。' : message(reason))
    } finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  function releasePending() {
    const operation = pendingRef.current
    if (!operation || lock.current) return
    const sameIdentity = authResponseCheckpoint()
    confirmation.ask({ title: '结束未确认提交的核对？', message: '原提交可能已经保存，也可能稍后保存。结束核对不会撤销服务器写入；重新提交可能重复。请先复制需要保留的意见。', confirmLabel: '了解风险，结束核对', onConfirm: () => {
      if (!alive.current || lock.current || pendingRef.current !== operation) return
      try { sameIdentity() } catch { return }
      if (!persist(null)) { setDurable(false); setError('浏览器无法清除原核对信息，请保留本页并恢复存储后再操作。'); return }
      pendingRef.current = null; setPending(null); setDurable(true); setError(''); setNotice('原提交结果仍未知，结束核对没有撤销服务端写入；重新提交可能重复。')
    } })
  }
  const set = <K extends keyof ReviewFields>(key: K, value: ReviewFields[K]) => setFields(v => ({ ...v, [key]: value }))
  const items = queue?.items.filter(item => (target === 'ALL' || item.target === target) && (state === 'ALL' || (state === 'EMPTY' ? item.revision === 0 : item.decision === state))) ?? []
  return <main className="ai-review-workbench">
    {confirmation.modal}
    <header className="ai-review-intro"><p className="eyebrow">AI 样例核对 · 本机教研准备</p><h1>先核对理由，再比较模型。</h1><p>原文、关系量表与开发对照逐项核对。意见追加保存，分歧留在历史中；不修改训练内容或开启正式评分。</p><p className="knowledge-note">自填署名未核验。开发预期不是教师标准，下面的记录数量不代表审核质量。</p></header>
    {pending && <section className="ai-review-recovery" role="status"><b>有一笔提交结果尚未确认</b><p>{pending.case_id} · 原意见版本 {pending.body.expected_revision}。刷新没有自动重复发送；恢复失败不代表原提交失败。</p><button className="button button-secondary" disabled={busy} onClick={() => void submit(true)}>按原标识确认保存</button><button type="button" className="button button-secondary" disabled={busy} onClick={releasePending}>结束核对</button></section>}
    {!durable && <p role="alert">浏览器存储不可用，请勿刷新或关闭页面，以免丢失恢复信息。</p>}
    {notice && <p role="status">{notice}</p>}
    <ReviewBundleExport blockedReason={pending ? '请先按原标识确认提交结果，再下载交接包。' : dirty ? '有未保存意见，请先保存或明确放弃，再下载交接包。' : busy ? '正在处理其他操作，请完成后再下载交接包。' : null} onWorkingChange={value => { lock.current = value; setExporting(value) }} onSelectCase={id => void open(id)} />
    <div className="ai-review-layout">
      <aside className="ai-review-queue" aria-label="AI 样例核对队列">
        {loading ? <p role="status">正在读取样例…</p> : listError ? <div role="alert"><p>{listError}</p><button className="knowledge-action" onClick={() => setRefresh(v => v + 1)}>重新读取队列</button></div> : queue && <>
          <p><b>{queue.recorded_cases} / {queue.total}</b> 个样例已有意见 · {queue.notes_total} 条记录</p>
          <fieldset disabled={blocked}><legend>筛选样例</legend><label>目标词<select value={target} onChange={e => setTarget(e.target.value)}><option value="ALL">全部字词</option>{[...new Set(queue.items.map(item => item.target))].map(word => <option key={word}>{word}</option>)}</select></label><label>最新意见<select value={state} onChange={e => setState(e.target.value)}><option value="ALL">全部样例</option><option value="EMPTY">尚无意见</option>{reviewDecisions.map(value => <option key={value} value={value}>{reviewDecisionLabels[value]}</option>)}</select></label></fieldset>
          {!items.length && <p>当前筛选没有样例，请调整筛选。</p>}
          <div className="ai-review-case-list">{items.map(item => <button key={item.case_id} disabled={blocked} aria-pressed={detail?.case_id === item.case_id} onClick={() => void open(item.case_id)}><b>{item.target} <small>{item.stage === 'CORE' ? '核心' : '迁移'}</small></b><span>{item.source}</span><small>{item.case_id}</small><span>{item.decision ? reviewDecisionLabels[item.decision] : '尚无意见'} · {item.revision} 条记录</span></button>)}</div>
        </>}
      </aside>
      <section className="ai-review-editor" aria-label="样例及核对意见">
        {error && <p className="request-error" role="alert">{error}</p>}
        {detail ? <>
          <header><p className="eyebrow">{detail.source} · {detail.payload.stage === 'CORE' ? '核心场景' : '迁移场景'}</p><h2 ref={heading} tabIndex={-1}>“{detail.payload.target}”的理由关系</h2><p>{detail.case_id} · 当前 {detail.revision} 条意见</p></header>
          <section className="ai-review-material" aria-label="给定原文与理由"><h3>给定原文</h3>{detail.payload.visible_evidence.map(item => <blockquote key={item.id}><small>{item.id}</small>{item.text}</blockquote>)}<dl><dt>合成学生结论</dt><dd>{detail.payload.student_conclusion}</dd><dt>合成学生理由</dt><dd>{detail.payload.student_reason}</dd></dl></section>
          <section className="ai-review-rubric"><h3>开发量表 · 待核对</h3><ol>{detail.payload.rubric.map(item => <li key={item.id}><b>{item.id}</b> {item.criterion}</li>)}</ol></section>
          <div className="ai-review-expectation"><button type="button" className="knowledge-action" disabled={blocked} aria-expanded={revealed} onClick={() => setRevealed(v => !v)}>{revealed ? '收起开发预期' : '查看开发预期与核对提示'}</button><p>建议先独立填写意见，再查看开发预期。这不是经过随机分组的盲评。</p>{revealed && <div><p>{detail.development_expectation.labels.map(label => reviewLabelNames[label]).join(' / ') || '预期发送前安全阻断'}</p><p>{detail.development_expectation.note}</p><p>所需证据：{detail.development_expectation.required_evidence.join('、') || '无'}；量表要素：{detail.development_expectation.required_criteria.join('、') || '无'}</p></div>}</div>
          <form onSubmit={e => { e.preventDefault(); void submit() }}>
            <fieldset disabled={blocked}><legend>追加本地核对意见</legend>
              <div className="field-grid"><label>实际核对人署名<input required maxLength={80} value={fields.reviewer} onChange={e => set('reviewer', e.target.value)} /></label><label>本次意见<select value={fields.decision} onChange={e => set('decision', e.target.value as ReviewFields['decision'])}>{reviewDecisions.map(value => <option key={value} value={value}>{reviewDecisionLabels[value]}</option>)}</select></label></div>
              <label>给定语境是否充分<select value={fields.context_sufficiency} onChange={e => set('context_sufficiency', e.target.value as ReviewFields['context_sufficiency'])}><option value="UNCERTAIN">尚不能判断</option><option value="SUFFICIENT">足以判断当前关系</option><option value="INSUFFICIENT">缺少必要语境</option></select></label>
              <label>实际核对的原典或注本依据<textarea required maxLength={2000} value={fields.source_basis} onChange={e => set('source_basis', e.target.value)} placeholder="填写所用注本、页码、解释版本和依据；不要填写个人联系方式" /></label>
              <label>关系判断与修订理由<textarea required maxLength={4000} value={fields.rationale} onChange={e => set('rationale', e.target.value)} placeholder="哪条原文线索支持或反驳这份理由？是否存在施受倒置或缺失语境？" /></label>
              <label>可接受的替代表达或待核对分歧<textarea maxLength={4000} value={fields.alternatives ?? ''} onChange={e => set('alternatives', e.target.value || null)} /></label>
              <fieldset className="ai-review-labels"><legend>建议标签 · 可多选或暂不选</legend>{reviewLabels.map(label => <label key={label}><input type="checkbox" checked={fields.suggested_labels.includes(label)} onChange={e => set('suggested_labels', e.target.checked ? [...fields.suggested_labels, label] : fields.suggested_labels.filter(value => value !== label))} />{reviewLabelNames[label]}</label>)}</fieldset>
            </fieldset>
            <div className="ai-review-actions"><button className="button button-primary" disabled={blocked || !validReviewFields(normalizeReviewFields(fields))}>{busy ? '正在处理…' : '追加保存意见'}</button><button type="button" className="button button-secondary" disabled={blocked} onClick={() => void open(detail.case_id)}>重新读取样例</button></div>
          </form>
          <details className="ai-review-history"><summary>意见历史 · {detail.notes.length} 条</summary>{!detail.notes.length && <p>尚无核对意见，不自动生成署名或结论。</p>}{detail.notes.map(item => <article key={item.id}><h3>第 {item.revision} 条 · {reviewDecisionLabels[item.fields.decision]}</h3><p>{item.fields.reviewer} · {time(item.created_at)} · 署名未核验</p><p>语境充分性：{contextLabels[item.fields.context_sufficiency]}</p><p>来源依据：{item.fields.source_basis}</p><p>{item.fields.rationale}</p>{item.fields.alternatives && <p>替代表达与分歧：{item.fields.alternatives}</p>}<p>建议标签：{item.fields.suggested_labels.map(label => reviewLabelNames[label]).join(' / ') || '未填写'}</p></article>)}</details>
          {detail.historical_note_count > 0 && <p>另有 {detail.historical_note_count} 条旧套件意见，未混入当前进度。</p>}
          <p className="knowledge-note">保存意见不改写开发样例，也不替换运行量表。确定修订后仍需更新套件、重新冻结版本并开展模型对照。</p>
        </> : <p>{operationBusy ? '正在读取样例…' : '选择一个样例，核对原文、理由关系与量表边界。'}</p>}
      </section>
    </div>
  </main>
}
