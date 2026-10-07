import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/courseAbility.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } })
const { isCourseAbilityResponse, abilityDimensions } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
const row = { lesson_id: 'course-1', ability_level: null, dimension_tags: [], version: 0, actor: null, note: '', updated_at: null }

test('unclassified legacy courses have a real nullable baseline', () => {
  assert.equal(isCourseAbilityResponse({ ability: row }), true)
  assert.equal(isCourseAbilityResponse({ ability: { ...row, ability_level: 'L2', dimension_tags: ['syntax', 'context'], version: 1, actor: '测试署名' } }), true)
  assert.equal(abilityDimensions.length, 6)
})
test('invalid metadata fails closed instead of rendering an incorrect level', () => {
  for (const changes of [{ ability_level: 'SENIOR' }, { dimension_tags: ['syntax', 'syntax'] }, { dimension_tags: ['unknown'] }, { version: -1 }, { version: true }, { note: null }, { actor: 3 }, { lesson_id: '' }]) {
    assert.equal(isCourseAbilityResponse({ ability: { ...row, ...changes } }), false)
  }
  for (const value of [null, {}, [], { ability: null }, { ability: 'L1' }]) assert.equal(isCourseAbilityResponse(value), false)
})

test('classification validity requires the saved and current content versions to match', () => {
  const bound = { ...row, content_version: 'abcdef012345', current_content_version: 'abcdef012345', valid_for_content: true }
  assert.equal(isCourseAbilityResponse({ ability: bound }), true)
  assert.equal(isCourseAbilityResponse({ ability: { ...bound, current_content_version: '012345abcdef', valid_for_content: false } }), true)
  for (const change of [{ content_version: null }, { current_content_version: '012345abcdef' }, { content_version: 'old' }, { valid_for_content: 'yes' }]) {
    assert.equal(isCourseAbilityResponse({ ability: { ...bound, ...change } }), false)
  }
})
