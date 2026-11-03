import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { importSource } from './import-source.mjs'

const { supportChannel, supportRoute, supportVersion, supportTemplate, supportMailto, shouldLeaveOnboarding } = await importSource('betaSupport.ts')

test('unconfigured help has no invented receiver and rejects email header injection and placeholder addresses', () => {
  assert.deepEqual(supportChannel(), { email: null, feedbackUrl: null })
  assert.equal(supportChannel('synthetic-test-user@synthetic-test-host.onion').email, 'synthetic-test-user@synthetic-test-host.onion')
  for (const address of ['reader@sample.invalid', 'help@fake.test', 'help@fake.invalid', 'mailto:reader@sample.invalid', 'reader@sample.invalid?bcc=sample.invalid', 'reader@sample.invalid\r\nBcc:reader@sample.invalid', 'hello reader@sample.invalid']) assert.equal(supportChannel(address).email, null)
})

test('official HTTPS link needs an explicit matching origin and cannot contain credentials or automatic query payloads', () => {
  assert.equal(supportChannel('', 'https://support.wenyantuili.com/feedback', 'https://support.wenyantuili.com').feedbackUrl, 'https://support.wenyantuili.com/feedback')
  for (const [url, origin] of [
    ['https://support.wenyantuili.com/feedback', ''],
    ['https://other.com/form', 'https://support.wenyantuili.com'],
    ['http://support.wenyantuili.com/form', 'http://support.wenyantuili.com'],
    ['javascript:alert(1)', 'https://support.wenyantuili.com'],
    ['https://synthetic-test-user:synthetic-test-password@host.invalid/form', 'https://host.invalid'],
    ['https://support.wenyantuili.com/form?email=private', 'https://support.wenyantuili.com'],
    ['https://support.wenyantuili.com/form#token', 'https://support.wenyantuili.com'],
    ['https://support.wenyantuili.com/form', 'https://support.wenyantuili.com/untrusted-path'],
    ['https://localhost/form', 'https://localhost'],
    ['https://127.0.0.1/form', 'https://127.0.0.1'],
    ['https://example.com/form', 'https://example.com'],
    ['https://fake.invalid/form', 'https://fake.invalid'],
  ]) assert.equal(supportChannel('', url, origin).feedbackUrl, null, url)
})

test('route and build metadata never copy training identifiers, URL parameters or arbitrary hashes', () => {
  assert.equal(supportRoute('#/about?private=ignored'), '#/about')
  assert.equal(supportRoute('#/training/01234567-89ab-cdef-0123-456789abcdef?email=student@example.com'), '#/training')
  assert.equal(supportRoute('#/review?private=reason'), '#/review')
  assert.equal(supportRoute('#/unknown/private'), '#/home')
  assert.equal(supportRoute('https://host/?token=private#/profile'), '#/home')
  assert.equal(supportVersion('beta-20261018.1'), 'beta-20261018.1')
  for (const version of ['', 'some build\nemail:private', 'https://private.com?id=1', 'x'.repeat(65)]) assert.equal(supportVersion(version), '开发预览')
  const text = supportTemplate('#/training/private-session-id?reason=SECRET_STUDENT_REASON', 'beta-20261018.1')
  assert.ok(text.split('\n').length >= 8)
  assert.match(text, /页面：#\/training/)
  assert.match(text, /设备与浏览器（选填，请自行填写）/)
  assert.match(text, /请勿发送 API Key、验证码、邀请码/)
  assert.doesNotMatch(text, /private-session-id|SECRET_STUDENT_REASON|\?reason=/)
})

test('mail action creates only a user-confirmed draft and data requests use the same configured receiver', () => {
  assert.equal(supportMailto(null, 'text'), null)
  assert.equal(supportMailto('help@example.com', 'text'), null)
  for (const kind of ['feedback', 'privacy', 'deletion']) {
    const template = supportTemplate('#/profile', 'beta-1', kind)
    const draft = new URL(supportMailto('synthetic-test-user@synthetic-test-host.onion', template))
    assert.equal(draft.protocol, 'mailto:')
    assert.equal(draft.pathname, 'synthetic-test-user@synthetic-test-host.onion')
    assert.equal(draft.searchParams.get('body'), template)
    assert.equal(draft.searchParams.has('bcc'), false)
    assert.equal(draft.searchParams.has('cc'), false)
  }
  assert.match(supportTemplate('#/profile', 'beta-1', 'deletion'), /数据删除申请/)
  assert.match(supportTemplate('#/profile', 'beta-1', 'privacy'), /隐私与数据咨询/)
})

test('existing profiles leave onboarding while a new user can still create their first profile', async () => {
  assert.equal(shouldLeaveOnboarding('onboarding', true), true)
  assert.equal(shouldLeaveOnboarding('onboarding', false), false)
  assert.equal(shouldLeaveOnboarding('home', true), false)
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /if \(shouldLeaveOnboarding\(page, !!profile\)\) setPage\('home', undefined, true\)/)
  assert.match(app, /!profile && \['onboarding', 'home', 'skills'\]\.includes\(page\) && <OnboardingPage/)
  assert.match(app, /operationLock\.current \|\| profile/)
})

test('help is available before login but submission is account-bound and explicit', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const panel = await readFile(new URL('../src/components/BetaSupportPanel.tsx', import.meta.url), 'utf8')
  assert.match(app, /fallbackFooter={<BetaSupportPanel \/>}/)
  assert.match(app, /<BetaSupportPanel session={auth} \/>/)
  assert.doesNotMatch(panel, /fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|navigator\.(userAgent|platform|language)|location\.(href|search)|type=["']file/)
  assert.match(panel, /session\?\.mode === 'invite' && session.authenticated/)
  assert.match(panel, /feedbackApi.submit\(payload, request.signal\)/)
  assert.match(panel, /feedbackDraftError\(draft\)/)
  assert.match(panel, /setPending\(payload\)/)
  assert.match(panel, /核对上次提交/)
  assert.match(panel, /不会自动删除/)
  assert.doesNotMatch(panel, /readOnly|supportTemplate|supportMailto/)
})
