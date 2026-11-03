import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const source = await readFile(new URL('../src/authBoundary.tsx', import.meta.url), 'utf8')
const hooksUrl = dataModule(`export const useState = (...args) => globalThis.__authQaHost.useState(...args); export const useRef = (...args) => globalThis.__authQaHost.useRef(...args); export const useEffect = (...args) => globalThis.__authQaHost.useEffect(...args); export const useCallback = (...args) => globalThis.__authQaHost.useCallback(...args);`)
const httpUrl = dataModule(`export class RequestError extends Error { constructor(message, status) { super(message); this.status = status } } export const configureAuthTransport = () => {}; export const setPrivateWritesSuspended = () => {}; export const errorMessage = error => error.message; export const requestJson = (...args) => globalThis.__authQaRequest(...args); export const subscribeAuthExpiry = fn => { globalThis.__authQaExpire = fn; return () => { delete globalThis.__authQaExpire } };`)
const authUrl = dataModule(compile(await readFile(new URL('../src/auth.ts', import.meta.url), 'utf8')))
const js = compile(source).replace(/import ['"]\.\/auth\.css['"];?/, '').replaceAll('import.meta.env.VITE_API_ROOT', 'undefined').replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime'))).replaceAll("'react'", JSON.stringify(hooksUrl)).replaceAll("'./http'", JSON.stringify(httpUrl)).replaceAll("'./auth'", JSON.stringify(authUrl))
const { AuthBoundary } = await import(dataModule(js))
const signedOut = { mode: 'invite', authenticated: false, user: null, profile_id: null, csrf_token: null, admin_enabled: false, login_method: 'email_code' }
const signedIn = { ...signedOut, authenticated: true, user: { id: 'synthetic-user', username: 'synthetic-reader', role: 'learner' }, csrf_token: 'synthetic-only' }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const settle = () => new Promise(resolve => setImmediate(resolve))

function hostFor(render) {
  const slots = [], effects = []
  let cursor = 0, dirty = true, tree
  const host = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { const next = typeof value === 'function' ? value(slots[index]) : value; if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true } }] },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial } },
    useCallback(fn, deps) { const index = cursor++, old = slots[index]; if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) slots[index] = { deps, fn }; return slots[index].fn },
    useEffect(effect, deps) { const index = cursor++, old = slots[index]; if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) { const entry = { deps, cleanup: old?.cleanup }; slots[index] = entry; effects.push(() => { entry.cleanup?.(); entry.cleanup = effect() }) } },
    flush() { let attempts = 0; do { assert.ok(++attempts < 12); cursor = 0; dirty = false; globalThis.__authQaHost = host; try { tree = render() } finally { delete globalThis.__authQaHost } while (effects.length) effects.shift()() } while (dirty); return tree },
    dispose() { for (const slot of slots) slot?.cleanup?.() },
  }
  return host
}
function find(tree, predicate) { if (!tree || typeof tree !== 'object') return null; if (predicate(tree)) return tree; const children = tree.props?.children; for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) { const result = find(child, predicate); if (result) return result } return null }

async function withBoundary(run) {
  const originals = { window: globalThis.window, document: globalThis.document, BroadcastChannel: globalThis.BroadcastChannel }
  globalThis.window = new EventTarget(); globalThis.document = { title: '' }; globalThis.BroadcastChannel = undefined
  const host = hostFor(() => AuthBoundary({ children: session => ({ type: 'private-qa', props: { session } }) }))
  let requests = 0
  globalThis.__authQaRequest = async () => { requests++; return signedOut }
  try { host.flush(); await settle(); const tree = host.flush(); await run({ host, screen: find(tree, node => typeof node.props?.onAuthenticate === 'function'), requests: () => requests }) }
  finally { host.dispose(); delete globalThis.__authQaRequest; delete globalThis.__authQaHost; for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value } }
}

test('returning from mail while verification is pending cannot replace a successful login with a session read', async () => {
  await withBoundary(async ({ host, screen }) => {
    const response = deferred(), paths = []
    globalThis.__authQaRequest = (url) => { paths.push(url); return response.promise }
    const login = screen.props.onAuthenticate('/email/verify', { code: '123456' })
    window.dispatchEvent(new Event('focus'))
    assert.deepEqual(paths, ['/api/v1/auth/email/verify'])
    response.resolve(signedIn); await login
    assert.ok(find(host.flush(), node => node.type === 'private-qa'))
    globalThis.__authQaRequest = async url => { paths.push(url); return signedIn }
    window.dispatchEvent(new Event('focus')); await settle(); host.flush()
    assert.equal(paths.at(-1), '/api/v1/auth/session')
  })
})

