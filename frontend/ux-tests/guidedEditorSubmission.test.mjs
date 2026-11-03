import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { importSource } from './import-source.mjs'
const require = createRequire(import.meta.url), basis = await importSource('evidenceBasis.ts')
function nodes(n) { return !n || typeof n !== 'object' ? [] : [n, ...[n.props?.children].flat(Infinity).flatMap(nodes)] }
function text(n) { return n == null || typeof n === 'boolean' ? '' : typeof n !== 'object' ? String(n) : [n.props?.children].flat(Infinity).map(text).join('') }
const button = (tree, label) => { const n = nodes(tree).find(n => n.type === 'button' && text(n) === label); assert.ok(n, label); return n }
const selection = { paragraph_index: 0, start: 1, end: 3, token: '于物' }
const session = { stage: 'CORE', state_version: 1, completed: false, transfer_ready: false, summary_ready: false, context_selection: selection }
async function host(patch = {}) {
  const source = await readFile(new URL('../src/components/ReasoningEditor.tsx', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const slots = [], effects = [], calls = [], exports = {}; let cursor = 0
  const props = { session, sessionId: 'qa', answer: '借助', busy: false, onDirtyChange: () => {}, onCommand: (...args) => calls.push(['legacy', ...args]), onSubmitDraft: p => calls.push(['submit', p]), ...patch }
  new Function('require', 'exports', code)(path => {
    if (path === 'react') return { useState(v) { const i = cursor++; if (!(i in slots)) slots[i] = typeof v === 'function' ? v() : v; return [slots[i], next => { slots[i] = next }] }, useEffect(fn) { effects.push(fn) } }
    if (path === 'react/jsx-runtime') return require(path)
    if (path === '../evidenceBasis') return basis
    return {}
  }, exports)
  return { props, calls, render() { cursor = 0; effects.length = 0; const tree = exports.ReasoningEditor(props); for (const f of effects) f(); return tree } }
}
test('controlled submit keeps one primary action and never auto-posts an explicit basis or optional reason', async () => {
  const ui = await host(); let tree = ui.render()
  assert.equal(button(tree, '提交本题并继续').props.disabled, true)
  button(tree, '将当前原文选段记为证据').props.onClick(); tree = ui.render()
  assert.equal(nodes(tree).filter(n => n.type === 'button' && String(n.props.className).includes('button-primary')).length, 1)
  assert.equal(nodes(tree).some(n => n.type === 'button' && text(n) === '保存依据与结论'), false)
  const details = nodes(tree).find(n => n.type === 'details' && n.props.className === 'optional-reason')
  assert.equal(details.props.open, undefined, 'reason starts collapsed')
  assert.equal(ui.calls.length, 0)
  button(tree, '提交本题并继续').props.onClick()
  assert.deepEqual(ui.calls, [['submit', { basis_kind: 'CONTEXT', paragraph_index: 0, start: 1, end: 3, reason: '', conclusion: '借助' }]])
  nodes(tree).find(n => n.type === 'textarea').props.onChange({ target: { value: '  据句  ' } }); tree = ui.render()
  button(tree, '提交本题并继续').props.onClick(); assert.equal(ui.calls.at(-1)[1].reason, '据句')
  tree = ui.render(); assert.equal(nodes(tree).find(n => n.type === 'textarea').props.value, '  据句  ', 'collapse/re-render never destroys raw draft')
})
test('unchanged saved basis can retry verification without forcing an artificial edit/save', async () => {
  const ui = await host({ session: { ...session, reasoning_graph: { stage: 'CORE', conclusion: '借助', basis_kind: 'CONTEXT', evidence: selection, reason: '' } } })
  const tree = ui.render(); assert.equal(button(tree, '提交本题并继续').props.disabled, false)
  button(tree, '提交本题并继续').props.onClick(); assert.equal(ui.calls[0][0], 'submit')
})
test('busy and frozen handlers cannot submit, and ready has no duplicate disabled primary CTA', async () => {
  for (const patch of [{ busy: true }, { session: { ...session, transfer_ready: true } }, { session: { ...session, completed: true } }]) {
    const ui = await host(); let tree = ui.render(); button(tree, '将当前原文选段记为证据').props.onClick(); tree = ui.render()
    Object.assign(ui.props, patch); tree = ui.render()
    const submit = nodes(tree).find(n => n.type === 'button' && text(n) === '提交本题并继续')
    if (patch.busy) { assert.equal(submit.props.disabled, true); submit.props.onClick() } else assert.equal(submit, undefined)
    assert.equal(ui.calls.length, 0)
  }
})
test('code-point length is not silently truncated, oversized draft is retained and cannot submit', async () => {
  const ui = await host(); let tree = ui.render(); button(tree, '将当前原文选段记为证据').props.onClick()
  const textarea = nodes(tree).find(n => n.type === 'textarea'); assert.equal(textarea.props.maxLength, undefined)
  textarea.props.onChange({ target: { value: '𠮷'.repeat(2000) } }); tree = ui.render(); assert.equal(button(tree, '提交本题并继续').props.disabled, false)
  nodes(tree).find(n => n.type === 'textarea').props.onChange({ target: { value: '𠮷'.repeat(2001) } }); tree = ui.render()
  assert.equal(button(tree, '提交本题并继续').props.disabled, true); button(tree, '提交本题并继续').props.onClick()
  assert.equal(nodes(tree).find(n => n.type === 'textarea').props.value.length, 4002); assert.equal(ui.calls.length, 0)
})
