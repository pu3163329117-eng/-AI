import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText).toString('base64')}`
const guardUrl = moduleUrl(await readFile(new URL('../src/aiReasonReview.ts', import.meta.url), 'utf8'))
const source = await readFile(new URL('../src/aiReasonReviewExport.ts', import.meta.url), 'utf8')
const exportUrl = moduleUrl(source.replace("'./aiReasonReview'", JSON.stringify(guardUrl)))
const { validReviewBundle, compareReviewNotes, reviewBundleCounts, readReviewBundle, downloadReviewBundle, reviewBundleLimit } = await import(exportUrl)
async function importApi() {
  const httpUrl = moduleUrl(await readFile(new URL('../src/http.ts', import.meta.url), 'utf8'))
  const apiText = await readFile(new URL('../src/aiReasonReviewApi.ts', import.meta.url), 'utf8')
  return (await import(moduleUrl(apiText.replace("'./http'", JSON.stringify(httpUrl)).replace("'./aiReasonReview'", JSON.stringify(guardUrl)).replace("'./aiReasonReviewExport'", JSON.stringify(exportUrl)).replace("import.meta.env.VITE_API_ROOT ?? ''", "''")))).aiReasonReviewApi
}
const gates = () => ({ review_status: 'NOT_VERIFIED', reviewer_identity_verified: false, semantic_accuracy_verified: false, may_update_learning: false, live_ai_release_gate_satisfied: false })
const hash = 'a'.repeat(64), input = 'b'.repeat(64)
const fields = () => ({ reviewer: '合成署名', decision: 'UNCERTAIN', context_sufficiency: 'UNCERTAIN', source_basis: '合成注本依据', rationale: '合成理由', alternatives: null, suggested_labels: ['UNSCORABLE', 'INSUFFICIENT_EVIDENCE'] })
function bundle(lengths = [0, 1, 2]) {
  const cases = lengths.map((length, index) => ({ ...gates(), suite_version: 'draft-v1', suite_digest: hash, case_id: `case-${index}`, source: '合成材料', input_digest: input, revision: length, historical_note_count: 0, notes: Array.from({ length }, (_, noteIndex) => ({ ...gates(), id: `fixture-${index}-${noteIndex}-12345678`, case_id: `case-${index}`, suite_digest: hash, input_digest: input, revision: noteIndex + 1, created_at: '2026-10-14T12:00:00+00:00', fields: fields() })), payload: { stage: 'CORE', text_version: 'draft-v1', target: '从', student_reason: '合成理由', student_conclusion: '合成结论', visible_evidence: [{ id: 'e1', text: '合成原文' }], rubric: [{ id: 'r1', criterion: '合成标准' }] }, development_expectation: { labels: ['UNSCORABLE'], error: null, required_evidence: ['e1'], required_criteria: ['r1'], note: '开发草稿', review_status: 'NOT_VERIFIED' } }))
  return rebalance({ ...gates(), suite_version: 'draft-v1', suite_digest: hash, format_version: 'ai-reason-review-bundle-v1', generated_at: '2026-10-14T12:00:00.123456+00:00', contains_self_entered_names: true, cases, queue: null, comparison: null })
}
function rebalance(value) {
  const recorded = value.cases.filter(detail => detail.notes.length).length
  const counts = { ACCEPTABLE: 0, NEEDS_REVISION: 0, UNCERTAIN: 0 }
  for (const detail of value.cases) { detail.revision = detail.notes.length; if (detail.notes.length) counts[detail.notes.at(-1).fields.decision]++ }
  value.queue = { ...gates(), suite_version: value.suite_version, suite_digest: value.suite_digest, total: value.cases.length, recorded_cases: recorded, notes_total: value.cases.reduce((n, detail) => n + detail.notes.length, 0), decision_counts: counts, items: value.cases.map(detail => ({ case_id: detail.case_id, target: detail.payload.target, stage: detail.payload.stage, source: detail.source, input_digest: detail.input_digest, revision: detail.revision, decision: detail.notes.at(-1)?.fields.decision ?? null })) }
  value.comparison = value.cases.map(compareReviewNotes)
  return value
}
test('bundle is a closed unverified read-only snapshot with counts derived from current notes', () => {
  assert.equal(validReviewBundle(bundle()), true)
  assert.deepEqual(reviewBundleCounts(bundle()), { NO_OPINION: 1, ONE_OPINION: 1, FIELDS_DIFFER: 0, FIELDS_MATCH: 1 })
  assert.equal(validReviewBundle(bundle([])), true)
})
test('all nested release gates stay false and unknown fields are rejected', () => {
  for (const path of [v => v, v => v.queue, v => v.cases[2], v => v.cases[2].notes[0]]) {
    for (const patch of [{ review_status: 'APPROVED' }, { reviewer_identity_verified: true }, { semantic_accuracy_verified: true }, { may_update_learning: true }, { live_ai_release_gate_satisfied: true }, { certified: true }]) { const v = bundle(); Object.assign(path(v), patch); assert.equal(validReviewBundle(v), false) }
  }
})
test('format privacy disclosure UTC timestamp and version binding are mandatory', () => {
  for (const patch of [{ format_version: 'future-v2' }, { contains_self_entered_names: false }, { suite_version: '' }, { suite_version: 'other' }, { suite_digest: 'c'.repeat(64) }, { generated_at: '2026-02-30T00:00:00Z' }, { generated_at: '2026-10-14T12:00:00+08:00' }, { generated_at: 'not-a-date' }]) assert.equal(validReviewBundle({ ...bundle(), ...patch }), false)
  const v = bundle(); delete v.format_version; assert.equal(validReviewBundle(v), false)
})
test('case order identifiers and queue/detail bindings cannot diverge', () => {
  const changes = [v => v.cases.reverse(), v => v.comparison.reverse(), v => v.cases.pop(), v => v.cases[0].case_id = v.cases[1].case_id, v => v.cases[0].input_digest = 'c'.repeat(64), v => v.cases[0].suite_version = 'other', v => v.cases[0].source = 'other', v => v.cases[0].payload.target = '于', v => v.cases[0].payload.stage = 'TRANSFER', v => v.cases[2].notes[0].id = v.cases[1].notes[0].id]
  for (const change of changes) { const v = bundle(); change(v); assert.equal(validReviewBundle(v), false) }
})
test('label ordering does not fabricate a field disagreement', () => {
  const v = bundle([2]); v.cases[0].notes[1].fields.suggested_labels.reverse(); rebalance(v)
  assert.equal(validReviewBundle(v), true)
  assert.equal(v.comparison[0].status, 'FIELDS_MATCH')
  v.comparison[0].status = 'FIELDS_DIFFER'; v.comparison[0].differing_fields = ['suggested_labels']; assert.equal(validReviewBundle(v), false)
})
test('all history not only latest two opinions determines differences in fixed field order', () => {
  const v = bundle([3]); Object.assign(v.cases[0].notes[0].fields, { decision: 'NEEDS_REVISION', context_sufficiency: 'INSUFFICIENT', suggested_labels: [] }); rebalance(v)
  assert.equal(validReviewBundle(v), true)
  assert.deepEqual(v.comparison[0].differing_fields, ['decision', 'context_sufficiency', 'suggested_labels'])
  v.comparison[0].differing_fields.reverse(); assert.equal(validReviewBundle(v), false)
})
test('different names prose or rationale cannot certify or fabricate field disagreement', () => {
  const v = bundle([2]); Object.assign(v.cases[0].notes[1].fields, { reviewer: '另一自填署名', rationale: '另一个解释', source_basis: '另一个注本', alternatives: '另一表达' }); rebalance(v)
  assert.equal(validReviewBundle(v), true); assert.equal(v.comparison[0].status, 'FIELDS_MATCH')
})
test('supplied comparison must match derived state count and fields exactly', () => {
  const changes = [v => v.comparison[0].status = 'FIELDS_MATCH', v => v.comparison[1].note_count = 2, v => v.comparison[2].differing_fields = ['decision'], v => v.comparison[2].reviewer_count = 2, v => v.comparison[2].case_id = 'other', v => v.queue.notes_total = 10, v => v.queue.items[2].decision = 'ACCEPTABLE']
  for (const change of changes) { const v = bundle(); change(v); assert.equal(validReviewBundle(v), false) }
})
test('bounded response decodes UTF-8 across stream chunks and validates before download', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(bundle()))
  const response = new Response(new ReadableStream({ start(controller) { for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7)); controller.close() } }))
  assert.deepEqual(await readReviewBundle(response), bundle())
  for (const text of ['[]', 'null', '{broken', JSON.stringify({ ...bundle(), may_update_learning: true })]) await assert.rejects(readReviewBundle(new Response(text)), /INVALID_RESPONSE/)
  await assert.rejects(readReviewBundle(new Response(new Uint8Array([0xff]))), /INVALID_RESPONSE/)
})
test('8 MiB hard cap applies even if Content-Length lies or is missing and cancels stream', async () => {
  let cancelled = 0
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(reviewBundleLimit)); controller.enqueue(new Uint8Array(1)) }, cancel() { cancelled++ } }), { headers: { 'Content-Length': '1' } })
  await assert.rejects(readReviewBundle(response), /AI_REVIEW_EXPORT_TOO_LARGE/); assert.equal(cancelled, 1)
  await assert.rejects(readReviewBundle(new Response('{}', { headers: { 'Content-Length': String(reviewBundleLimit + 1) } })), /AI_REVIEW_EXPORT_TOO_LARGE/)
})
test('export transport maps server 413 without reading large error bodies and never retries', async () => {
  const aiReasonReviewApi = await importApi()
  const oldFetch = globalThis.fetch; let calls = 0, cancelled = 0
  globalThis.fetch = async (url, options) => { calls++; assert.equal(url, '/api/v1/admin/ai-reason-review/export'); assert.equal(options.method, undefined); return new Response(new ReadableStream({ cancel() { cancelled++ } }), { status: 413 }) }
  try { await assert.rejects(aiReasonReviewApi.exportBundle(), error => error.message === 'AI_REVIEW_EXPORT_TOO_LARGE' && error.status === 413); assert.equal(calls, 1); assert.equal(cancelled, 1) }
  finally { globalThis.fetch = oldFetch }
})
test('export transport preserves explicit abort and refuses a late successful response without decoding it', async () => {
  const api = await importApi(), oldFetch = globalThis.fetch
  let calls = 0, resolveFetch, cancelled = 0, requestSignal
  globalThis.fetch = async (_url, options) => { calls++; requestSignal = options.signal; return new Promise(resolve => { resolveFetch = resolve }) }
  try {
    const before = new AbortController(); before.abort()
    await assert.rejects(api.exportBundle(before.signal), error => error.name === 'AbortError'); assert.equal(calls, 0)
    const controller = new AbortController(), result = api.exportBundle(controller.signal)
    controller.abort(); assert.equal(requestSignal.aborted, true)
    // Simulate a transport that delivers a response even after cancellation.
    resolveFetch(new Response(new ReadableStream({ cancel() { cancelled++ } })))
    await assert.rejects(result, error => error.name === 'AbortError'); assert.equal(calls, 1); assert.equal(cancelled, 1)
  } finally { globalThis.fetch = oldFetch }
})
test('export panel cancellation releases working lock, rejects late download, and allows explicit retry', async () => {
  // Lightweight hook harness exercises the component handlers/lifecycle; browser layout is checked separately.
  const ui = await readFile(new URL('../src/components/AIReasonReviewWorkbench.tsx', import.meta.url), 'utf8')
  const panel = ui.slice(ui.indexOf('function ReviewBundleExport('), ui.indexOf('\nexport function AIReasonReviewWorkbench'))
  const slots = []; let cursor = 0, resolveRequest, calls = 0, downloads = 0
  const working = [], cleanup = []
  const h = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useEffect(effect) { const index = cursor++; if (!(index in slots)) { slots[index] = true; cleanup.push(effect()) } },
    api: { exportBundle: async () => { calls++; return new Promise(resolve => { resolveRequest = resolve }) } },
    download: () => { downloads++ }, counts: reviewBundleCounts,
  }
  globalThis.__reviewExportHarness = h
  const code = `const h = globalThis.__reviewExportHarness; const { useState, useRef, useEffect } = h; const aiReasonReviewApi = h.api; const downloadReviewBundle = h.download; const reviewBundleCounts = h.counts; const time = value => value; const message = error => error.message; const React = { createElement: (type, props, ...children) => ({type, props: {...props, children}}) }; ${panel.replace('function ReviewBundleExport(', 'export function ReviewBundleExport(')}`
  const output = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.React }, fileName: 'panel.tsx' }).outputText
  const { ReviewBundleExport } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props.children) : String(node ?? '')
  const find = (node, predicate) => { if (Array.isArray(node)) { for (const child of node) { const result = find(child, predicate); if (result) return result } } else if (node && typeof node === 'object') { if (predicate(node)) return node; return find(node.props.children, predicate) } }
  const render = () => { cursor = 0; return ReviewBundleExport({ blockedReason: null, onWorkingChange: value => working.push(value), onSelectCase: () => {} }) }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  try {
    let tree = render(); find(tree, n => n.type === 'input').props.onChange({ target: { checked: true } })
    tree = render(); find(tree, n => n.type === 'button' && text(n).includes('下载教研交接包')).props.onClick()
    tree = render(); find(tree, n => n.type === 'button' && text(n) === '取消整理').props.onClick()
    resolveRequest(bundle()); await settle(); tree = render()
    assert.equal(downloads, 0); assert.deepEqual(working, [true, false]); assert.match(text(tree), /已取消读取，未发起下载/)
    const retry = find(tree, n => n.type === 'button' && text(n).includes('下载教研交接包')); assert.equal(retry.props.disabled, false)
    retry.props.onClick(); tree = render(); assert.doesNotMatch(text(tree), /已取消读取，未发起下载/)
    resolveRequest(bundle()); await settle(); assert.equal(downloads, 1); assert.equal(calls, 2); assert.deepEqual(working, [true, false, true, false])
  } finally { for (const dispose of cleanup) dispose?.(); delete globalThis.__reviewExportHarness }
})
test('explicit download uses static filename UTF-8 JSON and revokes object URL on success or failure', () => {
  const oldDocument = globalThis.document, oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL
  const events = []; let fail = false
  URL.createObjectURL = blob => { assert.equal(blob.type, 'application/json;charset=utf-8'); events.push('create'); return 'blob:fixture' }
  URL.revokeObjectURL = url => { assert.equal(url, 'blob:fixture'); events.push('revoke') }
  globalThis.document = { body: { append() { events.push('append') } }, createElement() { return { click() { assert.equal(this.download, 'wenyan-ai-review-bundle.json'); assert.equal(this.href, 'blob:fixture'); events.push('click'); if (fail) throw new Error('browser-blocked') }, remove() { events.push('remove') } } } }
  try {
    downloadReviewBundle(bundle()); assert.deepEqual(events, ['create', 'append', 'click', 'remove', 'revoke'])
    events.length = 0; fail = true; assert.throws(() => downloadReviewBundle(bundle()), /browser-blocked/); assert.deepEqual(events, ['create', 'append', 'click', 'remove', 'revoke'])
    events.length = 0; assert.throws(() => downloadReviewBundle({ ...bundle(), contains_self_entered_names: false }), /INVALID_RESPONSE/); assert.equal(events.length, 0)
  } finally { globalThis.document = oldDocument; URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke }
})
test('panel requires explicit privacy acknowledgement and download click while preserving draft recovery protections', async () => {
  const ui = await readFile(new URL('../src/components/AIReasonReviewWorkbench.tsx', import.meta.url), 'utf8')
  const api = await readFile(new URL('../src/aiReasonReviewApi.ts', import.meta.url), 'utf8')
  assert.match(ui, /JSON 文件包含自填署名和意见/)
  assert.match(ui, /if \(blockedReason \|\| !acknowledged \|\| lock\.current\) return/)
  assert.match(ui, /onClick=\{\(\) => void download\(\)\}/)
  assert.match(ui, /字段相同不代表教师一致或语义正确/)
  assert.match(ui, /onSelectCase=\{id => void open\(id\)\}/)
  assert.match(ui, /if \(blocked \|\| lock\.current\) return/)
  assert.match(ui, /if \(dirty && !confirmed\) \{\s*confirmation\.ask\(\{/)
  assert.match(ui, /pending \? '请先按原标识确认提交结果/)
  assert.match(ui, /dirty \? '有未保存意见/)
  assert.match(ui, /alive\.current \|\| abort\.signal\.aborted/)
  assert.equal((ui.match(/aiReasonReviewApi\.exportBundle\(/g) ?? []).length, 1)
  assert.equal((ui.match(/downloadReviewBundle\(bundle\)/g) ?? []).length, 1)
  assert.match(api, /readReviewBundle\(response\)/)
  assert.doesNotMatch(api.split('async exportBundle')[1].split('async list')[0], /method: 'POST'|setInterval|retry/)
})


test('actual case-opening handler and confirmation controller preserve dirty drafts until explicit confirmation', async () => {
  const componentSource = await readFile(new URL('../src/components/AIReasonReviewWorkbench.tsx', import.meta.url), 'utf8')
  const tree = ts.createSourceFile('AIReasonReviewWorkbench.tsx', componentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const component = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'AIReasonReviewWorkbench')
  const open = component?.body?.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'open')
  assert.ok(open, 'actual component case-opening handler is present')
  const confirmationSource = await readFile(new URL('../src/components/confirmation.ts', import.meta.url), 'utf8')
  const { createConfirmationController } = await import(moduleUrl(confirmationSource))
  const wrapper = `export function create(h) {
    const {blocked, dirty, lock, confirmation, setBusy, setDetail, setError, setNotice, setRevealed,
      controller, aiReasonReviewApi, alive, setFields, emptyReviewFields, heading, message} = h;
    const requestAnimationFrame = () => 0;
    ${open.getText(tree)}
    return open;
  }`
  const { create } = await import(moduleUrl(wrapper))
  const setup = ({ blocked = false, dirty = true, locked = false, fail = false } = {}) => {
    const realConfirmation = createConfirmationController(), calls = [], updates = []
    const h = { blocked, dirty, lock: { current: locked }, controller: { current: null }, alive: { current: true }, heading: { current: null },
      confirmation: { ask(request) { calls.push(['ask', request]); return realConfirmation.request(request) } },
      aiReasonReviewApi: { async get(id) { calls.push(['get', id]); if (fail) throw new Error('synthetic-read-failed'); return { case_id: id } } },
      setBusy: value => updates.push(['busy', value]), setDetail: value => updates.push(['detail', value]),
      setError: value => updates.push(['error', value]), setNotice: value => updates.push(['notice', value]),
      setRevealed: value => updates.push(['revealed', value]), setFields: value => updates.push(['fields', value]),
      emptyReviewFields: () => ({ reviewer: '' }), message: reason => reason.message }
    return { h, calls, updates, confirm: realConfirmation, open: create(h) }
  }
  const blocked = setup({ blocked: true }); await blocked.open('case-a'); assert.deepEqual(blocked.calls, []); assert.deepEqual(blocked.updates, [])
  const locked = setup({ locked: true }); await locked.open('case-a'); assert.deepEqual(locked.calls, []); assert.deepEqual(locked.updates, [])
  const cancelled = setup(); await cancelled.open('case-b'); assert.equal(cancelled.calls[0][0], 'ask')
  assert.match(cancelled.calls[0][1].message, /有未保存的样例核对意见/)
  assert.equal(cancelled.calls.filter(call => call[0] === 'get').length, 0); assert.equal(cancelled.updates.some(update => update[0] === 'fields'), false)
  assert.equal(cancelled.confirm.resolve(false), true); assert.equal(cancelled.calls.filter(call => call[0] === 'get').length, 0)
  assert.equal(cancelled.updates.some(update => update[0] === 'fields'), false)
  await cancelled.open('case-b'); assert.equal(cancelled.confirm.resolve(true), true); assert.equal(cancelled.confirm.resolve(true), false)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(cancelled.calls.filter(call => call[0] === 'get'), [['get', 'case-b']])
  assert.deepEqual(cancelled.updates.filter(update => update[0] === 'fields'), [['fields', { reviewer: '' }]])
  const stale = setup(); await stale.open('case-c'); stale.h.lock.current = true; stale.confirm.resolve(true); await new Promise(resolve => setImmediate(resolve))
  assert.equal(stale.calls.filter(call => call[0] === 'get').length, 0); assert.equal(stale.updates.some(update => update[0] === 'fields'), false)
  const failed = setup({ dirty: false, fail: true }); await failed.open('case-d')
  assert.deepEqual(failed.calls.filter(call => call[0] === 'get'), [['get', 'case-d']]); assert.equal(failed.updates.some(update => update[0] === 'fields'), false)
  assert.ok(failed.updates.some(update => update[0] === 'error' && update[1] === 'synthetic-read-failed'))
})
