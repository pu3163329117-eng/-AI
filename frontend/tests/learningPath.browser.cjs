async (page) => {
  const assert = (value, label) => { if (!value) throw new Error(label) }
  const profileId = await page.evaluate(() => localStorage.getItem('wenyan.profile-id'))
  assert(profileId === 'e31f82d0-914d-45e0-a998-4722c7307d38', 'Only dedicated QA profile allowed')
  const root = `http://127.0.0.1:5173/api/v1/profiles/${profileId}`
  const read = async () => (await (await page.request.get(`${root}/recommendations`)).json()).plan
  const layouts = async (name, target) => {
    for (const width of [1440, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await target.scrollIntoViewIfNeeded()
      const valid = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
      assert(valid, `${name} overflow at ${width}`)
      await page.screenshot({ path: `output/playwright/learning-path-${name}-${width}.png`, fullPage: true })
    }
  }
  await page.goto('http://127.0.0.1:5173/#/home')
  await page.getByRole('heading', { name: '下一步，带着理由去读。' }).waitFor()
  await page.getByRole('heading', { name: '尚未生成学习路线。' }).waitFor()
  await layouts('uncreated', page.locator('.recommendation-queue'))
  await page.setViewportSize({ width: 1440, height: 900 })
  const postPattern = `**/api/v1/profiles/${profileId}/recommendations`
  let lost = false; const keys = []
  await page.route(postPattern, async route => {
    if (route.request().method() !== 'POST') return route.continue()
    keys.push(route.request().headers()['idempotency-key'])
    if (!lost) { lost = true; await route.fetch(); await route.abort('failed') }
    else await route.continue()
  })
  await page.getByRole('radio', { name: 'L2 · 通篇理解', exact: true }).check()
  await page.getByRole('button', { name: '确认起点并生成学习队列', exact: true }).click()
  await page.getByRole('button', { name: '恢复上一次提交', exact: true }).waitFor()
  const committed = await read()
  assert(committed && committed.practice_level === 'L2' && committed.tasks.length === 0, 'Empty honest queue committed')
  assert(await page.getByRole('button', { name: /确认起点并生成学习队列/ }).isDisabled(), 'Unknown write blocks new generation')
  await page.getByRole('button', { name: '恢复上一次提交', exact: true }).click()
  await page.getByRole('heading', { name: '当前还没有合格的推荐任务。' }).waitFor()
  assert(keys.length === 2 && keys[0] && keys[0] === keys[1], 'Same idempotency key recovers')
  assert((await read()).id === committed.id, 'Recovery did not duplicate plan')
  await page.unroute(postPattern)
  await page.reload()
  await page.getByRole('heading', { name: '当前还没有合格的推荐任务。' }).waitFor()
  assert(await page.getByRole('radio', { name: 'L2 · 通篇理解', exact: true }).isChecked(), 'Explicit practice choice persisted')
  await page.getByRole('button', { name: '确认起点并生成／读取队列', exact: true }).click()
  await page.getByText('队列已由服务端确认。刷新读取不会再生成任务。', { exact: true }).waitFor()
  assert((await read()).id === committed.id, 'New key with unchanged empty plan reuses identity')
  await layouts('empty', page.locator('.recommendation-queue'))
  await page.goto('http://127.0.0.1:5173/#/report')
  await page.getByRole('heading', { name: '正式评测档案：待评估', exact: true }).waitFor()
  assert(await page.locator('.path-dimension-list meter').count() === 0, 'Pilot did not fill formal meters')
  await page.getByRole('heading', { name: '最近一次能力试测', exact: true }).waitFor()
  await layouts('report', page.locator('.ability-profile-panel'))
  await page.getByText('查看测评来源历史（2 条）', { exact: true }).click()
  assert(await page.locator('.path-ability-history').getByText(/题库 assessment-pilot-v2 · 评分 equal-tier-24-v1/).count() === 2, 'Versions visible in historical results')
  const abilityPattern = `**/api/v1/profiles/${profileId}/ability`
  await page.route(abilityPattern, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ability":{"dimensions":null}}' }))
  await page.reload()
  await page.getByRole('button', { name: '重新读取能力档案', exact: true }).waitFor()
  assert(await page.locator('.path-dimension-list').count() === 0, 'Invalid response not presented as empty ability')
  await page.unroute(abilityPattern)
  await page.getByRole('button', { name: '重新读取能力档案', exact: true }).click()
  await page.getByRole('heading', { name: '正式评测档案：待评估', exact: true }).waitFor()
  await page.route(postPattern, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"SERVER_UNAVAILABLE"}}' }))
  await page.goto('http://127.0.0.1:5173/#/home')
  await page.getByRole('button', { name: '重新读取队列', exact: true }).waitFor()
  assert(await page.locator('.path-task-groups').count() === 0, 'Read failure did not fabricate tasks')
  await page.unroute(postPattern)
  await page.getByRole('button', { name: '重新读取队列', exact: true }).click()
  await page.getByRole('heading', { name: '当前还没有合格的推荐任务。' }).waitFor()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('radio', { name: 'L2 · 通篇理解', exact: true }).focus()
  assert(await page.evaluate(() => document.activeElement?.tagName === 'INPUT'), 'Keyboard focus on native practice choice')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.setViewportSize({ width: 1440, height: 900 })
}
