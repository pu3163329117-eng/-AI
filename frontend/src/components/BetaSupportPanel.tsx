import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import type { AuthSession } from '../auth'
import { supportChannel, type SupportKind } from '../betaSupport'
import { feedbackApi } from '../feedbackApi'
import { createFeedbackReadGuard, feedbackBuild, feedbackDate, feedbackDraftError, feedbackDraftHint, feedbackKinds, feedbackPage, feedbackRequestId, feedbackStatuses, type FeedbackDetail, type FeedbackDraft, type FeedbackPayload, type FeedbackReceipt } from '../feedback'
import { errorMessage, uncertainWrite } from '../http'
import './betaSupport.css'

const channel = supportChannel(import.meta.env.VITE_BETA_SUPPORT_EMAIL ?? '')
const buildVersion = feedbackBuild(import.meta.env.VITE_BUILD_VERSION ?? '')
const blank = (): FeedbackDraft => ({ message: '', device: '', category: 'bug', consent: false })
function feedbackError(reason: unknown) {
  const code = reason instanceof Error ? reason.message : ''
  return ({ SUPPORT_RATE_LIMIT: '每分钟最多提交一份，请稍后再试。', SUPPORT_DAILY_LIMIT: '当前配额日已提交 5 份，北京时间 08:00 后重置。紧急账号问题可联系支持邮箱。', EXPERIENCE_INVALID_INPUT: '请检查内容长度和格式，去掉可能的密钥、验证码或邀请码后再提交。', SUPPORT_IDEMPOTENCY_CONFLICT: '提交编号与之前内容不一致，请先查看已有提交；本次没有覆盖。', EXPERIENCE_ACCOUNT_REQUIRED: '请使用已登录的内测账号提交；本地预览不接收真实反馈。', RESOURCE_NOT_FOUND: '找不到这份提交，或当前账号无法查看。请返回列表重新读取。' } as Record<string, string>)[code] ?? errorMessage(reason)
}

type DetailViewProps = { selected: FeedbackReceipt; detail: FeedbackDetail | null; loading: boolean; error: string; onBack: () => void; onRefresh: () => void; headingRef?: RefObject<HTMLHeadingElement> }
/** Plain text only. Opening this view never changes a report's handling status. */
export function FeedbackDetailView({ selected, detail, loading, error, onBack, onRefresh, headingRef }: DetailViewProps) {
  const current = detail?.receipt ?? selected
  return <section className="feedback-detail" aria-label="反馈详情" aria-busy={loading}>
    <div className="feedback-detail-toolbar"><button type="button" onClick={onBack}>返回提交列表</button><button type="button" disabled={loading} onClick={onRefresh}>{loading ? '正在读取…' : '刷新详情与回复'}</button></div>
    <h3 ref={headingRef} tabIndex={-1}>这份提交的进展</h3>
    <p className="feedback-detail-reference">{current.reference}</p>
    <dl className="feedback-detail-meta"><div><dt>事项</dt><dd>{feedbackKinds[current.kind]}</dd></div><div><dt>处理状态</dt><dd>{feedbackStatuses[current.status]}</dd></div><div><dt>提交时间</dt><dd>{feedbackDate(current.created_at)}</dd></div>{detail && <><div><dt>最近更新</dt><dd>{feedbackDate(detail.updated_at)}</dd></div>{current.kind === 'feedback' && <div><dt>反馈类型</dt><dd>{{ bug: '页面或功能问题', suggestion: '使用建议', other: '其他反馈' }[detail.category]}</dd></div>}</>}</dl>
    {loading ? <p role="status" className="feedback-detail-state">正在读取这份提交的原文与站内回复…</p> : error ? <p role="alert" className="beta-support-notice">{error}</p> : detail ? <>
      <div className="feedback-detail-original"><h4>你提交的内容</h4><p className="feedback-plain-text">{detail.message}</p><p className="beta-support-hint">页面 {detail.page} · 版本 {detail.build_version}</p></div>
      <section className="feedback-detail-replies" aria-label="负责人的站内回复"><h4>负责人的站内回复</h4>{detail.replies.length ? <ol>{detail.replies.map(reply => <li key={reply.id}><div className="feedback-reply-meta"><strong>内测负责人</strong><time dateTime={reply.created_at}>{feedbackDate(reply.created_at)}</time></div><p className="feedback-plain-text">{reply.message}</p></li>)}</ol> : <p className="feedback-detail-state">暂时还没有站内回复。你的提交已记录，可以稍后主动刷新查看。</p>}</section>
      <p className="beta-support-hint">这里展示当前已保存的处理状态与回复，不自动刷新，也不发送通知邮件。</p>
    </> : <p className="feedback-detail-state">尚未读取详情，请点击“刷新详情与回复”。</p>}
  </section>
}

