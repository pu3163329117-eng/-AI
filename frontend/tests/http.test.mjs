import test from 'node:test'
import assert from 'node:assert/strict'
import { importSource } from './import-source.mjs'
const { requestJson, RequestError, errorMessage, uncertainWrite } = await importSource('http.ts')
const originalFetch = globalThis.fetch
test.afterEach(() => { globalThis.fetch = originalFetch })

test('JSON success returns server data', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ session: { state_version: 4 } }), { status: 200 })
  assert.deepEqual(await requestJson('/api'), { session: { state_version: 4 } })
})
test('application error preserves conflict code and status', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'VERSION_CONFLICT' } }), { status: 409 })
  await assert.rejects(requestJson('/api'), error => error instanceof RequestError && error.message === 'VERSION_CONFLICT' && error.status === 409 && !uncertainWrite(error))
})
test('invalid successful response is explicit, not a null UI snapshot', async () => {
  globalThis.fetch = async () => new Response('<html>upstream error</html>', { status: 200 })
  await assert.rejects(requestJson('/api'), error => error.message === 'INVALID_RESPONSE' && uncertainWrite(error))
})
test('network failure does not automatically retry a mutation', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new TypeError('Failed to fetch') }
  await assert.rejects(requestJson('/api', { method: 'POST' }), error => error.message === 'NETWORK_ERROR' && uncertainWrite(error))
  assert.equal(calls, 1)
})
test('hanging request times out and releases the signal', async () => {
  let observedSignal
  globalThis.fetch = (_url, { signal }) => { observedSignal = signal; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) }
  await assert.rejects(requestJson('/api', {}, 10), error => error.message === 'REQUEST_TIMEOUT')
  assert.equal(observedSignal.aborted, true)
})
test('deadline also bounds response body decoding', async () => {
  globalThis.fetch = async (_url, { signal }) => ({ ok: true, status: 200, json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('body aborted', 'AbortError')))) })
  await assert.rejects(requestJson('/api', {}, 10), error => error.message === 'REQUEST_TIMEOUT')
})
test('explicit cancellation is preserved and pre-cancelled requests do not fetch', async () => {
  const controller = new AbortController(); const reason = new DOMException('navigation', 'AbortError'); controller.abort(reason)
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response('{}') }
  await assert.rejects(requestJson('/api', { signal: controller.signal }), error => error === reason)
  assert.equal(calls, 0)
})
test('server failures require mutation confirmation and errors have useful text', async () => {
  globalThis.fetch = async () => new Response('bad gateway', { status: 502 })
  await assert.rejects(requestJson('/api'), error => error.message === 'SERVER_UNAVAILABLE' && uncertainWrite(error))
  assert.match(errorMessage(new RequestError('NETWORK_ERROR')), /无法连接学习服务/)
  assert.equal(errorMessage(new Error('VERSION_CONFLICT')), 'VERSION_CONFLICT')
})
