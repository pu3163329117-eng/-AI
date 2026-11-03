import { useEffect, useRef, useState, type FormEvent } from 'react'
import { supportInboxApi } from '../supportInboxApi'
import { feedbackDate, feedbackRequestId } from '../feedback'
import { RequestError, uncertainWrite } from '../http'
import { inboxError, inboxKinds, inboxLimit, inboxStatuses, inboxTimeKey, replyProblem, trimInboxText, validInboxReference, type InboxDetail, type InboxMeta, type InboxPage, type InboxQuery, type InboxReplyPayload, type InboxStatus, type InboxStatusPayload } from '../supportInbox'
import type { ExitRisk } from '../usePageRoute'
import { useConfirmationDialog } from './ConfirmationDialog'
import './supportInbox.css'

type Draft = { message: string; replyStatus: InboxStatus | ''; nextStatus: InboxStatus }
type Pending = { type: 'reply'; id: string; reference: string; payload: InboxReplyPayload; priorReplies: string[] }
  | { type: 'status'; id: string; reference: string; payload: InboxStatusPayload }
const emptyQuery = (): InboxQuery => ({ reference: '', status: '', kind: '', offset: 0 })
const emptyDraft = (status: InboxStatus = 'received'): Draft => ({ message: '', replyStatus: '', nextStatus: status })

/** List metadata is deliberately separate from explicit detail reads. No email,
 *  account identity, learning lookup, notification mail or deletion operation.
 */
