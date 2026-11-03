import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const hooks = dataModule(`export const useState = (...x) => globalThis.__authNetworkHost.useState(...x); export const useRef = (...x) => globalThis.__authNetworkHost.useRef(...x); export const useEffect = (...x) => globalThis.__authNetworkHost.useEffect(...x); export const useCallback = (...x) => globalThis.__authNetworkHost.useCallback(...x);`)
const http = dataModule(`export class RequestError extends Error { constructor(code, status = 0) { super(code); this.status = status } } export const configureAuthTransport = () => {}; export const setPrivateWritesSuspended = () => {}; export const errorMessage = x => x.message; export const requestJson = (...x) => globalThis.__authNetworkRequest(...x); export const subscribeAuthExpiry = x => { globalThis.__authNetworkExpire = x; return () => delete globalThis.__authNetworkExpire };`)
const { RequestError } = await import(http)
const auth = dataModule(compile(await readFile(new URL('../src/auth.ts', import.meta.url), 'utf8')))
const source = compile(await readFile(new URL('../src/authBoundary.tsx', import.meta.url), 'utf8'))
  .replace(/import ['"]\.\/auth\.css['"];?/, '').replaceAll('import.meta.env.VITE_API_ROOT', 'undefined')
  .replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')))
  .replaceAll("'react'", JSON.stringify(hooks)).replaceAll("'./http'", JSON.stringify(http)).replaceAll("'./auth'", JSON.stringify(auth))
const { AuthBoundary } = await import(dataModule(source))
const signedOut = { mode: 'invite', authenticated: false, user: null, profile_id: null, csrf_token: null, admin_enabled: false, login_method: 'email_code' }
const signedIn = { ...signedOut, authenticated: true, user: { id: 'synthetic-user', username: 'synthetic-reader', email: 'synthetic@example.com', role: 'learner' }, csrf_token: 'synthetic-csrf' }
const settle = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const submit = { preventDefault() {} }

function hostFor(render) {
  const slots = [], effects = []
  let cursor = 0, dirty = true, tree
  const host = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], x => { const next = typeof x === 'function' ? x(slots[i]) : x; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true } }] },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial } },
    useCallback(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((x, j) => !Object.is(x, old.deps[j]))) slots[i] = { deps, fn }; return slots[i].fn },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((x, j) => !Object.is(x, old.deps[j]))) { const entry = { deps, cleanup: old?.cleanup }; slots[i] = entry; effects.push(() => { entry.cleanup?.(); entry.cleanup = effect() }) } },
    flush() { let count = 0; do { assert.ok(++count < 12); cursor = 0; dirty = false; globalThis.__authNetworkHost = host; try { tree = render() } finally { delete globalThis.__authNetworkHost } while (effects.length) effects.shift()() } while (dirty); return tree },
    dispose() { for (const slot of slots) slot?.cleanup?.() },
  }
  return host
}
function find(tree, predicate) { if (!tree || typeof tree !== 'object') return null; if (predicate(tree)) return tree; for (const child of [tree.props?.children].flat(Infinity)) { const result = find(child, predicate); if (result) return result } return null }
const isPrivate = host => !!find(host.flush(), x => x.type === 'private-qa')

async function withBoundary(run) {
  const originals = { window: globalThis.window, document: globalThis.document, BroadcastChannel: globalThis.BroadcastChannel }
  globalThis.window = new EventTarget(); globalThis.document = { title: '' }; globalThis.BroadcastChannel = undefined
  window.setInterval = () => 1; window.clearInterval = () => {}
  globalThis.__authNetworkRequest = async () => signedOut
  const host = hostFor(() => AuthBoundary({ children: session => ({ type: 'private-qa', props: { session } }) }))
  try { host.flush(); await settle(); const screen = find(host.flush(), x => typeof x.props?.onAuthenticate === 'function'); await run({ host, screen }) }
  finally { host.dispose(); delete globalThis.__authNetworkRequest; delete globalThis.__authNetworkHost; for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value } }
}

