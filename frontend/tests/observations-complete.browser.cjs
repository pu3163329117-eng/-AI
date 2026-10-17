async (page) => {
  const assert = (value, label) => { if (!value) throw new Error(label) }
  const profileId = await page.evaluate(() => localStorage.getItem('wenyan.profile-id'))
  assert(profileId === '87ea4e45-33a4-45a6-98a0-0667723c84e7', 'Dedicated D QA only')
  const sessionId = 'fb9865eb-af67-4de1-b60d-58537449dff7'
  const root = 'http://127.0.0.1:5173/api/v1'
  const read = async path => { const response = await page.request.get(root + path); assert(response.ok(), path); return response.json() }
  const session = async () => (await read(`/training/sessions/${sessionId}`)).session
  const layouts = async (label, target) => {
    for (const width of [1440, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 900 }); await target.scrollIntoViewIfNeeded()
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${label} overflow ${width}`)
      await page.screenshot({ path: `output/playwright/observations-${label}-${width}.png`, fullPage: true })
    }
    await page.setViewportSize({ width: 1440, height: 900 })
  }
  const saveEvidence = async () => {
    const state = await session()
    await page.getByRole('radio', { name: state.correct_answer, exact: true }).check()
    const pi = state.reading_context.paragraphs.findIndex(p => p.includes(state.evidence))
    assert(pi >= 0, 'Real frozen evidence found')
    const paragraph = state.reading_context.paragraphs[pi]
    const start = Array.from(paragraph.slice(0, paragraph.indexOf(state.evidence))).length
    const end = start + Array.from(state.evidence).length
    await page.getByRole('button', { name: '选择任意词组', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(`^第 ${pi + 1} 段第 ${start + 1} 字，`) }).click()
    await page.getByRole('button', { name: new RegExp(`^第 ${pi + 1} 段第 ${end} 字，`) }).click()
    await page.waitForFunction(({ token }) => document.querySelector('.context-layers strong')?.textContent === `“${token}”`, { token: state.evidence })
    await page.getByRole('button', { name: '将当前原文选段记为证据', exact: true }).click()
    await page.getByRole('textbox', { name: '我的推断理由', exact: true }).fill('原文行为关系支持这个词义；此为测试理由，尚未进行语义复核。')
    await page.getByRole('button', { name: '保存证据与理由', exact: true }).click()
    await page.getByText('证据链已保存，可刷新恢复。', { exact: true }).waitFor()
  }
  await layouts('core-retry', page.locator('.session-observations'))
  await saveEvidence()
  await page.getByRole('button', { name: '提交判断', exact: true }).click()
  await page.getByRole('button', { name: '进入陌生文挑战 →', exact: true }).waitFor()
  let state = await session()
  assert(state.learning_trace.stages.CORE.first_attempt.correct === false && state.learning_trace.stages.CORE.validated && state.learning_trace.stages.CORE.attempt_count === 2, 'First wrong survives final valid')
  await page.getByRole('button', { name: '进入陌生文挑战 →', exact: true }).click()
  await page.getByRole('button', { name: '提交首次词义判断', exact: true }).waitFor()
  state = await session()
  assert(state.learning_trace.stages.TRANSFER.assistance_kinds.length === 0, 'Core assistance did not spill into transfer')
  await page.locator('.text-token').first().click()
  await page.getByRole('button', { name: '查看字词解释（记录为辅助）', exact: true }).waitFor()
  await layouts('transfer-locked', page.locator('.meaning-access-gate'))
  await page.getByRole('button', { name: '需要一点提示', exact: true }).click()
  await page.getByText('本阶段已记录的全部辅助：提示', { exact: true }).waitFor()
  await saveEvidence()
  await page.getByRole('button', { name: '提交首次词义判断', exact: true }).click()
  await page.getByRole('button', { name: '查看本关总结 →', exact: true }).waitFor()
  state = await session()
  assert(state.learning_trace.stages.TRANSFER.first_attempt.assistance_status === 'ASSISTED' && state.learning_trace.stages.TRANSFER.attempt_count === 1, 'Transfer first separately assisted')
  await page.getByRole('button', { name: '查看本关总结 →', exact: true }).click()
  await page.getByText('后续重答完成，与首次表现分开保留。', { exact: true }).waitFor()
  state = await session(); assert(state.completed, 'Complete real training')
  await page.reload(); await page.getByText('后续重答完成，与首次表现分开保留。', { exact: true }).waitFor()
  await layouts('completed', page.locator('.session-observations'))
  await page.goto('http://127.0.0.1:5173/#/report')
  await page.getByRole('heading', { name: '表现有过程，不只看最终答对。', exact: true }).waitFor()
  await page.getByText('查看最近来源记录（2 条，最多 50 条）', { exact: true }).click()
  await page.getByText(/按日查看真实样本/).click()
  const report = (await read(`/profiles/${profileId}/observations/report`)).report
  assert(report.totals.observed_stages === 2 && report.totals.first_no_recorded_assistance.count === 1 && report.totals.first_no_recorded_assistance.correct_count === 0 && report.totals.first_assisted.correct_count === 1 && report.totals.retry_validated_stages === 1, 'Real report first/retry distinction')
  await layouts('report', page.locator('.observation-report'))
  const pattern = `**/api/v1/profiles/${profileId}/observations/report`
  await page.route(pattern, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"report":{"totals":null}}' }))
  await page.reload()
  await page.getByRole('button', { name: '重新读取行为报告', exact: true }).waitFor()
  assert(await page.locator('.observation-group').count() === 0, 'Invalid JSON structure not disguised as zero data')
  await page.unroute(pattern)
  await page.getByRole('button', { name: '重新读取行为报告', exact: true }).click()
  await page.locator('.observation-group').first().waitFor()
  assert((await read(`/profiles/${profileId}/observations/report`)).report.totals.observed_stages === 2, 'Repeated GET no duplicate observations')
  console.log('UI_COMPLETION_FOUR_VIEWPORTS_REPORT_AND_RECOVERY_OK')
}
