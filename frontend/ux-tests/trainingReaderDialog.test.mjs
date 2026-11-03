import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const dataModule = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
const source = await readFile(new URL('../src/components/TrainingReaderDialog.tsx', import.meta.url), 'utf8')
const hooks = dataModule(`export const useState = (...args) => globalThis.__trainingReaderHooks.useState(...args); export const useRef = (...args) => globalThis.__trainingReaderHooks.useRef(...args); export const useLayoutEffect = (...args) => globalThis.__trainingReaderHooks.useLayoutEffect(...args); export const useId = () => globalThis.__trainingReaderHooks.useId();`)
let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
code = code.replace(/import ['"]\.\/trainingReaderDialog\.css['"];?/, '')
for (const [name, url] of [['react', hooks], ['react/jsx-runtime', import.meta.resolve('react/jsx-runtime')]]) code = code.replaceAll(`'${name}'`, JSON.stringify(url)).replaceAll(`"${name}"`, JSON.stringify(url))
const { TrainingReaderDialog } = await import(dataModule(code))
const previousElement = globalThis.HTMLElement
test.afterEach(() => { if (previousElement === undefined) delete globalThis.HTMLElement; else globalThis.HTMLElement = previousElement })

function style() {
  const entries = new Map()
  return { getPropertyValue: key => entries.get(key)?.[0] ?? '', getPropertyPriority: key => entries.get(key)?.[1] ?? '', setProperty: (key, value, priority = '') => entries.set(key, [value, priority]), removeProperty: key => entries.delete(key) }
}
class Element {
  constructor(doc) { this.ownerDocument = doc; this.style = style(); this.isConnected = true; this.hiddenAncestor = false; this.focuses = 0; this.tabIndex = 0 }
  focus() { this.focuses++; this.ownerDocument.activeElement = this }
  closest() { return this.hiddenAncestor ? {} : null }
  getClientRects() { return this.hiddenAncestor ? [] : [{}] }
}
function environment() {
  const doc = { dialogs: [] }
  doc.body = new Element(doc); doc.documentElement = new Element(doc); doc.activeElement = new Element(doc)
  doc.querySelector = () => doc.dialogs.find(dialog => dialog.open) ?? null
  return doc
}
function walk(node, callback) {
  if (!node || typeof node !== 'object') return
  callback(node)
  for (const child of [node.props?.children].flat(Infinity)) walk(child, callback)
}
function setup(doc = environment()) {
  globalThis.HTMLElement = Element
  const trigger = doc.activeElement, heading = new Element(doc)
  const controls = [new Element(doc), new Element(doc), new Element(doc)]
  const node = new Element(doc)
  Object.assign(node, { open: false, shows: 0, closes: 0, contains: target => target === heading || controls.includes(target), querySelectorAll: () => controls, showModal() { this.open = true; this.shows++ }, close() { this.open = false; this.closes++; doc.activeElement = doc.body } })
  doc.dialogs.push(node)
  let props = { open: false, identity: 'synthetic-user:session:CORE', busy: false, children: 'synthetic-reader-content', onClose: () => { callbacks++ } }
  let cursor = 0, dirty = false, tree, callbacks = 0
  const slots = [], effects = []
  const host = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], next => { if (slots[i] !== next) { slots[i] = next; dirty = true } }] },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial } },
    useId() { const i = cursor++; return slots[i] ??= `synthetic-reader-${i}` },
    useLayoutEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) { const entry = { deps, cleanup: old?.cleanup }; slots[i] = entry; effects.push(() => { entry.cleanup?.(); entry.cleanup = effect() }) } },
    render(next = {}) {
      props = { ...props, ...next }
      let cap = 10
      do {
        assert.ok(cap-- > 0, 'state must settle'); cursor = 0; dirty = false; globalThis.__trainingReaderHooks = host
        try { tree = TrainingReaderDialog(props) } finally { delete globalThis.__trainingReaderHooks }
        walk(tree, child => { if (child.ref) child.ref.current = child.type === 'dialog' ? node : heading })
        while (effects.length) effects.shift()()
      } while (dirty)
      return tree
    },
    find(predicate) { let found; walk(tree, child => { if (!found && predicate(child)) found = child }); assert.ok(found); return found },
    cancel() { const event = { prevented: false, preventDefault() { this.prevented = true } }; tree.props.onCancel(event); return event },
    tab(shiftKey = false) { const event = { key: 'Tab', shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }; tree.props.onKeyDown(event); return event },
    dispose() { for (const slot of slots) slot?.cleanup?.() },
    doc, node, heading, controls, trigger, get callbacks() { return callbacks },
  }
  host.render()
  return host
}

