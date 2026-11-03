import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { importSource } from './import-source.mjs'
const require = createRequire(import.meta.url)
const model = await importSource('guidedTraining.ts')
const reasoning = await importSource('reasoning.ts')
const drafts = await importSource('trainingDraft.ts')
const evidenceBasis = await importSource('evidenceBasis.ts')
const submission = await importSource('guidedSubmission.ts')
const base = { stage: 'CORE', completed: false, selected_answer: null, reasoning_graph: null, transfer_ready: false, summary_ready: false, source: '合成篇', passage: '善假于物', variable: '假', evidence: '于物', question: '假是什么意思？', choices: ['借助', '假装'], feedback: '先判断', state_version: 0, learning_trace: { stages: { CORE: { first_attempt: null, assistance_kinds: [] }, TRANSFER: { first_attempt: null, assistance_kinds: [] } } } }
const attempted = { ...base, selected_answer: '借助', state_version: 1, learning_trace: { ...base.learning_trace, stages: { ...base.learning_trace.stages, CORE: { first_attempt: { answer: '借助' }, assistance_kinds: [] } } } }
const payload = { basis_kind: 'CONTEXT', paragraph_index: 0, start: 1, end: 3, reason: '', conclusion: '借助' }
const saved = { ...attempted, state_version: 2, reasoning_graph: { conclusion: '借助', basis_kind: 'CONTEXT', evidence: { token: '于物', paragraph_index: 0, start: 1, end: 3 }, reason: '', stage: 'CORE' } }
function all(n) { return !n || typeof n !== 'object' ? [] : [n, ...[n.props?.children].flat(Infinity).flatMap(all)] }
function text(n) { return n == null || typeof n === 'boolean' ? '' : typeof n !== 'object' ? String(n) : [n.props?.children].flat(Infinity).map(text).join('') }
const button = (tree, name) => { const node = all(tree).find(n => n.type === 'button' && text(n) === name); assert.ok(node, name); return node }
const screen = tree => all(tree).filter(n => n.props?.['data-step'] && !n.props.hidden).map(n => n.props['data-step'])
const tick = () => new Promise(resolve => setImmediate(resolve))
async function host(session = base) {
  const source = await readFile(new URL('../src/components/GuidedTrainingPage.tsx', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const slots = [], effects = [], frames = [], calls = [], dirty = [], exports = {}, components = {}
  let cursor = 0, changed = true, tree
  const hooks = {
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = typeof value === 'function' ? value() : value; return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; changed = true } }] },
    useRef(value) { return slots[cursor++] ??= { current: value } }, useCallback(fn) { return fn },
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { const record = { deps, cleanup: old?.cleanup }; slots[i] = record; effects.push(() => { record.cleanup?.(); record.cleanup = fn() }) } },
  }
  new Function('require', 'exports', code)(path => {
    if (path === 'react') return hooks
    if (path === 'react/jsx-runtime') return require(path)
    if (path === '../guidedTraining') return model
    if (path === '../guidedSubmission') return submission
    if (path === '../reasoning') return reasoning
    if (path === '../trainingDraft') return drafts
    if (path === '../evidenceBasis') return evidenceBasis
    if (path === '../navigation') return { jumpTo: id => calls.push(['locate', id]) }
    if (path.endsWith('.css')) return {}
    const names = path === './ReasoningEditor' ? ['ReasoningEditor', 'ReasoningHistory'] : [path.split('/').at(-1)]
    return Object.fromEntries(names.map(name => [name, components[name] ??= () => null]))
  }, exports)
  const props = { sessionId: 'synthetic-session', session, busy: false, pendingCommand: null, recoveryNeeded: false, error: null, onRecover: () => calls.push(['recover']), onCommand: async (...args) => { calls.push(['command', ...args]); return { status: 'blocked' } }, onReturnHome: () => calls.push(['home']), onDirtyChange: value => dirty.push(value), renderSummary: summary => require('react').createElement('div', { id: 'synthetic-summary' }, summary.accumulation) }
  const oldFrame = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = fn => { frames.push(fn); return frames.length }; globalThis.cancelAnimationFrame = id => { frames[id - 1] = null }
  const flush = patch => { Object.assign(props, patch); let count = 0; do { assert.ok(++count < 20); changed = false; cursor = 0; const child = exports.GuidedTrainingPage(props); tree = child.type(child.props); while (effects.length) effects.shift()() } while (changed); return tree }
  const component = (tree, name) => all(tree).find(n => n.type === components[name])
  return { flush, props, calls, dirty, components, component, dispose() { for (const slot of slots) slot?.cleanup?.(); globalThis.requestAnimationFrame = oldFrame; globalThis.cancelAnimationFrame = oldCancel } }
}

