import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const compile = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText).toString('base64')}`
const contractUrl = compile(await readFile(new URL('../src/assessmentEditorial.ts', import.meta.url), 'utf8'))
const contracts = await import(contractUrl)
const transportUrl = compile(await readFile(new URL('../src/http.ts', import.meta.url), 'utf8'))
const transport = await import(transportUrl)
const apiSource = (await readFile(new URL('../src/assessmentEditorialApi.ts', import.meta.url), 'utf8')).replace("'./http'", JSON.stringify(transportUrl)).replace("'./assessmentEditorial'", JSON.stringify(contractUrl)).replace("import.meta.env.VITE_API_ROOT ?? ''", "''")
const { assessmentEditorialApi } = await import(compile(apiSource))
const question = {
  id: 'vocabulary-l1-01', version: 'assessment-pilot-v2', dimension: 'vocabulary', difficulty: 'L1', type: 'choice',
  stem: '句中坐的意思是什么？', source: '《山行》', source_url: 'https://example.org/source', passage: '停车坐爱枫林晚。',
  text_version: 'text-v1', material_extent: 'FULL', passage_extent: 'EXCERPT', paragraph_index: 0, start: 2, end: 10, full_text_start: 2, full_text_end: 10,
  options: [{ id: 'one', text: '因为' }, { id: 'two', text: '坐下' }], answer_id: 'one', explanation: '坐引出停车的原因。', tags: ['lexical-cause'],
  review_status: 'DRAFT', reviewer: null, reviewed_at: null,
}
const detailFor = (q = question, overrides = {}) => ({ question: structuredClone(q), version: 0, revision_version: q.version, actor: null, note: null, updated_at: '2026-10-08T00:00:00Z', reviewer_is_authenticated: false, history: [{ version: q.version, action: 'SEED', actor: null, note: null, created_at: '2026-10-08T00:00:00Z', payload: structuredClone(q) }], ...overrides })
const queueFor = (items = [detailFor()]) => ({ items, total: items.length, limit: 12, offset: 0, disclaimer: '候选题仍需真实人工审核与后续校准。' })
const writeFor = () => ({ id: question.id, key: 'original-key', method: 'PATCH', body: { expected_version: 0, actor: '测试核验者', note: '仅用于接口测试，不是真实审核。', question: contracts.fieldsForQuestion(question) } })
function mutationResult(operation) {
  const q = { ...question, ...(operation.body.question ?? {}), version: 'editorial-v1', review_status: operation.method === 'PATCH' ? 'DRAFT' : operation.body.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' }
  if (q.review_status !== 'DRAFT') { q.reviewer = operation.body.actor; q.reviewed_at = '2026-10-08T00:00:01Z' }
  return detailFor(q, { version: 1, actor: operation.body.actor, note: operation.body.note })
}
function mockFetch(t, fn) { const original = globalThis.fetch; globalThis.fetch = fn; t.after(() => { globalThis.fetch = original }) }
const reply = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

test('explicit source validation failure remains safely readable and rejectable, not approvable', async t => {
  const operation = { id: question.id, key: 'bad-source-rejection', method: 'POST', body: { expected_version: 0, actor: '隔离测试', note: '定位偏移错误', decision: 'REJECT' } }
  const result = mutationResult(operation)
  result.question.full_text_start += 1
  result.history[0].payload.full_text_start += 1
  for (const target of [result, result.history[0]]) { target.validation_valid = false; target.validation_error = 'ASSESSMENT_QUESTION_SPAN_INVALID' }
  assert.equal(contracts.validQuestionDetail(result), true)
  assert.equal(contracts.validQuestionList(queueFor([result])), true)
  assert.equal(contracts.validEditorialQuestion(result.question), false)
  assert.equal(contracts.validEditorialWrite({ ...writeFor(), body: { ...writeFor().body, question: contracts.fieldsForQuestion(result.question) } }), false)
  mockFetch(t, () => reply(result))
  assert.deepEqual(await assessmentEditorialApi.write(operation), result)
  const wrongFlag = structuredClone(result); wrongFlag.validation_valid = true; wrongFlag.validation_error = null
  assert.equal(contracts.validQuestionDetail(wrongFlag), false)
  const noReason = structuredClone(result); noReason.validation_error = ''
  assert.equal(contracts.validQuestionDetail(noReason), false)
})

test('draft, approval and rejection keep their distinct unverified editorial statuses', () => {
  assert.equal(contracts.validQuestionDetail(detailFor()), true)
  for (const review_status of ['APPROVED', 'REJECTED']) {
    const approved = { ...question, review_status, reviewer: '测试署名', reviewed_at: '2026-10-08T00:00:01Z' }
    assert.equal(contracts.validQuestionDetail(detailFor(approved)), true)
    assert.equal(contracts.validEditorialQuestion({ ...approved, reviewer: null }), false)
  }
  assert.equal(contracts.validEditorialQuestion({ ...question, reviewed_at: '2026-10-08T00:00:01Z' }), false)
  assert.equal(contracts.validQuestionDetail({ ...detailFor(), reviewer_is_authenticated: true }), false)
})
test('payload validation rejects bad stable answers, malformed text anchors and unsafe URLs', () => {
  for (const changes of [{ dimension: 'translation' }, { answer_id: 'absent' }, { type: 'open' }, { full_text_end: 11 }, { start: -1 }, { paragraph_index: null }, { source_url: 'javascript:alert(1)' }, { source_url: 'https://user:password@example.org' }, { options: [question.options[0], question.options[0]] }, { tags: ['one', 'one'] }, { stem: ' ' }, { explanation: null }]) assert.equal(contracts.validEditorialQuestion({ ...question, ...changes }), false, JSON.stringify(changes))
  const supplementary = { ...question, passage: '𠮷。', paragraph_index: null, start: null, end: null, full_text_start: 10, full_text_end: 12 }
  assert.equal(contracts.validEditorialQuestion(supplementary), true)
})
test('history validates revision identity, complete snapshots, dates, and current head in either order', () => {
  const current = { ...question, version: 'editorial-v1' }
  const seed = detailFor().history[0]
  const currentEntry = { version: current.version, action: 'EDIT', actor: '测试署名', note: '测试改稿', created_at: '2026-10-08T00:00:01Z', payload: current }
  for (const history of [[currentEntry, seed], [seed, currentEntry]]) assert.equal(contracts.validQuestionDetail(detailFor(current, { version: 1, history })), true)
  for (const changes of [{ history: [] }, { revision_version: 'other' }, { version: -1 }, { version: true }, { history: [{ ...seed, payload: { ...question, explanation: 'wrong snapshot' } }] }, { history: [{ ...seed, created_at: 'not-a-date' }] }, { history: [seed, seed] }]) assert.equal(contracts.validQuestionDetail({ ...detailFor(), ...changes }), false)
})
test('empty queues are real while impossible pagination and duplicate candidates fail closed', () => {
  assert.equal(contracts.validQuestionList(queueFor([])), true)
  for (const changes of [{ total: -1 }, { offset: 1 }, { limit: 0 }, { items: [detailFor(), detailFor()], total: 2 }, { disclaimer: '' }, { items: [{ question }] }]) assert.equal(contracts.validQuestionList({ ...queueFor(), ...changes }), false)
  for (const malformed of [null, [], {}, 'list']) assert.equal(contracts.validQuestionList(malformed), false)
})
test('PATCH allow-list strips answer-bearing server revision and editorial metadata', () => {
  const fields = contracts.fieldsForQuestion({ ...question, editorial: { head_version: 10, actor: 'old signer' }, arbitrary_extra: true })
  for (const key of ['id', 'version', 'review_status', 'reviewer', 'reviewed_at', 'editorial', 'arbitrary_extra']) assert.equal(Object.hasOwn(fields, key), false)
  fields.options[0].text = 'changed'
  fields.tags.push('new')
  assert.equal(question.options[0].text, '因为')
  assert.equal(question.tags.length, 1)
})
test('pending operation guards preserve expected revision, identity, exact action and actual actor', () => {
  assert.equal(contracts.validEditorialWrite(writeFor()), true)
  const review = { ...writeFor(), method: 'POST', body: { expected_version: 0, actor: '测试署名', note: '核验依据', decision: 'REJECT' } }
  assert.equal(contracts.validEditorialWrite(review), true)
  for (const changes of [{ key: '' }, { body: { ...writeFor().body, actor: ' ' } }, { body: { ...writeFor().body, expected_version: -1 } }, { body: { ...writeFor().body, decision: 'APPROVE' } }, { body: { ...writeFor().body, question } }, { method: 'DELETE' }]) assert.equal(contracts.validEditorialWrite({ ...writeFor(), ...changes }), false)
})
test('draft issues distinguish saved content equality from valid human review', () => {
  const fields = contracts.fieldsForQuestion(question)
  assert.equal(contracts.sameFields(fields, contracts.fieldsForQuestion(question)), true)
  assert.deepEqual(contracts.editorialDraftIssues(fields), [])
  fields.stem = ''
  fields.options[1].text = fields.options[0].text
  fields.tags = Array.from({ length: 31 }, (_, index) => `tag-${index}`)
  assert.equal(contracts.sameFields(fields, contracts.fieldsForQuestion(question)), false)
  assert.equal(contracts.editorialDraftIssues(fields).length, 3)
})
test('list transport validates requested dimension, state and exact pagination', async t => {
  let url
  mockFetch(t, async value => { url = String(value); return reply(queueFor()) })
  await assessmentEditorialApi.list('vocabulary', 'DRAFT', 0)
  const query = new URL(url, 'http://local').searchParams
  assert.equal(query.get('dimension'), 'vocabulary')
  assert.equal(query.get('review_status'), 'DRAFT')
  assert.equal(query.get('limit'), '12')
  await assert.rejects(assessmentEditorialApi.list('syntax', 'DRAFT', 0), { message: 'INVALID_RESPONSE' })
  await assert.rejects(assessmentEditorialApi.list('ALL', 'ALL', 12), { message: 'INVALID_RESPONSE' })
})
test('detail transport checks requested identity before showing an answer-bearing payload', async t => {
  mockFetch(t, async () => reply(detailFor()))
  assert.equal((await assessmentEditorialApi.get(question.id)).question.id, question.id)
  await assert.rejects(assessmentEditorialApi.get('other'), { message: 'INVALID_RESPONSE' })
})
test('lost-response recovery uses original method, original body and original idempotency key', async t => {
  const operation = writeFor()
  const seen = []
  mockFetch(t, async (url, init) => {
    seen.push({ url, method: init.method, body: init.body, key: init.headers['Idempotency-Key'] })
    if (seen.length === 1) throw new Error('injected lost response')
    return reply(mutationResult(operation))
  })
  await assert.rejects(assessmentEditorialApi.write(operation), error => transport.uncertainWrite(error))
  await assessmentEditorialApi.write(operation)
  assert.deepEqual(seen[0], seen[1])
  assert.equal(seen.length, 2)
})
test('mutation responses validate committed action, expected next revision and actor before acknowledgement', async t => {
  const operation = { ...writeFor(), method: 'POST', body: { expected_version: 0, actor: '测试署名', note: '测试人工依据', decision: 'APPROVE' } }
  let response = mutationResult(operation)
  mockFetch(t, async (url, init) => { assert.equal(String(url).endsWith('/review'), true); assert.equal(init.method, 'POST'); return reply(response) })
  assert.equal((await assessmentEditorialApi.write(operation)).question.review_status, 'APPROVED')
  response = { ...response, actor: 'other' }
  await assert.rejects(assessmentEditorialApi.write(operation), error => error.message === 'INVALID_RESPONSE' && transport.uncertainWrite(error))
})
test('explicit conflicts stop a write rather than retrying or replacing its key', async t => {
  let calls = 0
  mockFetch(t, async () => { calls++; return new Response(JSON.stringify({ error: { code: 'ASSESSMENT_QUESTION_VERSION_CONFLICT' } }), { status: 409 }) })
  await assert.rejects(assessmentEditorialApi.write(writeFor()), error => error.message === 'ASSESSMENT_QUESTION_VERSION_CONFLICT' && !transport.uncertainWrite(error))
  assert.equal(calls, 1)
})
test('a committed PATCH response cannot silently substitute another saved stem', async t => {
  const operation = writeFor()
  const result = mutationResult(operation)
  result.question.stem = '服务误回了别的草稿内容'
  result.history[0].payload.stem = result.question.stem
  mockFetch(t, async () => reply(result))
  await assert.rejects(assessmentEditorialApi.write(operation), error => error.message === 'INVALID_RESPONSE' && transport.uncertainWrite(error))
})