for (const [code, status] of [['REQUEST_TIMEOUT', 0], ['NETWORK_ERROR', 0], ['INVALID_RESPONSE', 200], ['SERVER_UNAVAILABLE', 503]]) {
  test(`${code}: a committed email verification is reconciled with exactly one read and no repeated write`, async () => {
    await withBoundary(async ({ host, screen }) => {
      const calls = []
      globalThis.__authNetworkRequest = async (url, init) => { calls.push([url, init.method ?? 'GET']); if (url.endsWith('/verify')) throw new RequestError(code, status); return signedIn }
      await screen.props.onAuthenticate('/email/verify', { email: ' Synthetic@Example.com ', code: '123456' })
      assert.equal(isPrivate(host), true)
      assert.deepEqual(calls, [['/api/v1/auth/email/verify', 'POST'], ['/api/v1/auth/session', 'GET']])
    })
  })
}

test('explicit invalid or expired codes and session changes do not trigger a recovery read', async () => {
  for (const [code, status] of [['AUTH_EMAIL_CODE_INVALID', 400], ['AUTH_EMAIL_CODE_EXPIRED', 400], ['SESSION_CHANGED', 409]]) {
    await withBoundary(async ({ host, screen }) => {
      let calls = 0
      globalThis.__authNetworkRequest = async () => { calls++; throw new RequestError(code, status) }
      await assert.rejects(screen.props.onAuthenticate('/email/verify', { email: 'synthetic@example.com' }), error => error.message === code)
      assert.equal(calls, 1); assert.equal(isPrivate(host), false)
    })
  }
})

test('signed-out, missing-email, or other-email session reads never recover an ambiguous verification', async () => {
  for (const next of [signedOut, { ...signedIn, user: { ...signedIn.user, email: undefined } }, { ...signedIn, user: { ...signedIn.user, email: 'different@example.com' } }]) {
    await withBoundary(async ({ host, screen }) => {
      globalThis.__authNetworkRequest = async url => { if (url.endsWith('/verify')) throw new RequestError('REQUEST_TIMEOUT'); return next }
      await assert.rejects(screen.props.onAuthenticate('/email/verify', { email: 'synthetic@example.com' }), /REQUEST_TIMEOUT/)
      assert.equal(isPrivate(host), false)
    })
  }
})