// UX-RESET: legacy four-screen UI assertions intentionally migrate to the approved two-state UI.
// Original source/test baseline is archived by root; safety/unknown/stale/draft guards remain tested.
test('legacy model guards remain; unified reading/choice resumes first attempt or basis, never a CHECK screen', () => {
  assert.equal(model.canOpenGuidedStep('BASIS', base, '借助', false), false)
  assert.equal(model.canOpenGuidedStep('CHECK', saved, '借助', true), false)
  assert.equal(model.canSubmitGuidedJudgment(saved, '借助', false, false), true)
  for (const patch of [{ transfer_ready: true }, { summary_ready: true }, { completed: true }]) assert.equal(model.canSubmitGuidedJudgment({ ...saved, ...patch }, '借助', false, false), false)
  assert.equal(model.canSubmitGuidedJudgment(saved, '借助', false, true), false)
  assert.equal(model.canSubmitGuidedJudgment(saved, '假装', false, false), false)
  assert.equal(model.initialUnifiedTrainingStep(base), 'CHOOSE')
  assert.equal(model.initialUnifiedTrainingStep(attempted), 'BASIS')
  assert.equal(model.initialUnifiedTrainingStep(saved), 'BASIS')
  assert.equal(model.initialUnifiedTrainingStep({ ...base, reasoning_graph: saved.reasoning_graph }), 'CHOOSE')
})
test('reading and choices share one screen; radio never posts; first CTA waits for a confirmed receipt', async () => {
  const ui = await host()
  try {
    let tree = ui.flush(); assert.deepEqual(screen(tree), ['CHOOSE'])
    assert.equal(all(tree).some(n => n.props?.className === 'passage'), true)
    assert.equal(button(tree, '确认词义，找依据').props.disabled, true)
    all(tree).find(n => n.type === 'input' && n.props.value === '借助').props.onChange(); tree = ui.flush()
    assert.equal(ui.calls.some(c => c[0] === 'command'), false)
    let resolve
    ui.props.onCommand = (...args) => { ui.calls.push(['command', ...args]); return new Promise(r => { resolve = r }) }
    tree = ui.flush(); const action = button(tree, '确认词义，找依据').props.onClick
    const done = action(); action(); tree = ui.flush()
    assert.equal(ui.calls.filter(c => c[0] === 'command').length, 1, 'synchronous lock blocks double click before rerender')
    assert.deepEqual(screen(tree), ['CHOOSE'], 'pending becoming empty is not a receipt')
    ui.flush({ session: attempted }); resolve({ status: 'confirmed', session: attempted }); await done
    tree = ui.flush(); assert.deepEqual(screen(tree), ['BASIS'])
    assert.deepEqual(ui.calls.find(c => c[0] === 'command'), ['command', 'SUBMIT_ATTEMPT', { answer: '借助' }, 0])
  } finally { ui.dispose() }
})
test('first failure/unknown keeps the question; unknown locks fresh writes and exposes original recovery', async () => {
  for (const status of ['definitive_failure', 'unknown', 'blocked', 'stale']) {
    const ui = await host({ ...base, selected_answer: '借助' })
    try {
      ui.props.onCommand = async () => ({ status })
      let tree = ui.flush(); await button(tree, '确认词义，找依据').props.onClick(); tree = ui.flush()
      assert.deepEqual(screen(tree), ['CHOOSE'])
      if (status === 'unknown') { assert.equal(button(tree, '确认词义，找依据').props.disabled, true); assert.match(text(tree), /刷新读取/) }
      tree = ui.flush({ recoveryNeeded: true }); button(tree, '核对并重试刚才操作').props.onClick()
      assert.ok(ui.calls.some(c => c[0] === 'recover'))
    } finally { ui.dispose() }
  }
})
test('explicit basis CTA sequences SAVE SUBMIT CONTINUE with new versions and no separate CHECK action', async () => {
  const ui = await host(attempted)
  try {
    const submitted = { ...saved, state_version: 3, transfer_ready: true }
    const transfer = { ...base, stage: 'TRANSFER', state_version: 4 }
    const responses = [saved, submitted, transfer]
    ui.props.onCommand = async (...args) => { ui.calls.push(['command', ...args]); const session = responses.shift(); ui.flush({ session }); return { status: 'confirmed', session } }
    let tree = ui.flush(); const editor = ui.component(tree, 'ReasoningEditor')
    assert.equal(editor.props.submissionLabel, '提交本题并继续')
    const pending = editor.props.onSubmitDraft(payload); editor.props.onSubmitDraft(payload); await pending
    tree = ui.flush(); assert.deepEqual(screen(tree), ['CHOOSE'])
    assert.deepEqual(ui.calls.filter(c => c[0] === 'command').map(c => [c[1], c[3]]), [['SAVE_REASONING', 1], ['SUBMIT_ATTEMPT', 2], ['CONTINUE_TO_TRANSFER', 3]])
    assert.equal(ui.component(tree, 'ReasoningEditor').props.annotationSelection, null)
    assert.equal(all(tree).some(n => n.type === 'input' && n.props.checked), false)
  } finally { ui.dispose() }
})
test('SAVE succeeds but SUBMIT fails: preserve draft and resume only SUBMIT, not a duplicate save', async () => {
  const ui = await host(attempted)
  try {
    ui.props.onCommand = async (...args) => { ui.calls.push(['command', ...args]); if (args[0] === 'SAVE_REASONING') { ui.flush({ session: saved }); return { status: 'confirmed', session: saved } } return { status: 'definitive_failure' } }
    let tree = ui.flush(); await ui.component(tree, 'ReasoningEditor').props.onSubmitDraft(payload)
    tree = ui.flush(); assert.deepEqual(screen(tree), ['BASIS']); assert.match(text(tree), /依据已保存，判断核验尚未完成/)
    await ui.component(tree, 'ReasoningEditor').props.onSubmitDraft(payload)
    assert.deepEqual(ui.calls.filter(c => c[0] === 'command').map(c => c[1]), ['SAVE_REASONING', 'SUBMIT_ATTEMPT', 'SUBMIT_ATTEMPT'])
  } finally { ui.dispose() }
})
test('reader intents are explicit drafts; editor stays mounted when returning to question; stale callbacks cannot navigate', async () => {
  const ui = await host(attempted)
  try {
    let tree = ui.flush(); const initialReader = ui.component(tree, 'ContextReader')
    assert.equal(ui.component(tree, 'ReasonFeedback').props.onRequestContext, ui.component(tree, 'ReasoningEditor').props.onRequestContext)
    ui.component(tree, 'ReasoningEditor').props.onRequestContext(); tree = ui.flush()
    assert.equal(ui.component(tree, 'TrainingReaderDialog').props.open, true)
    const selection = { sessionId: 'synthetic-session', stage: 'CORE', selection: { token: '于物', paragraph_index: 0, start: 1, end: 3 } }
    ui.component(tree, 'ContextReader').props.onUseContext(selection); tree = ui.flush()
    assert.deepEqual(ui.component(tree, 'ReasoningEditor').props.contextBasisSelection, selection)
    assert.equal(ui.component(tree, 'TrainingReaderDialog').props.open, false)
    ui.component(tree, 'ReasoningEditor').props.onDirtyChange(true); tree = ui.flush()
    ui.component(tree, 'ContextReader').props.onReturnToQuestion(); tree = ui.flush()
    assert.deepEqual(screen(tree), ['CHOOSE']); assert.equal(all(tree).filter(n => n.type === ui.components.ReasoningEditor).length, 1)
    assert.deepEqual(ui.component(tree, 'ReasoningEditor').props.contextBasisSelection, selection)
    tree = ui.flush({ session: { ...base, stage: 'TRANSFER', state_version: 99 } })
    initialReader.props.onUseContext(selection); initialReader.props.onReturnToReasoning(); tree = ui.flush()
    assert.deepEqual(screen(tree), ['CHOOSE']); assert.equal(ui.component(tree, 'ReasoningEditor').props.contextBasisSelection, null)
    assert.equal(ui.calls.some(c => c[0] === 'command'), false)
  } finally { ui.dispose() }
})
test('first judgment reader can explicitly request tracked meaning but cannot select a basis', async () => {
  const ui = await host()
  try {
    const tree = ui.flush(), child = ui.component(tree, 'ContextReader')
    assert.equal(child.props.onUseContext, undefined); assert.equal(child.props.onUseAnnotation, undefined)
    assert.equal(child.props.reasoningReturnDisabled, true)
    child.props.onReturnToReasoning(); assert.deepEqual(screen(ui.flush()), ['CHOOSE'])
    child.props.onRevealMeaning({ paragraph_index: 0, start: 1, end: 2 })
    assert.deepEqual(ui.calls.find(c => c[0] === 'command'), ['command', 'RECORD_ASSISTANCE', { kind: 'WORD_MEANING', paragraph_index: 0, start: 1, end: 2 }, 0])
  } finally { ui.dispose() }
})
test('ready rereading returns to same result, dirty prevents advance, and busy/unknown guards retained handlers', async () => {
  for (const ready of [{ ...saved, transfer_ready: true }, { ...saved, stage: 'TRANSFER', summary_ready: true }]) {
    const ui = await host(ready)
    try {
      let tree = ui.flush(), reader = ui.component(tree, 'ContextReader')
      reader.props.onReturnToQuestion(); tree = ui.flush(); assert.deepEqual(screen(tree), ['BASIS'])
      assert.equal(reader.props.questionReturnLabel, '回到本题结果')
      ui.component(tree, 'ReasoningEditor').props.onDirtyChange(true); tree = ui.flush()
      const name = ready.transfer_ready ? '本题已核验，继续下一题' : '本题已核验，查看总结'
      assert.equal(button(tree, name).props.disabled, true); await button(tree, name).props.onClick()
      const retained = ui.component(tree, 'ReasoningEditor').props.onSubmitDraft
      tree = ui.flush({ busy: true }); reader.props.onReturnToQuestion(); reader.props.onRevealMeaning({ paragraph_index: 0, start: 0, end: 1 }); await retained(payload)
      tree = ui.flush({ busy: false, recoveryNeeded: true }); await retained(payload); button(tree, '需要一点提示').props.onClick()
      assert.equal(ui.calls.some(c => c[0] === 'command'), false)
      assert.deepEqual(screen(tree), ['BASIS'])
    } finally { ui.dispose() }
  }
})
test('unmounted or changed-version first response cannot change screen or issue follow-up writes', async () => {
  const ui = await host({ ...base, selected_answer: '借助' })
  let resolve
  ui.props.onCommand = () => new Promise(r => { resolve = r })
  const tree = ui.flush(); const done = button(tree, '确认词义，找依据').props.onClick()
  ui.dispose(); resolve({ status: 'confirmed', session: attempted }); await done
  assert.equal(ui.calls.some(c => c[0] === 'command'), false)
})
test('completion preserves summary, trace and history; render/refresh do not write', async () => {
  const ui = await host({ ...saved, completed: true, summary: { accumulation: '合成总结' } })
  try {
    const tree = ui.flush(); assert.ok(all(tree).some(n => n.props?.id === 'synthetic-summary'))
    assert.ok(ui.component(tree, 'SessionObservations')); assert.ok(ui.component(tree, 'ReasoningHistory')); assert.deepEqual(screen(tree), [])
    await tick(); ui.flush(); assert.equal(ui.calls.some(c => c[0] === 'command'), false)
  } finally { ui.dispose() }
})
test('automatic advancement keeps exact previous confirmed feedback folded without an extra primary CTA', async () => {
  const ui = await host(saved)
  try {
    const ready = { ...saved, state_version: 3, transfer_ready: true, feedback: '规则核验通过，借助外物是本句的关键。' }
    const transfer = { ...base, stage: 'TRANSFER', state_version: 4, feedback: '请先判断新句中的词义。' }
    const responses = [ready, transfer]
    ui.props.onCommand = async (...args) => { ui.calls.push(['command', ...args]); const session = responses.shift(); ui.flush({ session }); return { status: 'confirmed', session } }
    let tree = ui.flush(); await ui.component(tree, 'ReasoningEditor').props.onSubmitDraft(payload); tree = ui.flush()
    const detail = all(tree).find(n => n.type === 'details' && n.props.className === 'guided-secondary guided-previous-feedback')
    assert.ok(detail); assert.equal(detail.props.open, undefined); assert.match(text(detail), /上一题反馈/)
    assert.match(text(detail), /规则核验通过，借助外物是本句的关键。/)
    assert.match(text(tree), /请先判断新句中的词义。/); assert.deepEqual(screen(tree), ['CHOOSE'])
    assert.equal(all(detail).some(n => n.type === 'button'), false, 'feedback adds no main action or confirmation')
    assert.deepEqual(ui.calls.filter(c => c[0] === 'command').map(c => c[1]), ['SUBMIT_ATTEMPT', 'CONTINUE_TO_TRANSFER'])
    tree = ui.flush({ sessionId: 'different-synthetic-session', session: base })
    assert.equal(all(tree).some(n => n.props?.className === 'guided-secondary guided-previous-feedback'), false, 'a different route/session must not expose the prior session feedback')
  } finally { ui.dispose() }
})
test('ready feedback remains visible when advancing is unknown; old empty feedback is not fabricated', async () => {
  for (const feedback of ['确认为ready的服务器反馈', '']) {
    const ui = await host({ ...saved, transfer_ready: true, feedback })
    try {
      ui.props.onCommand = async () => ({ status: 'unknown' })
      let tree = ui.flush(); await button(tree, '本题已核验，继续下一题').props.onClick(); tree = ui.flush()
      const detail = all(tree).find(n => n.props?.className === 'guided-secondary guided-previous-feedback')
      if (feedback) { assert.ok(detail); assert.match(text(detail), /本题已核验反馈/); assert.match(text(detail), /确认为ready的服务器反馈/) }
      else assert.equal(detail, undefined)
      assert.deepEqual(screen(tree), ['BASIS'])
    } finally { ui.dispose() }
  }
})
test('late ready response after route change or unmount cannot retain another session feedback', async () => {
  for (const invalidate of ['route', 'unmount']) {
    const ui = await host(saved); let resolve
    try {
      ui.props.onCommand = () => new Promise(r => { resolve = r })
      let tree = ui.flush(); const done = ui.component(tree, 'ReasoningEditor').props.onSubmitDraft(payload)
      if (invalidate === 'route') ui.flush({ sessionId: 'other-session', session: { ...base, state_version: 99 } })
      else ui.dispose()
      resolve({ status: 'confirmed', session: { ...saved, state_version: 3, transfer_ready: true, feedback: '旧响应不应出现' } }); await done
      if (invalidate === 'route') { tree = ui.flush(); assert.doesNotMatch(text(tree), /旧响应不应出现/); assert.equal(all(tree).some(n => n.props?.className === 'guided-secondary guided-previous-feedback'), false) }
    } finally { ui.dispose() }
  }
})
