import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = path => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')
const compile = value => ts.transpileModule(value, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const url = value => `data:text/javascript;base64,${Buffer.from(value).toString('base64')}`
const httpUrl = url(compile(await source('http.ts')))
const { RequestError } = await import(httpUrl)
const controllerModule = await import(url(compile(await source('components/confirmation.ts'))))
globalThis.__editorialController = controllerModule.createConfirmationController
const hooksUrl = url(['useState', 'useRef', 'useEffect', 'useCallback'].map(name => `export const ${name} = (...args) => globalThis.__editorialHooks.${name}(...args);`).join('\n'))
const confirmUrl = url(`export function useConfirmationDialog() {
  const controller = globalThis.__editorialHooks.useRef(globalThis.__editorialController());
  return { modal: null, ask(request) { if (controller.current.request(request)) { globalThis.__editorialQuestion = request; globalThis.__editorialResolve = accepted => { globalThis.__editorialQuestion = null; controller.current.resolve(accepted) } } } };
}`)
const apiUrl = url(`export const knowledgeApi = { coverage: (...args) => globalThis.__editorialApi.coverage(...args) }; export const annotationApi = Object.fromEntries(['list','get','edit','review'].map(name => [name, (...args) => globalThis.__editorialApi[name](...args)]));`)
const panelUrl = url('export function AnnotationQualityPanel() { return null }')
const comparisonPanelUrl = url('export function AnnotationComparisonPanel() { return null }')
const packetPanelUrl = url('export function AnnotationPacketPanel() { return null }')
const evidencePanelUrl = url('export function KnowledgeEvidencePanel() { return null }')
const original = await source('components/KnowledgeWorkbench.tsx')
let js = compile(original).replace(/import ['"]\.\/knowledgeWorkbench\.css['"];?/, '')
for (const [from, to] of [['react', hooksUrl], ['react/jsx-runtime', import.meta.resolve('react/jsx-runtime')], ['../api', apiUrl], ['../http', httpUrl], ['./ConfirmationDialog', confirmUrl], ['./AnnotationQualityPanel', panelUrl], ['./AnnotationComparisonPanel', comparisonPanelUrl], ['./AnnotationPacketPanel', packetPanelUrl], ['./KnowledgeEvidencePanel', evidencePanelUrl]]) js = js.replaceAll(`'${from}'`, JSON.stringify(to)).replaceAll(`"${from}"`, JSON.stringify(to))
const { KnowledgeWorkbench, AdminWorkbench } = await import(url(js))

function host(render) {
  const slots = [], effects = []
  let cursor = 0, changed = true, tree, disposed = false, lateWrites = 0
  const hooks = {
    useState(initial) { const at = cursor++; if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial; return [slots[at], value => { if (disposed) { lateWrites++; return }; const next = typeof value === 'function' ? value(slots[at]) : value; if (!Object.is(next, slots[at])) { slots[at] = next; changed = true } }] },
    useRef(initial) { return slots[cursor++] ??= { current: initial } },
    useCallback(fn) { cursor++; return fn },
    useEffect(effect, deps) { const at = cursor++, old = slots[at]; if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) { const next = { deps, cleanup: old?.cleanup }; slots[at] = next; effects.push(() => { next.cleanup?.(); next.cleanup = effect() }) } },
    flush() { let count = 0; do { assert.ok(++count < 20, 'hooks settle'); changed = false; cursor = 0; globalThis.__editorialHooks = hooks; tree = render(); while (effects.length) effects.shift()() } while (changed); return tree },
    dispose() { disposed = true; for (const slot of slots) slot?.cleanup?.() },
    get lateWrites() { return lateWrites },
  }
  return hooks
}
function elements(node) { if (!node || typeof node !== 'object') return []; return [node, ...(Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).flatMap(elements)] }
function text(node) { if (node == null || typeof node === 'boolean') return ''; if (typeof node !== 'object') return String(node); return (Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).map(text).join('') }
function button(tree, name) { const value = elements(tree).find(node => node.type === 'button' && text(node) === name); assert.ok(value, `button ${name}`); return value }
function field(tree, name) { const label = elements(tree).find(node => node.type === 'label' && text(node).startsWith(name)); assert.ok(label, `label ${name}`); return elements(label).find(node => ['input','textarea','select'].includes(node.type)) }
const pause = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const annotation = (id = 'word-one', overrides = {}) => ({ id, document_id: 'doc-one', source: '合成原文', paragraph_index: 0, start: 0, end: 1, token: id === 'word-one' ? '假' : '于', sentence: '善假于物也。', version: 0, meaning: '借助', part_of_speech: '动词', variability: 'CONTEXTUAL', reasoning: '根据本句施受关系核对', source_url: 'https://example.org/source', citation: '合成注释，第 1 页', status: 'DRAFT', sense_key: 'synthetic', ...overrides })
const detail = (id, overrides) => ({ annotation: annotation(id, overrides), history: [] })
const qualityPanel = tree => { const result = elements(tree).find(node => typeof node.type === 'function' && node.type.name === 'AnnotationQualityPanel'); assert.ok(result, 'quality panel exists'); return result }
async function setup(overrides = {}) {
  const calls = [], risks = []
  const api = {
    coverage: async () => ({ documents: [{ id: 'doc-one', source: '合成原文', total_annotations: 30 }, { id: 'doc-two', source: '另一原文', total_annotations: 1 }] }),
    list: async (...args) => { calls.push(['list', ...args]); return { total: 30, items: [annotation(), annotation('word-two')] } },
    get: async (...args) => { calls.push(['get', ...args]); return detail(args[0]) },
    edit: async (...args) => { calls.push(['edit', ...args]); const [id, version, fields, actor, note] = args; return { annotation: annotation(id, { ...fields, version: version + 1 }), history: [{ version: version + 1, action: 'EDIT', actor, note, payload: { ...fields, status: 'DRAFT' } }] } },
    review: async (...args) => { calls.push(['review', ...args]); const [id, version, actor, note] = args; return { annotation: annotation(id, { status: 'APPROVED', version: version + 1, reviewer: actor }), history: [{ version: version + 1, action: 'REVIEW', actor, note, payload: { ...annotation(id), status: 'APPROVED' } }] } },
    ...overrides,
  }
  globalThis.__editorialApi = api; globalThis.__editorialQuestion = null
  const onExitRiskChange = risk => risks.push(risk)
  const instance = host(() => KnowledgeWorkbench({ onExitRiskChange }))
  let tree
  const settle = async () => { tree = instance.flush(); await pause(); tree = instance.flush(); await pause(); tree = instance.flush(); return tree }
  const click = name => button(tree, name).props.onClick()
  const change = (name, value) => { field(tree, name).props.onChange({ target: { value } }); tree = instance.flush() }
  const open = async (id = 'word-one') => { elements(tree).find(node => node.type === 'button' && node.props?.onClick && text(node).startsWith(id === 'word-one' ? '假' : '于')).props.onClick(); await settle() }
  const submit = () => elements(tree).find(node => node.type === 'form' && text(node).includes('校订当前注释')).props.onSubmit({ preventDefault() {} })
  await settle()
  return { api, instance, calls, risks, settle, click, change, open, submit, get tree() { return tree } }
}

test('actual editor dirty filters cancel without losing identity, then confirm clears stale form and filters', async () => {
  const ui = await setup()
  try {
    await ui.open(); ui.change('本句释义', '修改后的草稿')
    ui.change('审核状态', 'DRAFT')
    assert.ok(globalThis.__editorialQuestion); assert.equal(field(ui.tree, '审核状态').props.value, 'ALL')
    globalThis.__editorialResolve(false); await ui.settle()
    assert.equal(field(ui.tree, '本句释义').props.value, '修改后的草稿')
    ui.change('审核状态', 'DRAFT'); globalThis.__editorialResolve(true); globalThis.__editorialResolve(true); await ui.settle()
    assert.equal(field(ui.tree, '审核状态').props.value, 'DRAFT')
    assert.equal(elements(ui.tree).some(node => node.type === 'textarea'), false)
    assert.equal(ui.calls.filter(call => call[0] === 'list' && call[2] === 'DRAFT').length, 1)
    assert.equal(ui.risks.at(-1), null)
  } finally { ui.instance.dispose() }
})

test('actor and note-only drafts require confirmation; successful save clears note but retains actor', async () => {
  const ui = await setup()
  try {
    await ui.open(); ui.change('编辑／审核人', '本机核对者')
    ui.click('下一页'); assert.ok(globalThis.__editorialQuestion); globalThis.__editorialResolve(false); await ui.settle()
    ui.change('本次说明', '本条的核对说明'); ui.click('重新读取当前版本'); assert.ok(globalThis.__editorialQuestion); globalThis.__editorialResolve(false)
    ui.change('本句释义', '借助外物'); ui.submit(); ui.submit(); await ui.settle()
    assert.equal(ui.calls.filter(call => call[0] === 'edit').length, 1)
    assert.equal(field(ui.tree, '本次说明').props.value, '')
    assert.equal(field(ui.tree, '编辑／审核人').props.value, '本机核对者')
    assert.equal(ui.risks.at(-1), null)
  } finally { ui.instance.dispose() }
})

test('cancelled and superseded detail reads cannot overwrite the new selection or write after unmount', async () => {
  const old = deferred(), fresh = deferred(), signals = []
  const ui = await setup({ get: (id, signal) => { signals.push(signal); return id === 'word-one' ? old.promise : fresh.promise } })
  try {
    await ui.open(); assert.equal(ui.risks.at(-1), 'working')
    ui.click('取消当前读取'); await ui.settle(); assert.equal(signals[0].aborted, true)
    await ui.open('word-two'); fresh.resolve(detail('word-two')); await ui.settle()
    old.resolve(detail('word-one')); await ui.settle()
    assert.match(text(ui.tree), /“于”的本句义/); assert.doesNotMatch(text(ui.tree), /“假”的本句义/)
    const last = deferred(); ui.api.get = () => last.promise; ui.click('重新读取当前版本'); await ui.settle()
    ui.instance.dispose(); last.resolve(detail('word-two')); await pause()
    assert.equal(ui.instance.lateWrites, 0)
  } finally { ui.instance.dispose() }
})

test('unknown write freezes queue and draft, reads only original ID, and requires matching normalized history', async () => {
  let writes = 0, gets = [], mode = 'initial', submitted
  const ui = await setup({
    edit: async (...args) => { writes++; submitted = args; throw new RequestError('NETWORK_ERROR') },
    get: async id => { gets.push(id); if (mode === 'initial') return detail(id); if (mode === 'missing') return detail(id); const [, version, fields, actor, note] = submitted; return { annotation: annotation(id, { ...fields, version: version + 1 }), history: [{ version: version + 1, action: 'EDIT', actor, note, payload: { ...fields, status: 'DRAFT' } }] } },
  })
  try {
    await ui.open(); ui.change('本句释义', '  借助外物  '); ui.change('编辑／审核人', '  合成核对者  '); ui.change('本次说明', '  合成来源记录  ')
    ui.submit(); await ui.settle(); assert.equal(ui.risks.at(-1), 'uncertain')
    assert.equal(field(ui.tree, '本句释义').props.value, '  借助外物  ')
    ui.change('原文', 'doc-two'); ui.submit(); await ui.settle(); assert.equal(writes, 1)
    assert.equal(field(ui.tree, '原文').props.value, 'doc-one'); assert.equal(gets.length, 1)
    mode = 'missing'; ui.click('核对上次提交（仅当前字词）'); await ui.settle(); assert.equal(ui.risks.at(-1), 'uncertain')
    assert.equal(field(ui.tree, '本次说明').props.value, '  合成来源记录  ')
    mode = 'matched'; ui.click('核对上次提交（仅当前字词）'); await ui.settle()
    assert.deepEqual(gets, ['word-one', 'word-one', 'word-one']); assert.equal(writes, 1)
    assert.equal(field(ui.tree, '本句释义').props.value, '借助外物'); assert.equal(field(ui.tree, '本次说明').props.value, '')
    assert.equal(ui.risks.at(-1), null)
  } finally { ui.instance.dispose() }
})

test('CAS conflict keeps copyable draft; reload only discards after confirmation', async () => {
  const ui = await setup({ edit: async () => { throw new RequestError('ANNOTATION_VERSION_CONFLICT', 409) } })
  try {
    await ui.open(); ui.change('本句释义', 'CAS 冲突草稿'); ui.change('编辑／审核人', '核对者'); ui.change('本次说明', '不能丢掉的说明'); ui.submit(); await ui.settle()
    assert.equal(field(ui.tree, '本句释义').props.value, 'CAS 冲突草稿'); assert.match(text(ui.tree), /查看并手动复制保留的草稿/)
    ui.click('重新读取当前版本'); globalThis.__editorialResolve(false); await ui.settle(); assert.equal(field(ui.tree, '本次说明').props.value, '不能丢掉的说明')
    ui.click('重新读取当前版本'); globalThis.__editorialResolve(true); await ui.settle(); assert.equal(field(ui.tree, '本次说明').props.value, '')
  } finally { ui.instance.dispose() }
})

test('HTTP 200 with old or unrelated version cannot discard draft; legitimate normalized no-op preserves unsaved note', async () => {
  for (const version of [0, 1, 4]) {
    const ui = await setup({ edit: async id => detail(id, { version }) })
    try {
      await ui.open(); ui.change('本句释义', '不能被旧响应覆盖'); ui.change('编辑／审核人', '核对者'); ui.change('本次说明', '保留本次说明'); ui.submit(); await ui.settle()
      assert.equal(ui.risks.at(-1), 'uncertain'); assert.equal(field(ui.tree, '本句释义').props.value, '不能被旧响应覆盖'); assert.equal(field(ui.tree, '本次说明').props.value, '保留本次说明')
    } finally { ui.instance.dispose() }
  }
  const ui = await setup({ edit: async id => detail(id) })
  try {
    await ui.open(); ui.change('本句释义', '  借助  '); ui.change('编辑／审核人', '核对者'); ui.change('本次说明', '仅去首尾空格'); ui.submit(); await ui.settle()
    assert.equal(ui.risks.at(-1), 'dirty'); assert.equal(field(ui.tree, '本次说明').props.value, '仅去首尾空格')
    assert.equal(field(ui.tree, '编辑／审核人').props.value, '核对者')
    assert.equal(field(ui.tree, '本句释义').props.value, '借助')
    assert.match(text(ui.tree), /本次说明和署名没有另行写入，请保留或复制/)
    assert.equal(button(ui.tree, '保存草稿版本').props.disabled, true)
    ui.click('重新读取当前版本'); assert.ok(globalThis.__editorialQuestion)
    globalThis.__editorialResolve(false); await ui.settle(); assert.equal(field(ui.tree, '本次说明').props.value, '仅去首尾空格')
  } finally { ui.instance.dispose() }
})

test('review confirmation is version-bound and double acceptance sends once; copy disclaims verified identity', async () => {
  const ui = await setup()
  try {
    await ui.open(); ui.change('编辑／审核人', '本机核对者'); ui.change('本次说明', '实际核对合成来源')
    ui.click('人工审核当前版本'); assert.match(globalThis.__editorialQuestion.message, /不验证教师身份/)
    ui.change('本次说明', '确认弹层打开后程序改变的说明'); globalThis.__editorialResolve(true); await ui.settle()
    assert.equal(ui.calls.filter(call => call[0] === 'review').length, 0)
    ui.click('人工审核当前版本'); globalThis.__editorialResolve(true); globalThis.__editorialResolve(true); await ui.settle()
    assert.equal(ui.calls.filter(call => call[0] === 'review').length, 1); assert.equal(field(ui.tree, '本次说明').props.value, '')
  } finally { ui.instance.dispose() }
})

test('overview gap entry protects draft on cancel then confirms ALL status, exact gap and cleared search/page', async () => {
  const ui = await setup()
  try {
    ui.change('审核状态', 'APPROVED'); await ui.settle()
    ui.change('查找字词', '假'); elements(ui.tree).find(node => node.type === 'form' && text(node).includes('查找字词')).props.onSubmit({ preventDefault() {} }); await ui.settle()
    ui.click('下一页'); await ui.settle(); await ui.open(); ui.change('本句释义', '缺口切换不可丢的草稿')
    const before = ui.calls.filter(call => call[0] === 'list').length
    qualityPanel(ui.tree).props.onChooseGap('doc-two', 'MISSING_CITATION'); assert.ok(globalThis.__editorialQuestion)
    globalThis.__editorialResolve(false); await ui.settle()
    assert.equal(field(ui.tree, '本句释义').props.value, '缺口切换不可丢的草稿'); assert.equal(field(ui.tree, '资料缺口').props.value, 'ALL')
    assert.equal(ui.calls.filter(call => call[0] === 'list').length, before)
    qualityPanel(ui.tree).props.onChooseGap('doc-two', 'MISSING_CITATION'); globalThis.__editorialResolve(true); await ui.settle()
    const last = ui.calls.filter(call => call[0] === 'list').at(-1)
    assert.equal(last[1], 'doc-two'); assert.equal(last[2], 'ALL'); assert.equal(last[3], ''); assert.equal(last[4], 0); assert.equal(last[6], 'MISSING_CITATION')
    assert.equal(field(ui.tree, '查找字词').props.value, ''); assert.equal(field(ui.tree, '资料缺口').props.value, 'MISSING_CITATION')
    assert.equal(elements(ui.tree).some(node => node.type === 'textarea'), false)
    qualityPanel(ui.tree).props.onChooseGap('doc-one', 'MISSING_SOURCE_URL'); await ui.settle()
    assert.equal(ui.calls.filter(call => call[0] === 'list').at(-1)[6], 'MISSING_SOURCE_URL')
    qualityPanel(ui.tree).props.onChooseDocument('doc-one'); await ui.settle()
    const pending = ui.calls.filter(call => call[0] === 'list').at(-1); assert.equal(pending[2], 'DRAFT'); assert.equal(pending[6], 'ALL')
  } finally { ui.instance.dispose() }
})

test('gap filtering and overview navigation are blocked while reading or unknown writing, retaining the same draft', async () => {
  const pending = deferred()
  const ui = await setup({ get: () => pending.promise, edit: async () => { throw new RequestError('NETWORK_ERROR') } })
  try {
    await ui.open(); assert.equal(qualityPanel(ui.tree).props.disabled, true)
    const listCount = ui.calls.filter(call => call[0] === 'list').length
    qualityPanel(ui.tree).props.onChooseGap('doc-two', 'MISSING_SOURCE_URL'); await ui.settle(); assert.equal(ui.calls.filter(call => call[0] === 'list').length, listCount)
    pending.resolve(detail('word-one')); await ui.settle(); ui.change('本句释义', '结果未确认时留住这段草稿'); ui.change('编辑／审核人', '核对者'); ui.change('本次说明', '缺口测试说明'); ui.submit(); await ui.settle()
    assert.equal(ui.risks.at(-1), 'uncertain'); assert.equal(qualityPanel(ui.tree).props.disabled, true)
    qualityPanel(ui.tree).props.onChooseGap('doc-two', 'MISSING_CITATION'); ui.change('资料缺口', 'MISSING_EITHER'); await ui.settle()
    assert.equal(field(ui.tree, '资料缺口').props.value, 'ALL'); assert.equal(field(ui.tree, '本句释义').props.value, '结果未确认时留住这段草稿')
    assert.equal(ui.calls.filter(call => call[0] === 'list').length, listCount)
  } finally { ui.instance.dispose() }
})

test('queue failure clears previous rows, retries only explicitly, and ignores obsolete success and unmounted late errors', async () => {
  const old = deferred(), newer = deferred(), last = deferred(), calls = []
  const ui = await setup({ list: (...args) => { calls.push(args); if (args[5] === 'ALL') return old.promise; if (args[5] === 'MISSING_CITATION') return newer.promise; return last.promise } })
  try {
    ui.change('资料缺口', 'MISSING_CITATION'); await ui.settle(); assert.equal(calls[0][4].aborted, true)
    newer.resolve({ total: 1, items: [annotation('newer', { token: '新' })] }); await ui.settle(); assert.match(text(ui.tree), /新待审核/)
    old.resolve({ total: 1, items: [annotation('old', { token: '旧' })] }); await ui.settle(); assert.doesNotMatch(text(ui.tree), /旧待审核/)
    ui.change('资料缺口', 'MISSING_SOURCE_URL'); await ui.settle(); assert.doesNotMatch(text(ui.tree), /新待审核/)
    last.reject(new RequestError('NETWORK_ERROR')); await ui.settle(); assert.match(text(ui.tree), /重新读取队列/); assert.doesNotMatch(text(ui.tree), /新待审核/)
    await ui.settle(); assert.equal(calls.length, 3)
    const pending = deferred(); ui.api.list = (...args) => { calls.push(args); return pending.promise }
    ui.click('重新读取队列'); await ui.settle(); assert.equal(calls.length, 4)
    ui.instance.dispose(); pending.reject(new RequestError('NETWORK_ERROR')); await pause(); assert.equal(ui.instance.lateWrites, 0)
  } finally { ui.instance.dispose() }
})

test('missing-field union selection and shrunk nonfirst queues have explicit first/valid previous page recovery', async () => {
  for (const remaining of [2, 0]) {
    const calls = []; let shrunk = false
    const ui = await setup({ list: async (...args) => { const offset = args[3]; calls.push(args); if (offset === 50) { shrunk = true; return { total: remaining, items: [] } }; return { total: shrunk ? remaining : 80, items: shrunk && remaining === 0 ? [] : [annotation()] } } })
    try {
      ui.change('资料缺口', 'MISSING_EITHER'); await ui.settle(); assert.equal(calls.at(-1)[5], 'MISSING_EITHER')
      ui.click('下一页'); await ui.settle(); ui.click('下一页'); await ui.settle()
      assert.equal(calls.at(-1)[3], 50); assert.match(text(ui.tree), /本页暂无注释，队列可能已变化/); assert.doesNotMatch(text(ui.tree), /第 51–50/)
      await ui.settle(); const count = calls.length; assert.ok(button(ui.tree, '返回第一页')); assert.equal(calls.length, count)
      if (remaining === 2) ui.click('上一页'); else ui.click('返回第一页')
      await ui.settle(); assert.equal(calls.at(-1)[3], 0)
      if (remaining === 0) assert.match(text(ui.tree), /没有结果不表示注释已通过审核/)
    } finally { ui.instance.dispose() }
  }
})

test('overview accepted location focuses the named queue once, but cancelled, blocked and late responses never steal focus', async () => {
  const ui = await setup(), focus = [], scroll = []
  try {
    const queue = elements(ui.tree).find(node => node.type === 'aside' && node.props['aria-label'] === '字词审核队列')
    assert.equal(queue.props.tabIndex, -1)
    queue.ref.current = { focus: options => focus.push(options), scrollIntoView: options => scroll.push(options) }
    await ui.open(); ui.change('本句释义', '取消不抢焦点的草稿')
    qualityPanel(ui.tree).props.onChooseGap('doc-two', 'MISSING_CITATION'); globalThis.__editorialResolve(false); await ui.settle()
    assert.equal(focus.length, 0); assert.equal(scroll.length, 0)
    const pending = deferred(); ui.api.list = () => pending.promise
    qualityPanel(ui.tree).props.onChooseGap('doc-two', 'MISSING_CITATION'); globalThis.__editorialResolve(true); await ui.settle()
    assert.deepEqual(focus, [{ preventScroll: true }]); assert.deepEqual(scroll, [{ block: 'start', behavior: 'instant' }])
    pending.resolve({ total: 0, items: [] }); await ui.settle(); assert.equal(focus.length, 1)
    ui.change('资料缺口', 'MISSING_EITHER'); await ui.settle(); assert.equal(focus.length, 1)
    const late = deferred(); ui.api.list = () => late.promise
    qualityPanel(ui.tree).props.onChooseDocument('doc-one'); await ui.settle(); assert.equal(focus.length, 2)
    ui.instance.dispose(); late.resolve({ total: 0, items: [] }); await pause(); assert.equal(focus.length, 2); assert.equal(ui.instance.lateWrites, 0)
  } finally { ui.instance.dispose() }
})