export function SupportInbox({ onRiskChange }: { onRiskChange: (risk: ExitRisk) => void }) {
  const [query, setQuery] = useState(emptyQuery), queryRef = useRef(query)
  const [search, setSearch] = useState('')
  const [list, setList] = useState<InboxPage | null>(null), [listError, setListError] = useState('')
  const listRef = useRef<InboxPage | null>(null), [listStale, setListStale] = useState(false)
  const [selected, setSelected] = useState<InboxMeta | null>(null)
  const [detail, setDetail] = useState<InboxDetail | null>(null), detailRef = useRef<InboxDetail | null>(null)
  const [detailError, setDetailError] = useState(''), [notice, setNotice] = useState('')
  const [draft, setDraft] = useState<Draft>(emptyDraft), draftRef = useRef(draft)
  const [pending, setPending] = useState<Pending | null>(null), pendingRef = useRef<Pending | null>(null)
  const [conflict, setConflict] = useState(false)
  const [activity, setActivity] = useState<'list' | 'detail' | 'write' | 'check' | null>(null)
  const lock = useRef(false), alive = useRef(true), generation = useRef(0), editEpoch = useRef(0)
  const active = useRef<AbortController | null>(null), dirtyRef = useRef(false)
  const riskCallback = useRef(onRiskChange); riskCallback.current = onRiskChange
  const heading = useRef<HTMLHeadingElement>(null)
  const confirmation = useConfirmationDialog('support-inbox')
  const frozen = !!activity || !!pending
  const dirty = (value = draftRef.current, base = detailRef.current) => !!value.message || !!value.replyStatus || (!!base && value.nextStatus !== base.item.status)
  function reportRisk() { dirtyRef.current = dirty(); riskCallback.current(lock.current ? 'working' : pendingRef.current ? 'uncertain' : dirtyRef.current ? 'dirty' : null) }
  function setDraftNow(next: Draft) { draftRef.current = next; setDraft(next); editEpoch.current++; reportRisk() }
  function setPendingNow(next: Pending | null) { pendingRef.current = next; setPending(next); reportRisk() }
  function begin(kind: NonNullable<typeof activity>) {
    if (lock.current || !alive.current) return null
    active.current?.abort(); const controller = new AbortController(), stamp = ++generation.current
    active.current = controller; lock.current = true; setActivity(kind); reportRisk()
    return { signal: controller.signal, current: () => alive.current && stamp === generation.current && !controller.signal.aborted }
  }
  function end(request: { current: () => boolean }) {
    if (!request.current()) return
    active.current = null; lock.current = false; setActivity(null); reportRisk()
  }
  function clearDetail() {
    editEpoch.current++; detailRef.current = null; setSelected(null); setDetail(null); setDetailError(''); setConflict(false)
    draftRef.current = emptyDraft(); setDraft(draftRef.current); reportRisk()
  }
  function useDetail(result: InboxDetail, resetDraft: boolean, invalidateList = false) {
    detailRef.current = result; setDetail(result); setSelected(result.item); setConflict(false)
    const listed = listRef.current?.items.find(row => row.id === result.item.id)
    if (invalidateList || (listed && Object.keys(listed).some(key => listed[key as keyof InboxMeta] !== result.item[key as keyof InboxMeta]))) {
      // Do not mutate a filtered/paginated snapshot into a contradictory list.
      // Keep the explicit detail; only a new explicit GET establishes counts.
      listRef.current = null; setList(null); setListStale(true)
    }
    if (resetDraft) { draftRef.current = emptyDraft(result.item.status); setDraft(draftRef.current); editEpoch.current++ }
    reportRisk()
  }
  function guarded(action: () => void) {
    if (!alive.current || lock.current || pendingRef.current) return
    if (!dirty()) { action(); return }
    const epoch = editEpoch.current
    let consumed = false
    confirmation.ask({ title: '放弃尚未保存的回复或状态选择？', message: '取消会保留本机草稿。确认只丢弃未提交内容，不撤回服务器已保存的回复或状态；需要时请先手动复制。', confirmLabel: '确认放弃并继续', onConfirm: () => {
      if (consumed) return; consumed = true
      if (alive.current && !lock.current && !pendingRef.current && editEpoch.current === epoch) action()
    } })
  }
  async function loadList(next: InboxQuery) {
    const request = begin('list'); if (!request) return
    queryRef.current = next; setQuery(next); clearDetail(); setNotice(''); listRef.current = null; setList(null); setListStale(false); setListError('')
    try { const result = await supportInboxApi.list(next, request.signal); if (request.current()) { listRef.current = result; setList(result) } }
    catch (reason) { if (request.current()) setListError(inboxError(reason)) }
    finally { end(request) }
  }
  async function loadDetail(item: InboxMeta) {
    const request = begin('detail'); if (!request) return
    clearDetail(); setSelected(item); setNotice(''); setDetailError('')
    try {
      const result = await supportInboxApi.detail(item.id, request.signal)
      if (!request.current()) return
      if (result.item.reference !== item.reference) throw new RequestError('INVALID_RESPONSE')
      useDetail(result, true)
    } catch (reason) { if (request.current()) setDetailError(inboxError(reason)) }
    finally { end(request) }
  }
  function cancelRead() {
    if (!['list','detail','check'].includes(activity ?? '')) return
    generation.current++; active.current?.abort(); active.current = null; lock.current = false; setActivity(null)
    if (activity === 'list') setListError('读取已取消，请明确重新读取。')
    else setDetailError('读取已取消；没有自动重试，也没有清除尚未确认的提交。')
    reportRisk()
  }
  useEffect(() => {
    alive.current = true; void loadList(queryRef.current)
    return () => { alive.current = false; generation.current++; active.current?.abort(); active.current = null; lock.current = false; riskCallback.current(null) }
  }, [])
  useEffect(() => {
    if (!detail?.item.id) return
    heading.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); heading.current?.focus({ preventScroll: true })
  }, [detail?.item.id])

  function edit(change: Partial<Draft>) {
    if (lock.current || pendingRef.current || !detailRef.current) return
    setDraftNow({ ...draftRef.current, ...change }); setNotice(''); setDetailError('')
  }
  function applyQuery(next: InboxQuery) { guarded(() => { setSearch(next.reference); void loadList(next) }) }
  function searchReference(event: FormEvent) {
    event.preventDefault(); if (lock.current || pendingRef.current) return
    const reference = search.trim().toUpperCase()
    if (!validInboxReference(reference)) { setNotice('请输入完整编号 WY- 后接 16 位十六进制字符，不支持模糊或邮箱搜索。'); return }
    applyQuery({ ...queryRef.current, reference, offset: 0 })
  }
  function move(offset: number) {
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) return
    applyQuery({ ...queryRef.current, offset })
  }
  function successfulReceipt(result: InboxDetail, operation: Pending) {
    if (result.item.id !== operation.id || result.item.reference !== operation.reference) return false
    if (operation.type === 'status') return result.item.status === operation.payload.status && inboxTimeKey(result.item.updated_at) >= inboxTimeKey(operation.payload.expected_updated_at)
    return inboxTimeKey(result.item.updated_at) > inboxTimeKey(operation.payload.expected_updated_at) && result.replies.some(reply => !operation.priorReplies.includes(reply.id) && reply.message === operation.payload.message)
  }
  async function send(operation: Pending) {
    const request = begin('write'); if (!request) return
    setDetailError(''); setNotice('')
    try {
      const result = operation.type === 'reply' ? await supportInboxApi.reply(operation.id, operation.payload, request.signal) : await supportInboxApi.status(operation.id, operation.payload, request.signal)
      if (!request.current()) return
      if (!successfulReceipt(result, operation)) throw new RequestError('INVALID_RESPONSE')
      const before = draftRef.current, baseStatus = detailRef.current?.item.status
      useDetail(result, false, true); setPendingNow(null)
      setDraftNow(operation.type === 'reply' ? { message: '', replyStatus: '', nextStatus: before.nextStatus !== baseStatus ? before.nextStatus : result.item.status } : { ...before, nextStatus: result.item.status })
      setNotice(operation.type === 'reply' ? '服务器已确认站内回复。这不是邮件通知；提交者可在原反馈详情主动查看。' : '服务器已确认当前处理状态；相同状态可能为无变化操作。未删除账号或学习数据。')
    } catch (reason) {
      if (!request.current()) return
      setDetailError(inboxError(reason))
      if (uncertainWrite(reason)) setPendingNow(operation)
      else {
        // A failed verification does not prove that the ORIGINAL unknown write
        // failed. Keep that original key/payload frozen for manual handling.
        if (!pendingRef.current && reason instanceof RequestError && reason.message === 'SUPPORT_CASE_CHANGED_REFRESH_REQUIRED') setConflict(true)
      }
    } finally { end(request) }
  }
  function submitReply(event: FormEvent) {
    event.preventDefault(); const base = detailRef.current
    if (!base || lock.current || pendingRef.current || conflict) return
    const problem = replyProblem(draftRef.current.message); if (problem) { setDetailError(problem); return }
    const payload: InboxReplyPayload = { request_id: feedbackRequestId(), message: trimInboxText(draftRef.current.message), expected_updated_at: base.item.updated_at }
    if (draftRef.current.replyStatus) payload.status = draftRef.current.replyStatus
    const operation: Pending = { type: 'reply', id: base.item.id, reference: base.item.reference, payload, priorReplies: base.replies.map(reply => reply.id) }
    confirmWrite(operation)
  }
  function confirmWrite(operation: Pending) {
    const epoch = editEpoch.current
    let consumed = false
    confirmation.ask({ title: operation.type === 'reply' ? '发送公开站内回复？' : '更新反馈处理状态？', message: operation.type === 'reply' ? '这段文字会展示给原提交者，不会发送邮件。确认前请检查隐私信息；不会自动删除任何数据。' : '只改变这份反馈的工作流状态，不执行账号或学习数据删除。', confirmLabel: operation.type === 'reply' ? '确认发送站内回复' : '确认更新状态', onConfirm: () => {
      if (consumed) return; consumed = true
      if (alive.current && !lock.current && !pendingRef.current && editEpoch.current === epoch && detailRef.current?.item.id === operation.id && detailRef.current.item.updated_at === operation.payload.expected_updated_at) void send(operation)
    } })
  }
  function submitStatus() {
    const base = detailRef.current
    if (!base || lock.current || pendingRef.current || conflict) return
    confirmWrite({ type: 'status', id: base.item.id, reference: base.item.reference, payload: { status: draftRef.current.nextStatus, expected_updated_at: base.item.updated_at } })
  }
  async function checkPending() {
    const original = pendingRef.current
    if (!original || lock.current) return
    const request = begin('check'); if (!request) return
    setDetailError('')
    try {
      const result = await supportInboxApi.detail(original.id, request.signal)
      if (!request.current()) return
      if (result.item.reference !== original.reference) throw new RequestError('INVALID_RESPONSE')
      useDetail(result, false, true)
      if (original.type === 'status') {
        setPendingNow(null); setDraftNow({ ...draftRef.current, nextStatus: result.item.status })
        setNotice(`已核对服务器当前状态为“${inboxStatuses[result.item.status]}”。无法据此认定是本次操作产生；没有自动重试原状态写入。`)
      } else setNotice('已读取原记录的当前内容。仅凭同样文字不能确认原提交；原回复编号与内容仍冻结，请使用“核对原回复提交”获取幂等收据。')
    } catch (reason) { if (request.current()) setDetailError(inboxError(reason)) }
    finally { end(request) }
  }
  function retryOriginal() {
    const original = pendingRef.current; if (!original || original.type !== 'reply' || lock.current) return
    let consumed = false
    confirmation.ask({ title: '核对原回复提交？', message: '将以完全相同的提交编号、原内容与原版本向服务器核对。若之前未保存，这次核对可能完成原提交；不会生成新编号或换内容重试。', confirmLabel: '使用原编号核对', onConfirm: () => {
      if (consumed) return; consumed = true
      if (alive.current && !lock.current && pendingRef.current === original) void send(original)
    } })
  }

  const outOfRange = !!list && !list.items.length && query.offset > 0
  return <section className="support-inbox" aria-labelledby="support-inbox-title" aria-busy={!!activity}>
    <header className="waterink-page-heading"><p className="eyebrow">内测支持 · 管理工作台</p><h1 id="support-inbox-title">把问题，一件件接住。</h1><p>先按编号与状态找提交，再主动打开正文。回复只在站内对原提交者可见；“已处理”不是数据删除凭证。</p></header>
    <form className="support-inbox-filters" onSubmit={searchReference}>
      <label>完整受理编号<input type="search" value={search} maxLength={64} autoComplete="off" placeholder="WY-0123456789ABCDEF" disabled={frozen} onChange={event => setSearch(event.target.value)} /></label>
      <label>处理状态<select value={query.status} disabled={frozen} onChange={event => applyQuery({ ...queryRef.current, status: event.target.value as InboxQuery['status'], offset: 0 })}><option value="">全部状态</option>{Object.entries(inboxStatuses).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>事项种类<select value={query.kind} disabled={frozen} onChange={event => applyQuery({ ...queryRef.current, kind: event.target.value as InboxQuery['kind'], offset: 0 })}><option value="">全部事项</option>{Object.entries(inboxKinds).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <button type="submit" disabled={frozen}>按编号查找</button><button type="button" disabled={frozen} onClick={() => guarded(() => { void loadList(queryRef.current) })}>重新读取列表</button>
    </form>
    {activity && activity !== 'write' && <button type="button" className="support-cancel-read" onClick={cancelRead}>取消当前读取</button>}
    {notice && <p className="support-inbox-notice" role="status">{notice}</p>}
    {pending && <section className="support-inbox-unknown" role="alert"><h2>提交结果尚未确认</h2><p>仅核对原编号 {pending.reference}。不要换记录、改内容或生成新提交。离开整个工作台会丢失本机核对线索，不撤销服务器操作；需要时先手动复制草稿。</p><button type="button" disabled={!!activity} onClick={() => void checkPending()}>重新读取原记录核对</button>{pending.type === 'reply' && <button type="button" disabled={!!activity} onClick={retryOriginal}>核对原回复提交</button>}</section>}
    <div className="support-inbox-columns">
      <aside className="support-inbox-list" aria-label="反馈元数据列表">
        <h2>待办与历史</h2><p className="support-inbox-hint">列表不含正文或账号资料；列表为读取时快照，状态变化后可主动刷新。</p>
        {activity === 'list' ? <p role="status">正在读取反馈列表…</p> : listError ? <p role="alert">列表暂不可用：{listError}</p> : listStale ? <div role="status"><p>列表快照已过期，已隐藏旧条目与计数。当前详情仍保留；请明确重新读取，不会自动查询。</p><button type="button" disabled={frozen} onClick={() => applyQuery({ ...queryRef.current, offset: 0 })}>按原筛选重新读取第一页</button></div> : !list ? <p>尚未读取列表。</p> : <>
          <p>{outOfRange ? '本页已无记录，列表可能已变化。' : list.items.length ? `第 ${query.offset + 1}–${query.offset + list.items.length} 条，共 ${list.total} 条` : '没有符合当前条件的提交。'}</p>
          <ul>{list.items.map(item => <li key={item.id}><button type="button" disabled={frozen} aria-current={selected?.id === item.id ? 'true' : undefined} onClick={() => guarded(() => { void loadDetail(item) })}><strong>{item.reference}</strong><span>{inboxKinds[item.kind]} · {inboxStatuses[item.status]}</span><time dateTime={item.created_at}>{feedbackDate(item.created_at)}</time></button></li>)}</ul>
          <nav aria-label="反馈列表分页"><button type="button" disabled={frozen || query.offset === 0} onClick={() => move(Math.max(0, Math.min(query.offset - inboxLimit, Math.max(0, Math.floor(((list?.total ?? 1) - 1) / inboxLimit) * inboxLimit))))}>上一页反馈</button><button type="button" disabled={frozen || !list.items.length || query.offset + inboxLimit >= list.total || query.offset + inboxLimit > 10000} onClick={() => move(query.offset + inboxLimit)}>下一页反馈</button>{outOfRange && <button type="button" disabled={frozen} onClick={() => move(0)}>返回第一页反馈</button>}</nav>
        </>}
      </aside>
      <section className="support-inbox-detail" aria-label="主动读取的反馈详情">
        {!selected ? <><h2>选择一份提交</h2><p>点击左侧编号后，才会读取正文、设备说明与已保存的站内回复。</p></> : <>
          <h2 ref={heading} tabIndex={-1}>提交 {selected.reference}</h2>
          <button type="button" disabled={frozen} onClick={() => guarded(() => { void loadDetail(selected) })}>重新读取当前详情</button>
          {detailError && <p className="support-inbox-error" role="alert">{detailError}</p>}
          {activity === 'detail' ? <p role="status">正在读取正文与回复…</p> : detail && <>
            <dl className="support-inbox-meta"><div><dt>当前状态</dt><dd>{inboxStatuses[detail.item.status]}</dd></div><div><dt>事项</dt><dd>{inboxKinds[detail.item.kind]}</dd></div><div><dt>提交页面</dt><dd>{detail.item.page}</dd></div><div><dt>版本</dt><dd>{detail.item.build_version}</dd></div><div><dt>最后更新</dt><dd><time dateTime={detail.item.updated_at}>{feedbackDate(detail.item.updated_at)}</time></dd></div></dl>
            <h3>原提交正文</h3><p className="support-inbox-plain">{detail.message}</p><h3>用户填写的设备与浏览器</h3><p className="support-inbox-plain">{detail.device || '未填写'}</p>
            <h3>已保存的站内回复（{detail.replies.length}/20）</h3>{detail.replies.length ? <ol className="support-inbox-replies">{detail.replies.map(reply => <li key={reply.id}><time dateTime={reply.created_at}>{feedbackDate(reply.created_at)}</time><p className="support-inbox-plain">{reply.message}</p></li>)}</ol> : <p>还没有站内回复。</p>}
            {conflict && <p className="support-inbox-error" role="alert">版本冲突：草稿保留在下面，可手动复制。请明确重新读取后再提交，不会覆盖他人更新。</p>}
            <form className="support-inbox-reply" onSubmit={submitReply}>
              <label>公开站内回复<textarea value={draft.message} disabled={frozen} maxLength={4000} rows={6} onChange={event => edit({ message: event.target.value })} aria-describedby="support-reply-hint" /></label>
              <p id="support-reply-hint">10–2000 个字。仅发送给原提交者的站内详情，不发送邮件；不要写账号信息、密钥或验证码。草稿不落浏览器存储。</p>
              <label>随回复设置状态<select value={draft.replyStatus} disabled={frozen} onChange={event => edit({ replyStatus: event.target.value as Draft['replyStatus'] })}><option value="">保持服务器当前状态</option>{Object.entries(inboxStatuses).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
              <button type="submit" disabled={frozen || conflict || !!replyProblem(draft.message) || detail.replies.length >= 20}>发送站内回复</button>
            </form>
            <section className="support-inbox-status" aria-label="单独更新工作流状态"><h3>只更新处理状态</h3><p>包括“已撤回”在内，均为工作流标签，不自动删除账号或学习记录。</p><label>新的处理状态<select value={draft.nextStatus} disabled={frozen} onChange={event => edit({ nextStatus: event.target.value as InboxStatus })}>{Object.entries(inboxStatuses).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label><button type="button" disabled={frozen || conflict || draft.nextStatus === detail.item.status} onClick={submitStatus}>更新处理状态</button></section>
          </>}
        </>}
      </section>
    </div>
    {confirmation.modal}
  </section>
}