test('a failed session reconciliation preserves the original error and allows an explicit login retry', async () => {
  await withBoundary(async ({ host, screen }) => {
    const calls = []
    globalThis.__authNetworkRequest = async url => { calls.push(url); throw new RequestError(url.endsWith('/verify') ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR') }
    await assert.rejects(screen.props.onAuthenticate('/email/verify', { email: 'synthetic@example.com' }), /REQUEST_TIMEOUT/)
    assert.equal(calls.length, 2); assert.equal(isPrivate(host), false)
    globalThis.__authNetworkRequest = async url => { calls.push(url); return signedOut }
    window.dispatchEvent(new Event('focus')); await settle(); host.flush()
    assert.equal(calls.length, 2)
    globalThis.__authNetworkRequest = async () => signedIn
    await screen.props.onAuthenticate('/email/verify', { email: 'synthetic@example.com' })
    assert.equal(isPrivate(host), true)
  })
})

test('focus during recovery does not supersede the verification and explicit expiry still invalidates its late result', async () => {
  await withBoundary(async ({ host, screen }) => {
    const response = deferred(), calls = []
    globalThis.__authNetworkRequest = async url => { calls.push(url); if (url.endsWith('/verify')) throw new RequestError('REQUEST_TIMEOUT'); return response.promise }
    const login = screen.props.onAuthenticate('/email/verify', { email: 'synthetic@example.com' })
    await settle(); window.dispatchEvent(new Event('focus'))
    assert.equal(calls.length, 2)
    globalThis.__authNetworkRequest = async () => signedOut
    globalThis.__authNetworkExpire(); await settle(); host.flush()
    response.resolve(signedIn)
    await assert.rejects(login, /SESSION_CHANGED/)
    assert.equal(isPrivate(host), false)
  })
})

test('aborted verification never reconciles, and cancellation during recovery cannot reveal a session', async () => {
  for (const duringRead of [false, true]) {
    await withBoundary(async ({ host, screen }) => {
      const controller = new AbortController(); let calls = 0
      globalThis.__authNetworkRequest = async url => { calls++; if (url.endsWith('/verify')) { if (!duringRead) controller.abort(); throw new RequestError('REQUEST_TIMEOUT') } controller.abort(); return signedIn }
      await assert.rejects(screen.props.onAuthenticate('/email/verify', { email: 'synthetic@example.com' }, controller.signal), /REQUEST_TIMEOUT/)
      assert.equal(calls, duringRead ? 2 : 1); assert.equal(isPrivate(host), false)
    })
  }
})

test('recovery binds to the email at attempt start, not a later mutation of the caller payload', async () => {
  await withBoundary(async ({ host, screen }) => {
    const payload = { email: 'synthetic@example.com' }
    globalThis.__authNetworkRequest = async url => { if (url.endsWith('/verify')) { payload.email = 'different@example.com'; throw new RequestError('REQUEST_TIMEOUT') } return { ...signedIn, user: { ...signedIn.user, email: payload.email } } }
    await assert.rejects(screen.props.onAuthenticate('/email/verify', payload), /REQUEST_TIMEOUT/)
    assert.equal(isPrivate(host), false)
  })
})

test('uncertain code-send result releases the form and explicitly says there was no automatic resend', async () => {
  await withBoundary(async ({ screen }) => {
    const formHost = hostFor(() => screen.type(screen.props)); let calls = 0
    globalThis.__authNetworkRequest = async () => { calls++; throw new RequestError('REQUEST_TIMEOUT') }
    try {
      let tree = formHost.flush()
      find(tree, x => x.props?.id === 'auth-email').props.onChange({ target: { value: 'synthetic@example.com' } }); tree = formHost.flush()
      find(tree, x => x.type === 'form').props.onSubmit(submit); await settle(); tree = formHost.flush()
      assert.match(find(tree, x => x.props?.role === 'alert').props.children, /不会自动重发/)
      assert.equal(find(tree, x => x.type === 'form').props['aria-busy'], false)
      assert.equal(find(tree, x => x.props?.id === 'auth-email').props.value, 'synthetic@example.com')
      assert.equal(calls, 1)
    } finally { formHost.dispose() }
  })
})

test('unconfirmed verification preserves the entered code, releases controls, and explains refresh recovery without resending', async () => {
  await withBoundary(async ({ screen }) => {
    let verifications = 0, sends = 0
    const formHost = hostFor(() => screen.type({ ...screen.props, onAuthenticate: async () => { verifications++; throw new RequestError('REQUEST_TIMEOUT') } }))
    globalThis.__authNetworkRequest = async () => { sends++; return { ok: true, challenge_id: 'synthetic-challenge', expires_in_seconds: 600, resend_after_seconds: 60 } }
    try {
      let tree = formHost.flush()
      find(tree, x => x.props?.id === 'auth-email').props.onChange({ target: { value: 'synthetic@example.com' } }); tree = formHost.flush()
      find(tree, x => x.type === 'form').props.onSubmit(submit); await settle(); tree = formHost.flush()
      find(tree, x => x.props?.id === 'auth-code').props.onChange({ target: { value: '123456' } }); tree = formHost.flush()
      find(tree, x => x.type === 'form').props.onSubmit(submit); await settle(); tree = formHost.flush()
      assert.match(find(tree, x => x.props?.role === 'alert').props.children, /刷新页面确认/)
      assert.equal(find(tree, x => x.props?.id === 'auth-code').props.value, '123456')
      assert.equal(find(tree, x => x.props?.id === 'auth-code').props.disabled, false)
      assert.equal(find(tree, x => x.type === 'form').props['aria-busy'], false)
      assert.equal(verifications, 1); assert.equal(sends, 1)
    } finally { formHost.dispose() }
  })
})

test('returning from a mail app while offline does not discard an explicitly signed-out email/code draft', async () => {
  await withBoundary(async ({ host, screen }) => {
    const formHost = hostFor(() => screen.type(screen.props)); let sessionReads = 0
    globalThis.__authNetworkRequest = async url => {
      if (url.endsWith('/session')) { sessionReads++; throw new RequestError('NETWORK_ERROR') }
      return { ok: true, challenge_id: 'synthetic-challenge', expires_in_seconds: 600, resend_after_seconds: 60 }
    }
    try {
      let tree = formHost.flush()
      find(tree, x => x.props?.id === 'auth-email').props.onChange({ target: { value: 'synthetic@example.com' } }); tree = formHost.flush()
      find(tree, x => x.type === 'form').props.onSubmit(submit); await settle(); tree = formHost.flush()
      find(tree, x => x.props?.id === 'auth-code').props.onChange({ target: { value: '123456' } }); formHost.flush()
      window.dispatchEvent(new Event('focus')); await settle()
      const nextScreen = find(host.flush(), x => typeof x.props?.onAuthenticate === 'function')
      assert.ok(nextScreen, 'the signed-out email form must remain mounted')
      assert.equal(nextScreen.type, screen.type); assert.equal(nextScreen.key, screen.key)
      assert.equal(sessionReads, 0)
      tree = formHost.flush()
      assert.equal(find(tree, x => x.props?.id === 'auth-email').props.value, 'synthetic@example.com')
      assert.equal(find(tree, x => x.props?.id === 'auth-code').props.value, '123456')
    } finally { formHost.dispose() }
  })
})

test('an authenticated private page still fails closed when its focus session check fails', async () => {
  await withBoundary(async ({ host, screen }) => {
    globalThis.__authNetworkRequest = async () => signedIn
    await screen.props.onAuthenticate('/email/verify', { email: 'synthetic@example.com' }); assert.equal(isPrivate(host), true)
    let reads = 0
    globalThis.__authNetworkRequest = async () => { reads++; throw new RequestError('NETWORK_ERROR') }
    window.dispatchEvent(new Event('focus')); await settle()
    assert.equal(reads, 1); assert.equal(isPrivate(host), true)
    assert.ok(find(host.flush(), x => x.type === 'div' && x.props?.hidden === true), 'private tree remains mounted and hidden')
    assert.ok(find(host.flush(), x => x.props?.role === 'alert'))
  })
})

test('explicit expiry still reloads even when the visible form is already signed out', async () => {
  await withBoundary(async ({ host }) => {
    let reads = 0
    globalThis.__authNetworkRequest = async () => { reads++; throw new RequestError('NETWORK_ERROR') }
    globalThis.__authNetworkExpire(); await settle()
    assert.equal(reads, 1); assert.equal(isPrivate(host), false)
    assert.equal(find(host.flush(), x => typeof x.props?.onAuthenticate === 'function'), null)
  })
})


for (const [code, status] of [['NETWORK_ERROR', 0], ['REQUEST_TIMEOUT', 0], ['SERVER_UNAVAILABLE', 503]]) {
  test(`authenticated ${code} seals and retains the same private tree until same-session revalidation`, async () => {
    await withBoundary(async ({ host, screen }) => {
      globalThis.__authNetworkRequest = async () => signedIn
      await screen.props.onAuthenticate('/email/verify', { email: 'synthetic@example.com' })
      const first = find(host.flush(), x => x.type === 'div' && x.props?.children?.type === 'private-qa')
      assert.ok(first); const check = deferred()
      globalThis.__authNetworkRequest = () => check.promise
      window.dispatchEvent(new Event('focus'))
      let tree = host.flush(); assert.ok(find(tree, x => x.type === 'div' && x.props?.hidden === true))
      check.resolve(Promise.reject(new RequestError(code, status))); await settle(); tree = host.flush()
      const hidden = find(tree, x => x.type === 'div' && x.props?.hidden === true)
      assert.equal(hidden.key, first.key); assert.ok(find(hidden, x => x.type === 'private-qa'))
      globalThis.__authNetworkRequest = async () => signedIn
      find(tree, x => x.type === 'button' && x.props?.children === '重新连接').props.onClick()
      tree = host.flush(); assert.ok(find(tree, x => x.type === 'div' && x.props?.hidden === true))
      await settle(); tree = host.flush()
      const restored = find(tree, x => x.type === 'div' && x.props?.children?.type === 'private-qa')
      assert.equal(restored.key, first.key); assert.notEqual(restored.props.hidden, true)
    })
  })
}
test('a 401 destroys the private tree, while a changed identity or session is remounted with a new key', async () => {
  for (const changed of [null, { ...signedIn, user: { ...signedIn.user, id: 'synthetic-other' } }, { ...signedIn, csrf_token: 'synthetic-other-session' }]) {
    await withBoundary(async ({ host, screen }) => {
      globalThis.__authNetworkRequest = async () => signedIn
      await screen.props.onAuthenticate('/email/verify', { email: 'synthetic@example.com' })
      const first = find(host.flush(), x => x.type === 'div' && x.props?.children?.type === 'private-qa')
      globalThis.__authNetworkRequest = async () => { if (!changed) throw new RequestError('AUTH_REQUIRED', 401); return changed }
      window.dispatchEvent(new Event('focus')); await settle(); const tree=host.flush()
      const next = find(tree, x => x.type === 'div' && x.props?.children?.type === 'private-qa')
      if (!changed) assert.equal(next, null); else { assert.ok(next); assert.notEqual(next.key, first.key) }
    })
  }
})
test('out-of-order focus checks cannot reveal an older session after a later rejection', async () => {
  await withBoundary(async ({ host, screen }) => {
    globalThis.__authNetworkRequest = async () => signedIn
    await screen.props.onAuthenticate('/email/verify', { email: 'synthetic@example.com' }); host.flush()
    const first = deferred(); let calls=0
    globalThis.__authNetworkRequest = () => ++calls === 1 ? first.promise : Promise.reject(new RequestError('AUTH_REQUIRED', 401))
    window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')); await settle()
    assert.equal(isPrivate(host), false); first.resolve(signedIn); await settle(); assert.equal(isPrivate(host), false)
  })
})

test('uncertain identity opens a non-dismissible recovery modal above native private dialogs', async () => {
  await withBoundary(async ({host, screen}) => {
    globalThis.__authNetworkRequest = async () => signedIn
    await screen.props.onAuthenticate('/email/verify', {email:'synthetic@example.com'})
    globalThis.__authNetworkRequest = async () => { throw new RequestError('NETWORK_ERROR') }
    window.dispatchEvent(new Event('focus')); await settle()
    const tree=host.flush(), modal=find(tree, x=>x.type==='dialog' && x.props?.className?.includes('auth-recovery-dialog'))
    assert.ok(modal); assert.ok(find(tree,x=>x.type==='div' && x.props?.hidden===true))
    let shown=0, focused=0, prevented=0
    modal.ref({open:false, showModal(){shown++}, focus(){focused++}})
    modal.props.onCancel({preventDefault(){prevented++}})
    assert.equal(shown,1); assert.equal(focused,1); assert.equal(prevented,1)
    assert.ok(find(modal,x=>x.type==='button' && x.props?.children==='重新连接'))
  })
})