/** Only explicit user submission transmits typed text; no fingerprinting or draft storage. */
export function BetaSupportPanel({ session }: { session?: AuthSession }) {
  // Immediate render-time identity separation also protects callers that do not
  // remount their entire authenticated app when accounts change.
  return <AccountBetaSupportPanel key={`${session?.mode ?? 'guest'}:${session?.authenticated ? session.user?.id ?? 'local' : 'guest'}`} session={session} />
}

function AccountBetaSupportPanel({ session }: { session?: AuthSession }) {
  const enabled = session?.mode === 'invite' && session.authenticated
  const [page, setPage] = useState(() => feedbackPage(typeof location === 'undefined' ? '' : location.hash))
  const [kind, setKind] = useState<SupportKind>('feedback')
  const [drafts, setDrafts] = useState<Record<SupportKind, FeedbackDraft>>({ feedback: blank(), privacy: blank(), deletion: blank() })
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<FeedbackPayload | null>(null)
  const [receipt, setReceipt] = useState<FeedbackReceipt | null>(null)
  const [history, setHistory] = useState<FeedbackReceipt[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<FeedbackReceipt | null>(null)
  const [detail, setDetail] = useState<FeedbackDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const lock = useRef(false), alive = useRef(true)
  const controller = useRef<AbortController | null>(null)
  const receiptHeading = useRef<HTMLHeadingElement>(null)
  const formHeading = useRef<HTMLHeadingElement>(null)
  const returnToForm = useRef(false)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const errorNotice = useRef<HTMLParagraphElement>(null)
  const detailReads = useRef(createFeedbackReadGuard())
  const detailReturn = useRef('')
  const detailScroll = useRef({ x: 0, y: 0 })
  const detailTriggers = useRef(new Map<string, HTMLButtonElement>())
  const detailBusy = useRef(false)
  const detailFocusGeneration = useRef(0)
  const draft = drafts[kind]
  const disabled = busy || !!pending
  const metadataPage = pending?.page ?? page
  const metadataBuild = pending?.build_version ?? buildVersion
  useEffect(() => {
    const updatePage = () => setPage(feedbackPage(location.hash))
    window.addEventListener('hashchange', updatePage)
    window.addEventListener('popstate', updatePage)
    window.addEventListener('wenyan:route-change', updatePage)
    updatePage()
    return () => { window.removeEventListener('hashchange', updatePage); window.removeEventListener('popstate', updatePage); window.removeEventListener('wenyan:route-change', updatePage) }
  }, [])
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); detailReads.current.cancel() } }, [])
  useEffect(() => {
    const heading = receipt ? receiptHeading.current : returnToForm.current ? formHeading.current : null
    if (!heading) return
    // Long mobile forms shrink after success. Focus alone with preventScroll
    // leaves the receipt above the viewport, so make the destination visible.
    heading.scrollIntoView({ block: 'start', behavior: 'instant' })
    heading.focus({ preventScroll: true })
    returnToForm.current = false
  }, [receipt])
  useEffect(() => { if (error) errorNotice.current?.focus() }, [error])
  useEffect(() => {
    if (selected) {
      detailHeading.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
      detailHeading.current?.focus({ preventScroll: true })
    }
  }, [selected?.id])
  function closeDetail(restoreFocus = true) {
    const generation = ++detailFocusGeneration.current
    detailBusy.current = false
    detailReads.current.cancel(); setSelected(null); setDetail(null); setDetailError(''); setDetailLoading(false)
    if (restoreFocus) requestAnimationFrame(() => {
      // A rapid reopen, collapse, or second navigation invalidates this delayed
      // return. Never pull the reader away from their newer destination.
      if (!alive.current || generation !== detailFocusGeneration.current) return
      window.scrollTo({ top: detailScroll.current.y, left: detailScroll.current.x, behavior: 'instant' })
      detailTriggers.current.get(detailReturn.current)?.focus({ preventScroll: true })
    })
  }
  async function loadDetail(item: FeedbackReceipt, origin?: string) {
    if (!enabled || lock.current || detailBusy.current) return
    detailBusy.current = true
    detailFocusGeneration.current += 1
    if (origin) { detailReturn.current = origin; detailScroll.current = { x: window.scrollX, y: window.scrollY } }
    const request = detailReads.current.begin()
    setSelected(item); setDetail(null); setDetailError(''); setDetailLoading(true); setError(''); setNotice('')
    try {
      const result = await feedbackApi.detail(item.id, request.signal)
      if (!alive.current || !request.isCurrent()) return
      if (result.receipt.kind !== item.kind || result.receipt.reference !== item.reference) throw new Error('INVALID_RESPONSE')
      setDetail(result)
      setHistory(previous => previous?.map(row => row.id === result.receipt.id ? result.receipt : row) ?? null)
      setReceipt(previous => previous?.id === result.receipt.id ? result.receipt : previous)
    } catch (reason) { if (alive.current && request.isCurrent()) setDetailError(feedbackError(reason)) }
    finally { if (alive.current && request.isCurrent()) { detailBusy.current = false; setDetailLoading(false) } }
  }
  const rememberTrigger = (id: string, button: HTMLButtonElement | null) => { if (button) detailTriggers.current.set(id, button); else detailTriggers.current.delete(id) }
  const edit = (change: Partial<FeedbackDraft>) => { setDrafts(previous => ({ ...previous, [kind]: { ...previous[kind], ...change } })); setError(''); setNotice('') }
  const choose = (next: SupportKind) => { if (disabled) return; setKind(next); setReceipt(null); setError(''); setNotice('') }
  function writeAnother() { returnToForm.current = true; setReceipt(null); setNotice('') }
  async function send(payload: FeedbackPayload) {
    if (!enabled || lock.current) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    const request = new AbortController(); controller.current = request
    try {
      const result = await feedbackApi.submit(payload, request.signal)
      if (!alive.current) return
      setReceipt(result); setPending(null)
      setDrafts(previous => ({ ...previous, [payload.kind]: blank() }))
      setHistory(previous => previous ? [result, ...previous.filter(item => item.id !== result.id)].slice(0, 20) : null)
    } catch (reason) {
      if (!alive.current || request.signal.aborted) return
      setError(feedbackError(reason)); if (uncertainWrite(reason)) setPending(payload)
    } finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!enabled || disabled || lock.current) return
    const problem = feedbackDraftError(draft)
    if (problem) { setError(problem); return }
    const payload: FeedbackPayload = { request_id: feedbackRequestId(), kind, category: kind === 'feedback' ? draft.category : 'other', message: draft.message.trim(), device: draft.device.trim(), page, build_version: buildVersion }
    void send(payload)
  }
  async function loadHistory() {
    if (!enabled || lock.current) return
    lock.current = true; setBusy(true); setError('')
    const request = new AbortController(); controller.current = request
    try { const results = await feedbackApi.list(request.signal); if (alive.current) setHistory(results) }
    catch (reason) { if (alive.current && !request.signal.aborted) setError(feedbackError(reason)) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  async function copyReference() {
    if (!receipt) return
    try { await navigator.clipboard.writeText(receipt.reference); if (alive.current) setNotice('受理编号已复制。') }
    catch { if (alive.current) setNotice('无法自动复制，请手动选中上方受理编号。') }
  }
  return <footer className="beta-support">
    <p className="beta-support-contact">遇到问题？可在这里提交反馈{channel.email && <>，或联系 <span>{channel.email}</span></>}。</p>
    <details onToggle={event => { if (!event.currentTarget.open) closeDetail(false) }}>
      <summary>反馈与帮助</summary>
      <section aria-label="内测反馈与数据帮助" className="beta-support-content">
        <div className="beta-support-heading"><p className="eyebrow">我们在认真听</p><h2>把问题留在这里。</h2><p>不用切换邮件应用。提交后会返回受理编号；“已收到”不代表已人工处理。</p></div>
        {!enabled ? <div className="beta-support-notice"><p>{session?.mode === 'local' ? '当前是本地预览，不能提交真实反馈。请到公网内测站登录后使用。' : '登录后可直接在站内提交反馈。登录遇到问题时，请通过下方邮箱联系负责人。'}</p>{channel.email && <a href={`mailto:${channel.email}`}>联系支持邮箱</a>}</div> : selected ? <FeedbackDetailView selected={selected} detail={detail} loading={detailLoading} error={detailError} onBack={() => closeDetail()} onRefresh={() => { void loadDetail(selected) }} headingRef={detailHeading} /> : <>
          <div className="beta-support-tabs" role="group" aria-label="帮助事项">{(Object.keys(feedbackKinds) as SupportKind[]).map(item => <button type="button" key={item} disabled={disabled} aria-pressed={kind === item} onClick={() => choose(item)}>{feedbackKinds[item]}</button>)}</div>
          {receipt ? <section className="feedback-receipt" aria-label="提交回执"><h3 ref={receiptHeading} tabIndex={-1}>这份提交已记录。</h3><p>受理编号</p><strong>{receipt.reference}</strong><p>{feedbackKinds[receipt.kind]} · {feedbackStatuses[receipt.status]} · {feedbackDate(receipt.created_at)}</p><p>{receipt.kind === 'deletion' ? '这是一份删除申请，不会立即删除数据。负责人会核实当前账号的申请范围后处理，请勿提供验证码。' : '负责人会在内测期间查看提交；请保留编号，方便后续沟通。'}</p><div className="beta-support-actions"><button type="button" onClick={() => void copyReference()}>复制受理编号</button><button ref={button => rememberTrigger(`receipt-${receipt.id}`, button)} type="button" disabled={busy} onClick={() => { void loadDetail(receipt, `receipt-${receipt.id}`) }}>查看详情与回复</button><button type="button" onClick={writeAnother}>再写一份</button></div></section> : <form className="feedback-form" onSubmit={submit} aria-busy={busy} noValidate>
            <h3 ref={formHeading} tabIndex={-1}>{feedbackKinds[kind]}</h3>
            {kind !== 'feedback' && <p className="beta-support-notice">{kind === 'deletion' ? '请说明想删除哪些账号数据。提交仅登记申请，不会自动删除；处理前会另行核实。' : '请描述你希望了解的数据保存、使用或处理事项。'}系统关联当前登录账号，不需要你填写邮箱、验证码或邀请码。</p>}
            {kind === 'feedback' && <label>反馈类型<select value={draft.category} disabled={disabled} onChange={event => edit({ category: event.target.value as FeedbackDraft['category'] })}><option value="bug">页面或功能问题</option><option value="suggestion">使用建议</option><option value="other">其他反馈</option></select></label>}
            <label>{kind === 'feedback' ? '发生了什么？' : '希望了解或处理的事项'}<textarea value={draft.message} required disabled={disabled} minLength={10} maxLength={6000} rows={5} aria-describedby="feedback-message-help" placeholder={kind === 'feedback' ? '例如：我在专项练习打开文章后，点击某个字没有出现解释。请写下操作步骤和你期望看到的结果。' : '请用 10–3000 个字说明具体事项，不要提供验证码或其他人的资料。'} onChange={event => edit({ message: event.target.value })} /></label>
            <p id="feedback-message-help" className="beta-support-hint">{Array.from(draft.message.trim()).length} / 3000 字（至少 10 字，不计首尾空格）。暂不支持上传截图，描述操作步骤即可。</p>
            <label>设备与浏览器 <span className="feedback-optional">选填</span><input type="text" value={draft.device} disabled={disabled} maxLength={240} placeholder="例如：安卓手机，微信内置浏览器" onChange={event => edit({ device: event.target.value })} /></label>
            <p className="feedback-metadata">{pending ? '待核对提交仍沿用页面类型' : '本次仅附页面类型'} <code>{metadataPage}</code> 与版本 <code>{metadataBuild}</code>，不附具体训练编号、地址参数或学习记录。</p>
            <label className="feedback-consent"><input type="checkbox" checked={draft.consent} disabled={disabled} onChange={event => edit({ consent: event.target.checked })} /><span>我确认内容不含验证码、邀请码、密钥或其他人的记录，并同意将填写的内容提交给本项目负责人。未提交草稿只留在当前页面，退出登录会清空。</span></label>
            <div className="feedback-submit-area">
              <p id="feedback-submit-help" className="feedback-submit-help" role="status">{busy ? '正在确认提交结果，请稍候。' : pending ? '上次结果尚未确认，请使用下方“核对上次提交”。' : feedbackDraftHint(draft)}</p>
              <button className="feedback-submit" type="submit" aria-describedby="feedback-submit-help" disabled={disabled}>{busy ? '正在确认提交…' : kind === 'deletion' ? '提交删除申请' : '提交给负责人'}</button>
              {error && <p ref={errorNotice} tabIndex={-1} role="alert" className="beta-support-notice">{error}</p>}
            </div>
          </form>}
          {pending && <div className="beta-support-notice" role="alert"><p>上次提交结果尚未确认，请勿另建一份。下面会沿用同一编号和原内容核对，不会新增重复反馈。</p><button type="button" disabled={busy} onClick={() => void send(pending)}>核对上次提交</button></div>}
          <div className="feedback-history"><button type="button" disabled={busy} onClick={() => void loadHistory()}>{history === null ? '查看我的最近提交' : '刷新提交状态'}</button>{history !== null && (history.length ? <ul>{history.map(item => <li key={item.id}><div><b>{item.reference}</b><small>{feedbackKinds[item.kind]} · {feedbackDate(item.created_at)}</small></div><div className="feedback-history-status"><span>{feedbackStatuses[item.status]}</span><button ref={button => rememberTrigger(`history-${item.id}`, button)} type="button" disabled={busy || !!pending} aria-label={`查看 ${item.reference} 的详情与回复`} onClick={() => { void loadDetail(item, `history-${item.id}`) }}>查看详情</button></div></li>)}</ul> : <p>还没有已收到的提交。</p>)}</div>
        </>}
        {error && (receipt || !enabled || selected) && <p ref={errorNotice} tabIndex={-1} role="alert" className="beta-support-notice">{error}</p>}{notice && <p role="status">{notice}</p>}
        <p className="beta-support-warning">请勿发送 API Key、验证码、邀请码、Cookie、学习原文或其他人的记录。{channel.email && <>紧急账号问题可联系 <a href={`mailto:${channel.email}`}>{channel.email}</a>。</>}</p>
      </section>
    </details>
  </footer>
}
