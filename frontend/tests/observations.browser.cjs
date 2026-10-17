async (page) => {
  const assert = (value, label) => { if (!value) throw new Error(label) }
  const read = async (url) => { const response = await page.request.get(url); assert(response.ok(), `GET ${url}`); return response.json() }
  const post = async (url, data) => { const response = await page.request.post(url, { data }); assert(response.ok(), `POST ${url}: ${await response.text()}`); return response.json() }
  const root = 'http://127.0.0.1:5173/api/v1'
  const oldId = await page.evaluate(() => localStorage.getItem('wenyan.profile-id'))
  assert(oldId === '87ea4e45-33a4-45a6-98a0-0667723c84e7', 'Dedicated observation QA browser only')
  const legacy = (await read(`${root}/profiles/e31f82d0-914d-45e0-a998-4722c7307d38/observations/report`)).report
  assert(legacy.totals.unknown_stages === 4 && legacy.totals.observed_stages === 0, 'Legacy stays UNKNOWN')
  const profile = { id: oldId }
  const session_id = 'fb9865eb-af67-4de1-b60d-58537449dff7'
  const { session } = await read(`${root}/training/sessions/${session_id}`)
  await page.evaluate(({ profileId, sessionId }) => { localStorage.setItem('wenyan.profile-id', profileId); localStorage.setItem('wenyan.session-id', sessionId) }, { profileId: profile.id, sessionId: session_id })
  await page.goto(`http://127.0.0.1:5173/#/training/${session_id}`)
  await page.reload()
  await page.getByRole('button', { name: '提交首次词义判断', exact: true }).waitFor()
  let lookups = 0
  page.on('request', request => { if (request.url().includes('/api/knowledge/lookup')) lookups++ })
  await page.locator('.text-token').first().click()
  await page.getByRole('button', { name: '查看字词解释（记录为辅助）', exact: true }).waitFor()
  await page.getByRole('button', { name: '篇', exact: true }).click()
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.context-layers button')).some(button => button.textContent === '篇' && button.getAttribute('aria-pressed') === 'true'))
  let state = (await read(`${root}/training/sessions/${session_id}`)).session
  assert(state.learning_trace.stages.CORE.assistance_kinds.length === 0 && lookups === 0, 'Raw reading does not record assistance or prefetch meaning')
  const wrong = session.choices.find(choice => choice !== session.correct_answer)
  await page.getByRole('radio', { name: wrong, exact: true }).check()
  await page.getByRole('button', { name: '提交首次词义判断', exact: true }).click()
  await page.getByText(`首次词义选择：“${wrong}” · 词义选项尚未正确`, { exact: true }).waitFor()
  state = (await read(`${root}/training/sessions/${session_id}`)).session
  assert(state.learning_trace.stages.CORE.first_attempt.assistance_status === 'NONE_RECORDED', 'Wrong first frozen without recorded assistance')
  const pattern = `**/training/sessions/${session_id}/commands`
  let lost = false; const keys = []
  await page.route(pattern, async route => {
    const data = route.request().postDataJSON()
    if (data.type !== 'RECORD_ASSISTANCE') return route.continue()
    keys.push(route.request().headers()['idempotency-key'])
    if (!lost) { lost = true; await route.fetch(); await route.abort('failed') } else await route.continue()
  })
  await page.getByRole('button', { name: '查看字词解释（记录为辅助）', exact: true }).click()
  await page.getByRole('button', { name: '核对并重试刚才操作', exact: true }).waitFor()
  assert(lookups === 0 && await page.getByRole('button', { name: '查看字词解释（记录为辅助）', exact: true }).isDisabled(), 'Lost assistance response does not reveal meaning')
  await page.screenshot({ path: 'output/playwright/observations-lost-response.png', fullPage: true })
  await page.getByRole('button', { name: '核对并重试刚才操作', exact: true }).click()
  await page.locator('.meaning-access-gate').waitFor({ state: 'detached' })
  assert(keys.length === 2 && keys[0] === keys[1], 'Exact assistance request recovered')
  await page.unroute(pattern)
  await page.reload()
  await page.getByRole('button', { name: '提交判断', exact: true }).waitFor()
  state = (await read(`${root}/training/sessions/${session_id}`)).session
  assert(state.learning_trace.stages.CORE.first_attempt.answer === wrong, 'Reload preserves first wrong choice')
  console.log(JSON.stringify({ phase: 'UI_FIRST_AND_LOST_RESPONSE_OK', profile_id: profile.id, session_id }))
}
