async (page) => {
  const assert = (value, label) => { if (!value) throw new Error(label) }
  const profileId = await page.evaluate(() => localStorage.getItem('wenyan.profile-id'))
  assert(profileId === 'e31f82d0-914d-45e0-a998-4722c7307d38', 'Only dedicated QA profile allowed')
  const root = `http://127.0.0.1:5173/api/v1/profiles/${profileId}`
  const sessions = (await (await page.request.get(`${root}/sessions`)).json()).sessions
  assert(sessions.length > 0, 'QA owned training fixture available')
  const sessionId = sessions[0].session_id || sessions[0].id
  assert(sessionId, 'Owned session identity')
  const session = (await (await page.request.get(`http://127.0.0.1:5173/api/v1/training/sessions/${sessionId}`)).json()).session
  assert(session.profile_id === profileId, 'Owned frozen training only')
  const frozen = { ...session, completed: false, summary_ready: false, transfer_ready: false, state: 'AWAITING_INITIAL_ATTEMPT', selected_answer: null }
  const base = { lesson_id: session.lesson.id, title: session.lesson.title, task_type: 'FOCUSED_PRACTICE', ability_level: 'L2', dimension_tags: ['vocabulary', 'context'], content_version: '123456789abc', source: session.source, material_extent: 'EXCERPT', reason: '浏览器隔离夹具：验证长内容版本说明与操作状态，不代表真实教研审核。', unavailable_reason: null }
  const plan = { id: 'browser-fixture-plan', profile_id: profileId, practice_level: 'L2', level_source: 'USER_CHOICE', created_at: '2026-10-07T00:00:00Z', explanation: '隔离浏览器验证，未写入运行数据库。', tasks: [
    { ...base, id: 'browser-fixture-main', category: 'MAIN', status: 'READY', session_id: null },
    { ...base, id: 'browser-fixture-reinforcement', category: 'REINFORCEMENT', status: 'IN_PROGRESS', session_id: sessionId },
    { ...base, id: 'browser-fixture-challenge', category: 'CHALLENGE', status: 'COMPLETED', session_id: sessionId }
  ], gaps: ['真实内容范围与版本需要满足审核要求，不以夹具登记教研审核。'] }
  const planPattern = `**/api/v1/profiles/${profileId}/recommendations`
  const startPattern = `**/api/v1/profiles/${profileId}/recommendations/*/start`
  const trainingPattern = `**/api/v1/training/sessions/${sessionId}`
  const abilityPattern = `**/api/v1/profiles/${profileId}/ability`
  await page.route(planPattern, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ plan }) }))
  await page.route(trainingPattern, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session: frozen }) }))
  let lost = false; const keys = []
  await page.route(startPattern, async route => {
    keys.push(route.request().headers()['idempotency-key'])
    const task = plan.tasks.find(task => route.request().url().includes(task.id))
    assert(task, 'Fixture task identity')
    task.session_id = sessionId; task.status = 'IN_PROGRESS'
    if (!lost) { lost = true; return route.abort('failed') }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session_id: sessionId, session: frozen, task }) })
  })
  await page.goto('http://127.0.0.1:5173/#/home')
  await page.reload()
  await page.getByRole('heading', { name: '主线学习 · 1 项', exact: true }).waitFor()
  for (const width of [1440, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await page.evaluate(() => scrollTo(0, 0))
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `filled overflow ${width}`)
    await page.screenshot({ path: `output/playwright/learning-path-filled-${width}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: '开始这条训练', exact: true }).click()
  await page.getByRole('button', { name: '恢复上一次提交', exact: true }).waitFor()
  assert(await page.getByRole('button', { name: '继续这条训练', exact: true }).isDisabled(), 'Unknown start locks other task')
  await page.getByRole('button', { name: '恢复上一次提交', exact: true }).click()
  await page.waitForURL(`**/#/training/${sessionId}`)
  await page.locator('.training-page').waitFor()
  assert(keys.length === 2 && keys[0] === keys[1], 'Unknown start uses same key and navigates')
  await page.goto('http://127.0.0.1:5173/#/home')
  await page.getByRole('button', { name: '回看已完成训练', exact: true }).waitFor()
  await page.getByRole('radio', { name: 'L3 · 深入阅读', exact: true }).check()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: '回看已完成训练', exact: true }).click()
  await page.waitForURL(`**/#/training/${sessionId}`)
  const ability = (await (await page.request.get(`${root}/ability`)).json()).ability
  Object.assign(ability, { level: 'L2', level_status: 'PROVISIONAL', source_assessment_id: 'browser-formal-fixture', bank_version: 'browser-reviewed-fixture', scoring_version: 'browser-scoring-fixture', assessed_at: '2026-10-07T00:00:00Z' })
  for (const dimension of ['vocabulary', 'syntax', 'context', 'chapter']) ability.dimensions[dimension] = { score: 66.7, presented_count: 6, answered_count: 6, correct_count: 4, source_assessment_id: 'browser-formal-fixture' }
  ability.explanation = '浏览器隔离正式画像夹具，仅验证有来源分数的布局，不写入运行数据库。'
  await page.route(abilityPattern, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ability }) }))
  await page.goto('http://127.0.0.1:5173/#/report')
  await page.getByRole('heading', { name: '正式评测档案：L2 · 试行建议', exact: true }).waitFor()
  assert(await page.locator('.path-dimension-list meter').count() === 4, 'Only measured formal dimensions render')
  for (const width of [1440, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await page.evaluate(() => scrollTo(0, 0))
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `formal fixture overflow ${width}`)
    await page.screenshot({ path: `output/playwright/learning-path-formal-fixture-${width}.png`, fullPage: true })
  }
  for (const pattern of [planPattern, startPattern, trainingPattern, abilityPattern]) await page.unroute(pattern)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('http://127.0.0.1:5173/#/report'); await page.reload()
  await page.getByRole('heading', { name: '正式评测档案：待评估', exact: true }).waitFor()
  await page.evaluate(() => scrollTo(0, 0))
  await page.screenshot({ path: 'output/playwright/learning-path-real-report-viewport.png' })
}
