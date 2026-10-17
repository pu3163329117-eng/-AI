async (page) => {
  const assert = (value, label) => { if (!value) throw new Error(label) }
  const profileId = await page.evaluate(() => localStorage.getItem('wenyan.profile-id'))
  assert(profileId === 'e31f82d0-914d-45e0-a998-4722c7307d38', 'Only dedicated QA profile allowed')
  await page.goto('http://127.0.0.1:5173/#/assessment')
  await page.reload()
  await page.locator('.assessment-intro, .assessment-workspace').first().waitFor()
  if (await page.locator('.assessment-intro').count()) {
    assert(await page.getByRole('button', { name: '正式测评（尚未开放）' }).isDisabled(), 'Formal gated')
    await page.getByRole('button', { name: '先做四道轻自评，再开始试测' }).click()
    for (const name of ['暂时不确定', '独立读懂文章', '先联系上下文推断', '会尝试独立阅读']) await page.getByRole('radio', { name, exact: true }).check()
    await page.getByRole('button', { name: '创建 24 题试测' }).click()
  }
  await page.getByRole('heading', { name: '在原文中，独立作判断。' }).waitFor()
  const sessionId = await page.evaluate(id => localStorage.getItem(`wenyan-assessment:${id}`), profileId)
  const read = async () => (await (await page.request.get(`http://127.0.0.1:5173/api/v1/assessments/${sessionId}`)).json()).assessment
  const initial = await read()
  assert(initial.bank_version === 'assessment-pilot-v2' && initial.questions.length === 24 && Object.keys(initial.self_answers).length === 4, 'Frozen bank and survey')
  const sources = initial.questions.reduce((counts, q) => ({ ...counts, [q.source]: (counts[q.source] ?? 0) + 1 }), {})
  assert(Object.keys(sources).length >= 4 && Math.max(...Object.values(sources)) <= 6, 'Source diversity')
  assert(initial.questions.every(q => !('answer_id' in q) && !('explanation' in q) && q.text_version && q.passage_extent), 'No leakage')
  const render = async state => {
    const layouts = []
    for (const width of [1440, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(() => window.scrollTo(0, 0))
      const layout = await page.evaluate(() => ({ width: innerWidth, client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
      assert(layout.scroll <= layout.client, `${state} overflow ${width}`); layouts.push(layout)
      await page.screenshot({ path: `output/playwright/assessment-${state}-${width}.png`, fullPage: true })
    }
    console.log(`ASSESSMENT_${state.toUpperCase()}_LAYOUT`, JSON.stringify(layouts))
  }
  await render('active'); await page.setViewportSize({ width: 1440, height: 900 })
  if (initial.state_version === 0) {
  let lost = false
  const pattern = `**/api/v1/assessments/${sessionId}/commands`
  await page.route(pattern, async route => { if (!lost) { lost = true; await route.fetch(); await route.abort('failed') } else await route.continue() })
  await page.locator('.assessment-options input').first().check()
  await page.getByRole('button', { name: '保存并下一题', exact: true }).click()
  await page.getByRole('button', { name: '恢复上一次提交' }).waitFor()
  assert((await read()).state_version === 1, 'Lost response committed once')
  await page.getByRole('button', { name: '恢复上一次提交' }).click()
  await page.getByText('第 2 / 24 题', { exact: false }).waitFor()
  assert((await read()).state_version === 1, 'Recovery uses same receipt')
  await page.unroute(pattern); await page.reload()
  await page.getByText('第 2 / 24 题', { exact: false }).waitFor()
  assert(JSON.stringify(initial.questions) === JSON.stringify((await read()).questions), 'Reload preserves order')
  console.log('ASSESSMENT_LOST_RESTORE passed', sessionId)
  }
  for (let i = (await read()).current_index; i < 24; i++) {
    await page.getByText(`第 ${i + 1} / 24 题`, { exact: false }).waitFor()
    const confirmed = page.waitForResponse(response => response.url().endsWith(`/assessments/${sessionId}/commands`) && response.request().method() === 'POST')
    if (i === 7) await page.getByRole('button', { name: '明确跳过本题' }).click()
    else { await page.locator('.assessment-options input').nth(i % 4).check(); await page.getByRole('button', { name: i < 23 ? '保存并下一题' : '保存本题', exact: true }).click() }
    assert((await confirmed).status() === 200, `Command ${i + 1} accepted`)
    assert(Object.keys((await read()).answers).length === i + 1, `Answer ${i + 1} confirmed`)
  }
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '确认交卷并查看结果' }).click()
  await page.getByRole('heading', { name: '看见表现，也看见边界。' }).waitFor()
  const completed = await read()
  assert(completed.status === 'COMPLETED' && completed.result.suggested_level === null && completed.result.level_status === 'PILOT_ONLY' && completed.result.review.length === 24, 'Pilot result honest')
  assert(Object.values(completed.result.dimensions).reduce((total, d) => total + d.answered_count, 0) === 23, 'Real counts')
  await render('result'); await page.reload(); await page.getByRole('heading', { name: '看见表现，也看见边界。' }).waitFor()
  console.log('ASSESSMENT_FULL_LOOP', JSON.stringify({ id: sessionId, score: completed.result.overall_score, answered: 23, skipped: 1, version: completed.state_version, level: completed.result.suggested_level }))
}