test('verification failure preserves the signed-out draft and allows an explicit successful retry', async () => {
  await withBoundary(async ({ host, screen }) => {
    globalThis.__authQaRequest = async () => { throw new Error('AUTH_EMAIL_CODE_INVALID') }
    await assert.rejects(screen.props.onAuthenticate('/email/verify', {}), /AUTH_EMAIL_CODE_INVALID/)
    let checked = 0
    globalThis.__authQaRequest = async () => { checked++; return signedOut }
    window.dispatchEvent(new Event('focus')); await settle()
    assert.equal(checked, 0)
    assert.ok(find(host.flush(), node => typeof node.props?.onAuthenticate === 'function'))
    globalThis.__authQaRequest = async () => signedIn
    await screen.props.onAuthenticate('/email/verify', {})
    assert.ok(find(host.flush(), node => node.type === 'private-qa'))
  })
})

test('explicit session expiry still invalidates an in-flight successful verification', async () => {
  await withBoundary(async ({ host, screen }) => {
    const response = deferred()
    globalThis.__authQaRequest = url => url.endsWith('/email/verify') ? response.promise : Promise.resolve(signedOut)
    const login = screen.props.onAuthenticate('/email/verify', {})
    globalThis.__authQaExpire(); await settle(); host.flush()
    response.resolve(signedIn)
    await assert.rejects(login, /SESSION_CHANGED/)
    assert.equal(find(host.flush(), node => node.type === 'private-qa'), null)
  })
})

test('email code requests are single-flight and editing email does not bypass resend cooldown', async () => {
  await withBoundary(async ({ screen }) => {
    const intervals = new Map(); let intervalId = 0
    window.setInterval = callback => { intervals.set(++intervalId, callback); return intervalId }
    window.clearInterval = id => intervals.delete(id)
    const host = hostFor(() => screen.type(screen.props))
    const response = deferred(); let calls = 0
    globalThis.__authQaRequest = async () => { calls++; return response.promise }
    try {
      let tree = host.flush()
      find(tree, node => node.props?.id === 'auth-email').props.onChange({ target: { value: 'synthetic@example.com' } }); tree = host.flush()
      const form = find(tree, node => node.type === 'form')
      form.props.onSubmit({ preventDefault() {} }); form.props.onSubmit({ preventDefault() {} })
      assert.equal(calls, 1)
      response.resolve({ ok: true, challenge_id: 'synthetic-challenge', expires_in_seconds: 600, resend_after_seconds: 60 }); await settle(); tree = host.flush()
      assert.ok(find(tree, node => node.props?.id === 'auth-code'))
      let focused = 0
      find(tree, node => node.props?.id === 'auth-email').ref.current = { focus() { focused++ } }
      find(tree, node => node.type === 'button' && [node.props.children].flat().join('') === '修改邮箱').props.onClick(); tree = host.flush()
      assert.equal(focused, 1)
      assert.equal(find(tree, node => node.props?.id === 'auth-code'), null)
      find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
      assert.equal(calls, 1)
    } finally { host.dispose(); assert.equal(intervals.size, 0) }
  })
})

test('mobile mailbox and invitation inputs opt out of keyboard case correction', async () => {
  await withBoundary(async ({ screen }) => {
    window.setInterval = () => 1; window.clearInterval = () => {}
    const host = hostFor(() => screen.type(screen.props))
    try {
      let tree = host.flush()
      find(tree, node => node.type === 'button' && node.props.children === '首次体验？使用邀请码加入').props.onClick(); tree = host.flush()
      for (const id of ['auth-email', 'auth-invite']) {
        const input = find(tree, node => node.props?.id === id)
        assert.equal(input.props.autoCapitalize, 'none'); assert.equal(input.props.autoCorrect, 'off'); assert.equal(input.props.spellCheck, false)
      }
      assert.equal(find(tree, node => node.props?.id === 'auth-email').props.inputMode, 'email')
    } finally { host.dispose() }
  })
})
