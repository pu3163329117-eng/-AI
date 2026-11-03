import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import postcss from 'postcss'

const css = await readFile(new URL('../src/guidedStudy.css', import.meta.url), 'utf8')
const ast = postcss.parse(css)
const rules = []
ast.walkRules(rule => rules.push(rule))
const values = rule => Object.fromEntries(rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]))

test('guided study additions stay in learner scope with no training, auth or admin leakage', () => {
  for (const rule of rules) assert.ok(rule.selector.startsWith('.waterink-theme.inkroom-formal '), rule.selector)
  assert.doesNotMatch(css, /\.training-|\.auth-|\.support-inbox|\.admin-|:root|\bbody\b|#root/)
  ast.walkDecls(decl => {
    assert.equal(decl.important, undefined)
    assert.ok(!['display','visibility','position','order','content','pointer-events','overflow','overflow-x','z-index'].includes(decl.prop), decl.toString())
  })
})

test('targeted catalogue, report, about, profile and recall controls use existing 8px token', () => {
  const controls = values(rules[0])
  assert.equal(controls['min-width'], '44px')
  assert.equal(controls['min-height'], '44px')
  assert.equal(controls['max-width'], '100%')
  assert.equal(controls['font-size'], '16px')
  assert.equal(controls['border-radius'], 'var(--feedback-control-radius,8px)')
  assert.equal(values(rules[1])['min-height'], '48px')
  assert.ok(rules[1].selector.includes('.about-page button.about-action'), '48px override matches the earlier :is() catalogue-button type specificity')
  for (const selector of ['.practice-controls button','.report-overview nav button','.about-action','.waterink-profile-links a','.recall-board select']) assert.ok(rules[0].selector.includes(selector))
})

test('skills loading and error branches receive spacing but retain status and alert semantics', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /loading \? <p role="status">正在读取实际判断记录/)
  assert.match(app, /error \? <div role="alert"><p>判断记录暂时未能读取/)
  const branch = rules.find(rule => rule.selector.includes("p[role='status'],div[role='alert']"))
  assert.equal(values(branch).padding, '20px')
  assert.equal(values(branch)['min-height'], '0')
  assert.equal(values(branch)['line-height'], '1.85')
  assert.equal(rules.at(-1).parent.params, '(max-width: 44rem)')
  assert.equal(values(rules.at(-1)).padding, '20px 16px')
})

test('error marks never override semantic colors or decorate an empty error', () => {
  const rule = rules.find(rule => rule.selector.endsWith('.request-error:not(:empty)'))
  assert.equal(values(rule)['border-inline-start'], '2px solid var(--waterink-seal,#9e4439)')
  assert.equal(values(rule)['font-size'], '14px')
  for (const item of rules) {
    assert.equal(values(item).color, undefined)
    assert.equal(values(item).background, undefined)
    assert.equal(values(item)['background-color'], undefined)
  }
  assert.doesNotMatch(css, /:disabled|aria-pressed|aria-selected|is-active|is-selected/)
})

test('no dependency, artwork, original-text, typeface or motion system is added', () => {
  assert.doesNotMatch(css, /@import|url\(|https?:|data:|!important|font-family|letter-spacing|@keyframes|animation\s*:|transition\s*:|\.text-token|\.fulltext-|safe-area|confirmation-dialog|product-tour/)
})

test('existing ink, muted and seal text tokens retain AA contrast on plain paper and surface', async () => {
  const skin = await readFile(new URL('../src/waterink.css', import.meta.url), 'utf8')
  const token = name => { const found = skin.match(new RegExp('--waterink-' + name + ':\\s*(#[0-9a-f]{6})', 'i')); assert.ok(found, name); return found[1] }
  const luminance = hex => {
    const channels = [1,3,5].map(offset => parseInt(hex.slice(offset, offset + 2),16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
  }
  for (const foreground of ['ink','muted','seal']) for (const background of ['paper','surface']) {
    const pair = [luminance(token(foreground)), luminance(token(background))].sort((a,b) => a-b)
    const contrast = (pair[1] + .05) / (pair[0] + .05)
    assert.ok(contrast >= 4.5, `${foreground}/${background}: ${contrast}`)
  }
})
