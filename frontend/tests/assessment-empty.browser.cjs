async (page) => {
  const assert = (value, label) => { if (!value) throw new Error(label) }
  const profileId = await page.evaluate(() => localStorage.getItem('wenyan.profile-id'))
  assert(profileId === 'e31f82d0-914d-45e0-a998-4722c7307d38', 'QA profile only')
  await page.getByRole('button', { name: '查看试测入口与历史' }).click()
  await page.getByRole('button', { name: '先做四道轻自评，再开始试测' }).click()
  await page.getByRole('button', { name: '创建 24 题试测' }).click()
  await page.getByRole('heading', { name: '在原文中，独立作判断。' }).waitFor()
  const sessionId = await page.evaluate(id => localStorage.getItem(`wenyan-assessment:${id}`), profileId)
  for (let i = 0; i < 24; i++) {
    await page.getByText(`第 ${i + 1} / 24 题`, { exact: false }).waitFor()
    const confirmed = page.waitForResponse(response => response.url().endsWith(`/assessments/${sessionId}/commands`) && response.request().method() === 'POST')
    await page.getByRole('button', { name: '明确跳过本题' }).click()
    assert((await confirmed).status() === 200, 'Explicit skip accepted')
  }
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: '确认交卷并查看结果' }).click()
  await page.getByRole('heading', { name: '看见表现，也看见边界。' }).waitFor()
  const result = (await (await page.request.get(`http://127.0.0.1:5173/api/v1/assessments/${sessionId}`)).json()).assessment.result
  assert(result.overall_score === null && result.suggested_level === null && result.sufficiency === 'INSUFFICIENT', 'No fabricated zero or level')
  assert(Object.values(result.dimensions).every(dimension => dimension.score === null && dimension.answered_count === 0 && dimension.skipped_count === 6), 'Unknown dimensions remain null')
  assert(await page.locator('.assessment-dimensions meter').count() === 0, 'Unknown ability has no zero meter')
  await page.setViewportSize({ width: 390, height: 900 })
  await page.screenshot({ path: 'output/playwright/assessment-all-skipped-390.png', fullPage: true })
  console.log('ASSESSMENT_ALL_SKIPPED', JSON.stringify({ id: sessionId, overall_score: result.overall_score, sufficiency: result.sufficiency }))
}
