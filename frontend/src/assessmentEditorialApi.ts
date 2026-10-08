import { RequestError, requestJson } from './http'
import { validQuestionDetail, validQuestionList, validEditorialWrite, fieldsForQuestion, sameFields, type EditorialWrite } from './assessmentEditorial'

const path = '/api/v1/admin/assessment/questions'
const root = import.meta.env.VITE_API_ROOT ?? ''
export function editorialRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}
export const assessmentEditorialApi = {
  async list(dimension: string, reviewStatus: string, offset: number, signal?: AbortSignal) {
    const params = new URLSearchParams({ limit: '12', offset: String(offset) })
    if (dimension !== 'ALL') params.set('dimension', dimension)
    if (reviewStatus !== 'ALL') params.set('review_status', reviewStatus)
    const response = await requestJson<unknown>(`${root}${path}?${params}`, { signal })
    if (!validQuestionList(response) || response.offset !== offset || response.limit !== 12 || response.items.some(item => (dimension !== 'ALL' && item.question.dimension !== dimension) || (reviewStatus !== 'ALL' && item.question.review_status !== reviewStatus))) throw new RequestError('INVALID_RESPONSE', 200)
    return response
  },
  async get(id: string, signal?: AbortSignal) {
    const response = await requestJson<unknown>(`${root}${path}/${encodeURIComponent(id)}`, { signal })
    if (!validQuestionDetail(response) || response.question.id !== id) throw new RequestError('INVALID_RESPONSE', 200)
    return response
  },
  async write(operation: EditorialWrite) {
    if (!validEditorialWrite(operation)) throw new RequestError('ASSESSMENT_QUESTION_INVALID', 400)
    const response = await requestJson<unknown>(`${root}${path}/${encodeURIComponent(operation.id)}${operation.method === 'POST' ? '/review' : ''}`, {
      method: operation.method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operation.key }, body: JSON.stringify(operation.body),
    })
    if (!validQuestionDetail(response) || response.question.id !== operation.id || response.version !== operation.body.expected_version + 1 || response.actor !== operation.body.actor || response.note !== operation.body.note || response.question.review_status !== (operation.method === 'PATCH' ? 'DRAFT' : operation.body.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED')) throw new RequestError('INVALID_RESPONSE', 200)
    if (operation.method === 'PATCH' && operation.body.question && !sameFields(fieldsForQuestion(response.question), operation.body.question)) throw new RequestError('INVALID_RESPONSE', 200)
    return response
  },
}
