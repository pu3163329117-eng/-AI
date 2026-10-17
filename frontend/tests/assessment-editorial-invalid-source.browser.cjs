async (page) => {
  await page.unroute('**/api/v1/admin/assessment/questions/chapter-l1-01*')
  const endpoint = 'http://127.0.0.1:8001/api/v1/admin/assessment/questions/chapter-l1-01'
  const original = await (await page.request.get(endpoint)).json()
  const broken = structuredClone(original)
  Object.assign(broken.question, { review_status: 'DRAFT', reviewer: null, reviewed_at: null })
  broken.history[0].payload = structuredClone(broken.question)
  broken.history[0].action = 'EDIT'
  broken.question.full_text_start += 1
  broken.history[0].payload.full_text_start += 1
  for (const item of [broken, broken.history[0]]) { item.validation_valid = false; item.validation_error = 'ASSESSMENT_QUESTION_SPAN_INVALID' }
  const pattern = '**/api/v1/admin/assessment/questions/chapter-l1-01**'
  await page.route(pattern, async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: broken })
    const body = route.request().postDataJSON()
    if (body.decision !== 'REJECT') throw new Error('Invalid-source approval must never be sent')
    const response = structuredClone(broken)
    const version = 'fault-injection-rejected-v1'
    const stamp = new Date().toISOString()
    response.version += 1; response.revision_version = version; response.actor = body.actor; response.note = body.note
    Object.assign(response.question, { version, review_status: 'REJECTED', reviewer: body.actor, reviewed_at: stamp })
    response.history.unshift({ version, action: 'REJECT', actor: body.actor, note: body.note, created_at: stamp,
      payload: structuredClone(response.question), validation_valid: false, validation_error: response.validation_error })
    return route.fulfill({ json: response })
  })
  await page.getByRole('button', { name: '重新读取当前题目', exact: true }).click()
  await page.getByText(/当前题目或来源定位未通过校验/).waitFor()
  await page.getByRole('textbox', { name: '本次编辑／审核人', exact: true }).fill('异常来源模拟测试')
  await page.getByRole('textbox', { name: '本次核验依据／修改说明', exact: true }).fill('只模拟错误定位退回响应，不写任何运行库。')
  if (!await page.getByRole('button', { name: '审核通过当前版本', exact: true }).isDisabled()) throw new Error('Invalid-source approval enabled')
  await page.getByRole('button', { name: '退回当前版本', exact: true }).click()
  await page.getByText('当前版本已退回，退回依据已保留。后续修改后须重新审核。', { exact: true }).waitFor()
  if (await page.getByRole('region', { name: '未确认的教研操作' }).count()) throw new Error('Rejected invalid source misclassified as unknown')
  if ((await (await page.request.get(endpoint)).json()).version !== original.version) throw new Error('Mock unexpectedly mutated isolated DB')
  await page.unroute(pattern)
  return 'INVALID_SOURCE_WARNING_APPROVAL_BLOCKED_REJECTION_CONFIRMED_NO_WRITE_OK'
}
