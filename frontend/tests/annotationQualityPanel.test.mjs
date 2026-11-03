import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

// Execute the shipped component with deterministic React hook/effect lifecycles.
// No DOM dependency, real account, database, credentials or network is needed.
const source = await readFile(new URL('../src/components/AnnotationQualityPanel.tsx', import.meta.url), 'utf8')
const compile = value => ts.transpileModule(value, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const moduleUrl = value => `data:text/javascript;base64,${Buffer.from(value).toString('base64')}`
const hooksUrl = moduleUrl(['useEffect', 'useId', 'useRef', 'useState'].map(name => `export const ${name} = (...args) => globalThis.__annotationQualityHooks.${name}(...args);`).join('\n'))
const apiUrl = moduleUrl('export const readAnnotationQuality = (...args) => globalThis.__annotationQualityRead(...args);')
const httpUrl = moduleUrl(compile(await readFile(new URL('../src/http.ts', import.meta.url), 'utf8')))
let js = compile(source).replace(/import ['"]\.\/annotationQuality\.css['"];?/, '')
for (const [from, to] of [['react', hooksUrl], ['react/jsx-runtime', import.meta.resolve('react/jsx-runtime')], ['../annotationQualityApi', apiUrl], ['../http', httpUrl]]) {
  js = js.replaceAll(`'${from}'`, JSON.stringify(to)).replaceAll(`"${from}"`, JSON.stringify(to))
}
const { AnnotationQualityPanel } = await import(moduleUrl(js))
const documentId = 'baac4b56-38e4-41dd-92d4-c2d2e7327c90'
const fixture = (source = '合成原文') => ({
  version: 'annotation-quality-v1',
  totals: { documents: 1, annotations: 7, draft: 4, approved: 3, missing_citation: 2, missing_source_url: 5 },
  documents: [{ id: documentId, source, annotations: 7, draft: 4, approved: 3, missing_citation: 2, missing_source_url: 5 }],
})
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const pause = () => new Promise(resolve => setImmediate(resolve))
function all(node) { if (!node || typeof node !== 'object') return []; return [node, ...(Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).flatMap(all)] }
function text(node) { if (node == null || typeof node === 'boolean') return ''; if (typeof node !== 'object') return String(node); return (Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).map(text).join('') }
const button = (tree, name) => { const result = all(tree).find(node => node.type === 'button' && text(node) === name); assert.ok(result, name); return result }
// Native disabled buttons do not dispatch click events; model that DOM contract
// while separately asserting the actual rendered `disabled` property.
const click = node => { if (!node.props.disabled) node.props.onClick() }
function createHost(props) {
  const slots = [], effects = []
  let cursor = 0, changed = true, tree, disposed = false, lateWrites = 0
  const hooks = {
    useState(initial) { const at = cursor++; if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial; return [slots[at], value => { if (disposed) { lateWrites++; return }; const next = typeof value === 'function' ? value(slots[at]) : value; if (!Object.is(next, slots[at])) { slots[at] = next; changed = true } }] },
    useRef(initial) { return slots[cursor++] ??= { current: initial } },
    useId() { const at = cursor++; return slots[at] ??= `synthetic-quality-${at}` },
    useEffect(effect, deps) { const at = cursor++, old = slots[at]; if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) { const next = { deps, cleanup: old?.cleanup }; slots[at] = next; effects.push(() => { next.cleanup?.(); next.cleanup = effect() }) } },
    flush() { let count = 0; do { assert.ok(++count < 20, 'hooks settle'); changed = false; cursor = 0; globalThis.__annotationQualityHooks = hooks; tree = AnnotationQualityPanel(props); while (effects.length) effects.shift()() } while (changed); return tree },
    async settle() { await pause(); return hooks.flush() },
    dispose() { disposed = true; for (const slot of slots) slot?.cleanup?.() },
    get lateWrites() { return lateWrites },
  }
  return hooks
}

test('actual quality panel begins loading, then displays exact nonzero totals and guarded queue entry', async () => {
  const pending = deferred(), chosen = [], signals = []
  globalThis.__annotationQualityRead = signal => { signals.push(signal); return pending.promise }
  const host = createHost({ refreshKey: 0, onChooseDocument: id => chosen.push(id) })
  try {
    let tree = host.flush()
    assert.match(text(tree), /正在读取当前版本的审核待办/)
    assert.equal(tree.props['aria-busy'], true)
    assert.equal(button(tree, '刷新概览').props.disabled, true)
    assert.equal(all(tree).some(node => node.type === 'dl'), false)
    pending.resolve(fixture()); tree = await host.settle()
    assert.equal(tree.props['aria-busy'], false)
    assert.deepEqual(all(tree).filter(node => node.type === 'dd').map(node => node.props.children), [7, 4, 3, 2, 5])
    assert.match(text(tree), /不评判注释真伪/); assert.match(text(tree), /不能替代释义出处/); assert.match(text(tree), /不能相加/)
    assert.equal(button(tree, '查看待审').props['aria-label'], '查看合成原文的待审注释')
    click(button(tree, '查看待审')); assert.deepEqual(chosen, [documentId])
    assert.equal(signals.length, 1); assert.equal(signals[0].aborted, false)
  } finally { host.dispose() }
})

test('failed read shows explicit unavailable state instead of fake zero totals and retries only on request', async () => {
  let calls = 0
  globalThis.__annotationQualityRead = async () => { calls++; if (calls === 1) throw new Error('合成读取失败'); return fixture() }
  const host = createHost({ refreshKey: 0, onChooseDocument() {} })
  try {
    host.flush(); let tree = await host.settle()
    assert.match(text(all(tree).find(node => node.props?.role === 'alert')), /概览暂不可用.*合成读取失败/)
    assert.equal(all(tree).some(node => node.type === 'dl' || node.type === 'dd'), false)
    assert.equal(text(tree).includes('没有已入库'), false)
    await host.settle(); assert.equal(calls, 1)
    assert.equal(button(tree, '刷新概览').props.disabled, false)
    click(button(tree, '刷新概览')); tree = host.flush()
    assert.match(text(tree), /正在读取/)
    tree = await host.settle(); assert.equal(calls, 2)
    assert.deepEqual(all(tree).filter(node => node.type === 'dd').map(node => node.props.children), [7, 4, 3, 2, 5])
  } finally { host.dispose() }
})

test('refresh aborts and invalidates obsolete results even when transport ignores cancellation', async () => {
  const first = deferred(), second = deferred(), signals = []
  globalThis.__annotationQualityRead = signal => { signals.push(signal); return signals.length === 1 ? first.promise : second.promise }
  const props = { refreshKey: 0, onChooseDocument() {} }, host = createHost(props)
  try {
    host.flush(); props.refreshKey = 1; let tree = host.flush()
    assert.equal(signals.length, 2); assert.equal(signals[0].aborted, true)
    second.resolve(fixture('新版本材料')); tree = await host.settle()
    assert.match(text(tree), /新版本材料/)
    first.resolve(fixture('旧版本材料')); tree = await host.settle()
    assert.match(text(tree), /新版本材料/); assert.doesNotMatch(text(tree), /旧版本材料/)
    assert.equal(tree.props['aria-busy'], false)
  } finally { host.dispose() }
})

test('unmount aborts pending read and both late success/failure avoid state updates', async () => {
  for (const outcome of ['success', 'error']) {
    const pending = deferred(); let signal
    globalThis.__annotationQualityRead = value => { signal = value; return pending.promise }
    const host = createHost({ refreshKey: 0, onChooseDocument() {} })
    host.flush(); host.dispose(); assert.equal(signal.aborted, true)
    if (outcome === 'success') pending.resolve(fixture()); else pending.reject(new Error('合成晚到错误'))
    await pause(); assert.equal(host.lateWrites, 0)
  }
})

test('disabled panel retains overview but disables manual refresh and document navigation', async () => {
  let calls = 0, chosen = []
  globalThis.__annotationQualityRead = async () => { calls++; return fixture() }
  const props = { refreshKey: 0, disabled: true, onChooseDocument: id => chosen.push(id) }, host = createHost(props)
  try {
    host.flush(); let tree = await host.settle()
    assert.equal(button(tree, '刷新概览').props.disabled, true); assert.equal(button(tree, '查看待审').props.disabled, true)
    click(button(tree, '刷新概览')); click(button(tree, '查看待审')); await host.settle()
    assert.equal(calls, 1); assert.deepEqual(chosen, [])
    props.disabled = false; tree = host.flush()
    assert.equal(button(tree, '刷新概览').props.disabled, false); assert.equal(button(tree, '查看待审').props.disabled, false)
    click(button(tree, '查看待审')); assert.deepEqual(chosen, [documentId])
    click(button(tree, '刷新概览')); host.flush(); await host.settle(); assert.equal(calls, 2)
  } finally { host.dispose() }
})

test('honest empty state is distinct from complete review, and zero-draft material has no active queue entry', async () => {
  const empty = { version: 'annotation-quality-v1', totals: { documents: 0, annotations: 0, draft: 0, approved: 0, missing_citation: 0, missing_source_url: 0 }, documents: [] }
  globalThis.__annotationQualityRead = async () => empty
  const props = { refreshKey: 0, onChooseDocument() { assert.fail('no pending queue') } }, host = createHost(props)
  try {
    host.flush(); let tree = await host.settle(); assert.match(text(tree), /没有数据不表示已经完成审核/)
    assert.equal(all(tree).some(node => node.type === 'dl'), false)
    const reviewed = fixture(); reviewed.totals.draft = 0; reviewed.totals.approved = 7; reviewed.documents[0].draft = 0; reviewed.documents[0].approved = 7
    globalThis.__annotationQualityRead = async () => reviewed
    props.refreshKey = 1; host.flush(); tree = await host.settle()
    assert.equal(button(tree, '查看待审').props.disabled, true); click(button(tree, '查看待审'))
  } finally { host.dispose() }
})

test('gap counts locate exact missing fields across all registration states, with zero and busy actions guarded', async () => {
  const chosen = [], gaps = [], value = fixture()
  value.totals.draft = 0; value.totals.approved = 7; value.documents[0].draft = 0; value.documents[0].approved = 7
  value.totals.missing_source_url = 0; value.documents[0].missing_source_url = 0
  let reads = 0
  globalThis.__annotationQualityRead = async () => { reads++; return structuredClone(value) }
  const props = { refreshKey: 0, disabled: false, onChooseDocument: id => chosen.push(id), onChooseGap: (id, gap) => gaps.push([id, gap]) }, host = createHost(props)
  const gapButton = (tree, key) => { const result = all(tree).find(node => node.type === 'button' && node.props['aria-label']?.includes(key)); assert.ok(result); return result }
  try {
    host.flush(); let tree = await host.settle()
    assert.equal(button(tree, '查看待审').props.disabled, true)
    assert.equal(gapButton(tree, '缺注释出处').props.disabled, false)
    gapButton(tree, '缺注释出处').props.onClick(); assert.deepEqual(gaps, [[documentId, 'MISSING_CITATION']])
    assert.equal(gapButton(tree, '缺来源链接').props.disabled, true)
    gapButton(tree, '缺来源链接').props.onClick(); assert.equal(gaps.length, 1)
    props.disabled = true; tree = host.flush()
    assert.equal(gapButton(tree, '缺注释出处').props.disabled, true)
    gapButton(tree, '缺注释出处').props.onClick(); gapButton(tree, '缺来源链接').props.onClick(); button(tree, '查看待审').props.onClick(); button(tree, '刷新概览').props.onClick()
    await host.settle(); assert.equal(gaps.length, 1); assert.deepEqual(chosen, []); assert.equal(reads, 1)
    props.disabled = false; value.documents[0].missing_source_url = 5; value.totals.missing_source_url = 5; tree = host.flush()
    button(tree, '刷新概览').props.onClick(); host.flush(); tree = await host.settle()
    gapButton(tree, '缺来源链接').props.onClick(); assert.deepEqual(gaps[1], [documentId, 'MISSING_SOURCE_URL'])
    assert.match(text(tree), /已署名条目也可能缺资料/)
  } finally { host.dispose() }
})

test('legacy overview without gap callback retains plain counts and the original pending-review entry', async () => {
  let chosen = []
  globalThis.__annotationQualityRead = async () => fixture()
  const host = createHost({ refreshKey: 0, onChooseDocument: id => chosen.push(id) })
  try {
    host.flush(); const tree = await host.settle()
    assert.equal(all(tree).filter(node => node.type === 'button' && node.props['aria-label']?.includes('缺')).length, 0)
    button(tree, '查看待审').props.onClick(); assert.deepEqual(chosen, [documentId])
  } finally { host.dispose() }
})