test('opening uses native modal inertness, locks only while open, focuses the title and restores the trigger', () => {
  const host = setup()
  try {
    host.doc.body.style.setProperty('overflow', 'auto', 'important')
    host.render({ open: true })
    assert.equal(host.node.shows, 1); assert.equal(host.doc.body.style.getPropertyValue('overflow'), 'hidden')
    assert.equal(host.doc.documentElement.style.getPropertyValue('overflow'), 'hidden')
    assert.equal(host.doc.activeElement, host.heading)
    host.render({ busy: true }); assert.equal(host.node.shows, 1, 'busy changes cannot reopen or reset reading position')
    host.render({ open: false })
    assert.equal(host.node.open, false); assert.equal(host.doc.activeElement, host.trigger)
    assert.equal(host.doc.body.style.getPropertyValue('overflow'), 'auto'); assert.equal(host.doc.body.style.getPropertyPriority('overflow'), 'important')
    assert.equal(host.doc.documentElement.style.getPropertyValue('overflow'), '')
  } finally { host.dispose() }
})

test('Escape and close respect busy state; dismissal never saves, clears or submits children', () => {
  const host = setup()
  try {
    host.render({ open: true, busy: true })
    assert.equal(host.cancel().prevented, true); assert.equal(host.callbacks, 0)
    const close = host.find(child => child.type === 'button')
    assert.equal(close.props.disabled, true); close.props.onClick(); assert.equal(host.callbacks, 0)
    host.render({ busy: false }); host.cancel(); assert.equal(host.callbacks, 1)
    host.render({ open: false })
    assert.equal(host.find(child => child.props?.className === 'training-reader-scroll').props.children, 'synthetic-reader-content', 'closing preserves the mounted reader and its local state')
  } finally { host.dispose() }
})

test('Tab wraps in both directions and excludes hidden/inert descendants', () => {
  const host = setup()
  try {
    host.render({ open: true })
    host.controls[1].hiddenAncestor = true
    host.controls[2].focus(); assert.equal(host.tab().defaultPrevented, true); assert.equal(host.doc.activeElement, host.controls[0])
    assert.equal(host.tab(true).defaultPrevented, true); assert.equal(host.doc.activeElement, host.controls[2])
    host.heading.focus(); host.tab(); assert.equal(host.doc.activeElement, host.controls[0])
    host.controls[2].tabIndex = -1
    host.controls[0].focus(); host.tab(); assert.equal(host.doc.activeElement, host.controls[0], 'roving tabindex=-1 is not a Tab destination')
    host.controls.forEach(control => { control.hiddenAncestor = true })
    host.tab(); assert.equal(host.doc.activeElement, host.heading)
  } finally { host.dispose() }
})

test('identity reset immediately closes, drops old reader content, releases scroll and never reopens stale open intent', () => {
  const host = setup()
  try {
    host.render({ open: true, busy: true }); const oldTriggerFocuses = host.trigger.focuses
    host.render({ identity: 'synthetic-user:other-session:TRANSFER' })
    assert.equal(host.node.open, false); assert.equal(host.callbacks, 1)
    assert.equal(host.trigger.focuses, oldTriggerFocuses)
    assert.equal(host.doc.body.style.getPropertyValue('overflow'), '')
    assert.equal(host.find(child => child.props?.className === 'training-reader-scroll').props.children, null)
    host.render({ busy: false }); assert.equal(host.node.shows, 1)
    host.render({ open: false }); host.render({ open: true }); assert.equal(host.node.shows, 2)
  } finally { host.dispose() }
})

test('unmount and overlapping readers restore scrolling only after the final lease; newer styles are preserved', () => {
  const doc = environment(), first = setup(doc), second = setup(doc)
  try {
    first.render({ open: true }); second.render({ open: true })
    first.dispose(); assert.equal(doc.body.style.getPropertyValue('overflow'), 'hidden')
    doc.documentElement.style.setProperty('overflow', 'clip')
    second.dispose(); assert.equal(doc.body.style.getPropertyValue('overflow'), '')
    assert.equal(doc.documentElement.style.getPropertyValue('overflow'), 'clip')
  } finally { first.dispose(); second.dispose() }
})

test('the reader owns one scroll viewport, uses dynamic viewport/safe areas and removes motion when requested', async () => {
  const css = await readFile(new URL('../src/components/trainingReaderDialog.css', import.meta.url), 'utf8')
  const guided = await readFile(new URL('../src/components/guidedTraining.css', import.meta.url), 'utf8')
  assert.match(css, /\.training-reader-scroll[^}]*overflow: auto/s)
  assert.match(css, /dialog\.training-reader-dialog :is\(\.fulltext-canvas, \.context-layers, \.context-disclosure\)[^}]*max-height: none[^}]*overflow: visible/s)
  assert.match(css, /100dvh/); assert.match(css, /safe-area-inset-bottom/); assert.match(css, /prefers-reduced-motion: reduce/)
  assert.match(css, /\.training-reader-dialog :is\(input, select, textarea\) \{ font-size: 16px/)
  assert.match(guided, /\.guided-task-primary[^}]*position: sticky/)
  assert.match(guided, /:has\(textarea:focus[^}]*position: static/s)
  assert.doesNotMatch(source, /localStorage|sessionStorage|fetch\(|\.cookie|onCommand|setTimeout/)
})
