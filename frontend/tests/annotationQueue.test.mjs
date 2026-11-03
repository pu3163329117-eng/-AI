import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { importSource } from './import-source.mjs'

const queue = await importSource('annotationQueue.ts')
const document = 'baac4b56-38e4-41dd-92d4-c2d2e7327c90'
const row = (overrides = {}) => ({ id: '40cf551c-c062-4be1-a70b-a6dec3e50ef6', document_id: document,
  source: '合成资料', paragraph_index: 0, token: '于', start: 0, end: 1, sentence: '于此。',
  meaning: '在', part_of_speech: '介词', variability: 'CONTEXTUAL', reasoning: '合成核对说明',
  sense_key: '', status: 'DRAFT', version: 0, citation: '', source_url: null, ...overrides })
const value = (overrides = {}) => ({ total: 1, items: [row()], ...overrides })

test('gap queries are bounded and blank checking matches all Python editorial whitespace', () => {
  for (const gap of ['ALL', 'MISSING_CITATION', 'MISSING_SOURCE_URL', 'MISSING_EITHER']) {
    assert.equal(queue.validQueueQuery(document, 'ALL', '于', 0, gap), true)
    assert.equal(queue.matchesAnnotationQueue(value(), document, 'ALL', 0, gap), true)
  }
  for (const whitespace of ['\u0085', '\u001c\u001d\u001e\u001f', '\u3000\u00a0', '\n\t\r', '\u2028\u2029', '\u2000\u205f']) {
    assert.equal(queue.matchesAnnotationQueue(value({ items: [row({ citation: whitespace, source_url: whitespace })] }), document, 'DRAFT', 0, 'MISSING_EITHER'), true)
  }
  for (const args of [['', 'ALL', '', 0, 'ALL'], [document, 'unknown', '', 0, 'ALL'], [document, 'ALL', '', -1, 'ALL'],
    [document, 'ALL', '', 1.5, 'ALL'], [document, 'ALL', '', Number.MAX_SAFE_INTEGER + 1, 'ALL'],
    [document, 'ALL', '', 0, 'unknown'], [document, 'ALL', 'x'.repeat(81), 0, 'ALL']]) assert.equal(queue.validQueueQuery(...args), false)
})

test('effective source gaps are OR, never a certification or AND check', () => {
  const cited = value({ items: [row({ citation: '实际出处' })] })
  assert.equal(queue.matchesAnnotationQueue(cited, document, 'ALL', 0, 'MISSING_CITATION'), false)
  assert.equal(queue.matchesAnnotationQueue(cited, document, 'ALL', 0, 'MISSING_EITHER'), true)
  const linked = value({ items: [row({ source_url: 'https://example.org/source' })] })
  assert.equal(queue.matchesAnnotationQueue(linked, document, 'ALL', 0, 'MISSING_SOURCE_URL'), false)
  assert.equal(queue.matchesAnnotationQueue(linked, document, 'ALL', 0, 'MISSING_EITHER'), true)
  assert.equal(queue.matchesAnnotationQueue(value({ items: [row({ citation: '出处', source_url: 'https://example.org' })] }), document, 'ALL', 0, 'MISSING_EITHER'), false)
})

test('wrong document/status, duplicates and impossible pages fail, reduced-total empty pages remain recoverable', () => {
  for (const item of [row({ document_id: 'other' }), row({ status: 'APPROVED' })]) assert.equal(queue.matchesAnnotationQueue(value({ items: [item] }), document, 'DRAFT', 0, 'ALL'), false)
  assert.equal(queue.matchesAnnotationQueue(value({ total: 2, items: [row(), row()] }), document, 'ALL', 0, 'ALL'), false)
  for (const data of [value({ total: 0 }), value({ total: 30 }), value({ total: -1 }), value({ total: 1.5 })]) assert.equal(queue.matchesAnnotationQueue(data, document, 'ALL', 0, 'ALL'), false)
  assert.equal(queue.matchesAnnotationQueue({ total: 2, items: [] }, document, 'ALL', 25, 'ALL'), true)
})

const encode = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const source = name => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8')
const observationsUrl = encode(compile(await source('observations.ts')))
const contractsUrl = encode(compile(await source('contracts.ts')).replaceAll("'./observations'", JSON.stringify(observationsUrl)))
const httpUrl = encode(compile(await source('http.ts')))
const queueUrl = encode(compile(await source('annotationQueue.ts')))
const apiCode = compile(await source('api.ts')).replaceAll("'./http'", JSON.stringify(httpUrl))
  .replaceAll("'./contracts'", JSON.stringify(contractsUrl)).replaceAll("'./annotationQueue'", JSON.stringify(queueUrl))
  .replaceAll('import.meta.env.VITE_API_ROOT', 'undefined')
const { annotationApi } = await import(encode(apiCode))
const originalFetch = globalThis.fetch
test.afterEach(() => { globalThis.fetch = originalFetch })

test('list sends one cancellable GET with only declared filters, default ALL remains compatible', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push([url, init]); return new Response(JSON.stringify(value()), { status: 200 }) }
  const controller = new AbortController()
  await annotationApi.list(document, 'ALL', '于', 0, controller.signal)
  const [url, init] = calls[0], query = new URL(url, 'https://example.org').searchParams
  assert.deepEqual(Object.fromEntries(query), { document, status: 'ALL', q: '于', offset: '0', gap: 'ALL' })
  assert.equal(calls.length, 1); assert.equal(init.method ?? 'GET', 'GET'); assert.equal(init.credentials, 'same-origin'); assert.ok(init.signal); assert.equal(init.body, undefined)
  await annotationApi.list(document, 'DRAFT', '', 0, controller.signal, 'MISSING_EITHER')
  assert.equal(new URL(calls[1][0], 'https://example.org').searchParams.get('gap'), 'MISSING_EITHER')
})

test('invalid queries/pre-cancellation do not fetch, bad response and service failure never retry', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(value({ items: [row({ document_id: 'other' })] })), { status: 200 }) }
  const controller = new AbortController()
  await assert.rejects(annotationApi.list(document, 'ALL', '', -1, controller.signal), /INVALID_INPUT/)
  controller.abort(); await assert.rejects(annotationApi.list(document, 'ALL', '', 0, controller.signal)); assert.equal(calls, 0)
  await assert.rejects(annotationApi.list(document, 'ALL', '', 0, new AbortController().signal), /INVALID_RESPONSE/); assert.equal(calls, 1)
  globalThis.fetch = async () => { calls++; return new Response('{"error":{"code":"SYNTHETIC_FAILURE"}}', { status: 503 }) }
  await assert.rejects(annotationApi.list(document, 'ALL', '', 0, new AbortController().signal)); assert.equal(calls, 2)
})
