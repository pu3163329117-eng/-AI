async (page) => {
  const assert = (value, label) => { if (!value) throw new Error(label) }
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  const endpoint = 'http://127.0.0.1:8001/api/v1/admin/assessment/questions/chapter-l1-01'
  const current = () => page.request.get(endpoint).then(response => response.json())
  await page.evaluate(() => { window.confirm = () => true })
  const sign = async () => {
    await page.getByRole('textbox', { name: '本次编辑／审核人', exact: true }).fill('隔离测试，不是真实教研')
    await page.getByRole('textbox', { name: '本次核验依据／修改说明', exact: true }).fill('只验证状态流转，不能迁移为真实审核。')
  }
  assert((await current()).version === 1, 'Recovery did not duplicate')
  await sign()
  await page.getByRole('button', { name: '审核通过当前版本', exact: true }).click()
  await page.getByText('已记录当前版本的人工署名审核。署名未经登录认证；不代表题库已完成正式分级校准。', { exact: true }).waitFor()
  assert((await current()).question.review_status === 'APPROVED', 'Isolated approval')
  await sign()
  await page.getByRole('button', { name: '退回当前版本', exact: true }).click()
  await page.getByText('当前版本已退回，退回依据已保留。后续修改后须重新审核。', { exact: true }).waitFor()
  assert((await current()).question.review_status === 'REJECTED', 'Isolated rejection')
  await page.getByRole('textbox', { name: '题干', exact: true }).fill('结合四句全诗，哪项最符合诗人对秋山的态度？【隔离重新校订】')
  await sign()
  await page.getByRole('button', { name: '保存草稿新版本', exact: true }).click()
  await page.getByText('草稿新版本已保存，原审核失效，须重新人工核对。旧试卷不被覆盖。', { exact: true }).waitFor()
  assert((await current()).question.review_status === 'DRAFT', 'Re-edit clears approval and rejection')
  const history = page.getByText('修订与审核历史 · 6 条', { exact: true })
  await history.focus(); await page.keyboard.press('Enter')
  assert(await history.evaluate(node => node.parentElement.open), 'Keyboard history accessible')
  const badList = '**/api/v1/admin/assessment/questions?*'
  await page.route(badList, route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"QA_SERVER_FAILURE"}}' }))
  await page.getByRole('button', { name: '重新读取候选题列表', exact: true }).click()
  await page.getByText('QA_SERVER_FAILURE', { exact: true }).waitFor()
  assert(await page.locator('.annotation-list button').count() === 0, 'Failed list hides stale data')
  await page.unroute(badList)
  await page.getByRole('button', { name: '重新读取候选题列表', exact: true }).click()
  await page.getByText('48 道候选题 · 第 1–12 道', { exact: true }).waitFor()
  for (const width of [1440, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await page.getByRole('heading', { name: '篇章理解 · L1', exact: true }).scrollIntoViewIfNeeded()
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `No overflow ${width}`)
  }
  assert(errors.length === 0, `Browser errors ${errors.join(';')}`)
  return 'APPROVE_REJECT_REEDIT_KEYBOARD_500_RECOVERY_FOUR_WIDTHS_OK'
}
