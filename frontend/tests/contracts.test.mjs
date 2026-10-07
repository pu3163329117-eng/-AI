import test from 'node:test'
import assert from 'node:assert/strict'
import { importSource } from './import-source.mjs'
const { validateResponse: valid } = await importSource('contracts.ts')
const lesson = { id: 'lesson-1', title: '假', source: '劝学', difficulty: '进阶', estimated_minutes: 10, summary: '借助语境判断' }
const profile = { id: 'profile-1', display_name: '验收', school_stage: 'SENIOR', total_points: 0, completed_levels: 0 }
const session = { stage: 'CORE', state: 'AWAITING_INITIAL_ATTEMPT', state_version: 0, source: '劝学', passage: '善假于物也。', variable: '假',
  question: '假是什么意思？', choices: ['借助', '假装'], evidence: '于物', selected_answer: null, evidence_selected: false, deferred: false,
  hint_level: 0, hint: null, feedback: '', transfer_ready: false, summary_ready: false, completed: false, summary: null }
const document = { id: 'doc-1', source: '劝学', extent: 'EXCERPT', indexed_positions: 4, annotated_positions: 4, total_annotations: 4 }
const annotation = { id: 'annotation-1', token: '假', start: 1, end: 2, meaning: '借助', part_of_speech: '动词', variability: 'CONTEXTUAL',
  reasoning: '施受关系', sense_key: 'borrow', status: 'DRAFT', source_url: null }
const lookup = { document, selection: { token: '假', paragraph_index: 0, start: 1, end: 2, sentence: '善假于物也。' }, annotations: [annotation], related: { total: 0, items: [] }, status: 'ANNOTATED' }
const review = { status: 'UNREVIEWED', content_version: 'abc', reviewer: null, note: null, reviewed_at: null, issues: [] }
const admin = { ...lesson, school_stage: 'SENIOR', status: 'DRAFT', textbook_tags: [], theme: '', accumulation_points: [], reasoning_points: [], reasoning_level: '' }

test('missing envelopes, nonobjects and unknown contracts are rejected', () => {
  for (const value of [null, {}, [], 'ok', { profile: null }]) assert.equal(valid('/api/v1/profiles/p', value), false)
  assert.equal(valid('/api/unknown', { ok: true }), false)
})
test('catalogue accepts empty and extra fields, but validates each entry', () => {
  assert.equal(valid('/api/v1/lessons?school_stage=SENIOR', { lessons: [] }), true)
  assert.equal(valid('/api/v1/lessons', { lessons: [{ ...lesson, new_server_field: true }], total: 1 }), true)
  for (const lessons of [null, {}, [null], [{ ...lesson, title: 5 }]]) assert.equal(valid('/api/v1/lessons', { lessons }), false)
})
test('profiles require real field types, stages and finite counts', () => {
  assert.equal(valid('/api/v1/profiles', { profile }), true)
  for (const patch of [{ school_stage: 'COLLEGE' }, { completed_levels: '1' }, { total_points: NaN }, { id: '' }]) {
    assert.equal(valid('/api/v1/profiles/p', { profile: { ...profile, ...patch } }), false)
  }
})
test('old frozen sessions remain valid without later optional attribution', () => {
  assert.equal(valid('/api/v1/training/sessions/s', { session }), true)
  assert.equal(valid('/api/v1/training/sessions', { session_id: 's', session }), true)
  assert.equal(valid('/api/v1/training/sessions/s', { session: { ...session, choices: null } }), false)
  assert.equal(valid('/api/v1/training/sessions/s', { session: { ...session, stage: 'UNKNOWN' } }), false)
})
test('completed sessions need a readable summary, no invented zero fallback', () => {
  assert.equal(valid('/api/v1/training/sessions/s', { session: { ...session, completed: true } }), false)
  assert.equal(valid('/api/v1/training/sessions/s', { session: { ...session, completed: true, summary: { accumulation: '', reasoning: '', earned_points: 20 } } }), true)
})
test('reading context and selected spans validate nested types and codepoint positions', () => {
  const reading_context = { paragraphs: ['𠮷者。'], full_text: '𠮷者。', author: '', era: '', work_note: '' }
  const context_selection = { paragraph_index: 0, start: 0, end: 1, token: '𠮷', sentence: '𠮷者。', paragraph: '𠮷者。', scope: 'WORD' }
  assert.equal(valid('/api/v1/training/sessions/s', { session: { ...session, reading_context, context_selection } }), true)
  assert.equal(valid('/api/v1/training/sessions/s', { session: { ...session, reading_context: { ...reading_context, paragraphs: null } } }), false)
  assert.equal(valid('/api/v1/training/sessions/s', { session: { ...session, context_selection: { ...context_selection, end: 0 } } }), false)
})
test('command receipts validate state consistency and optional returned profile', () => {
  const receipt = { session_id: 's', state: session.state, state_version: 0, session }
  assert.equal(valid('/api/v1/training/sessions/s/commands', receipt), true)
  assert.equal(valid('/api/v1/training/sessions/s/commands', { ...receipt, profile }), true)
  assert.equal(valid('/api/v1/training/sessions/s/commands', { ...receipt, state_version: 1 }), false)
  assert.equal(valid('/api/v1/training/sessions/s/commands', { ...receipt, profile: {} }), false)
})
test('annotation arrays and nested related entries cannot crash a reader', () => {
  assert.equal(valid('/api/knowledge/lookup?offset=0', lookup), true)
  for (const patch of [{ annotations: null }, { related: null }, { annotations: [{ ...annotation, meaning: 42 }] }, { related: { total: 1, items: [null] } }]) {
    assert.equal(valid('/api/knowledge/lookup', { ...lookup, ...patch }), false)
  }
})
test('pending and unavailable knowledge are explicit valid states', () => {
  for (const status of ['PENDING', 'UNAVAILABLE']) assert.equal(valid('/api/knowledge/lookup', { document: null, selection: null, annotations: [], related: { total: 0, items: [] }, status }), true)
  assert.equal(valid('/api/knowledge/lookup', { ...lookup, status: 'APPROVED' }), false)
})
test('coverage validates both totals and per-document rendering', () => {
  const value = { documents: [document], totals: { documents: 1, indexed_positions: 4, annotated_positions: 4, annotations: 4 } }
  assert.equal(valid('/api/knowledge/coverage', value), true)
  assert.equal(valid('/api/knowledge/coverage', { ...value, documents: [null] }), false)
})
test('learning summaries retain compatibility with absent optional skill statistics', () => {
  const summary = { total_points: 0, completed_lessons: 0, completed_sessions: 0, current_streak_days: 0, weak_skills: [], recent_activity: [] }
  assert.equal(valid('/api/v1/profiles/p/learning-summary', { summary }), true)
  assert.equal(valid('/api/v1/profiles/p/learning-summary', { summary: { ...summary, skill_statistics: null } }), false)
})
test('daily mission and plans validate nested recommended lessons', () => {
  const mission = { mission_date: '2026-10-07', target_completed_sessions: 1, completed_sessions_today: 0, completed: false, recommended_lesson: null }
  assert.equal(valid('/api/v1/profiles/p/daily-mission', { mission }), true)
  assert.equal(valid('/api/v1/profiles/p/daily-mission', { mission: { ...mission, recommended_lesson: {} } }), false)
  assert.equal(valid('/api/v1/profiles/p/practice-plans?group_by=theme', { group_by: 'theme', plans: [{ id: '1', label: '语境', lesson_count: 1, lessons: [lesson] }] }), true)
  assert.equal(valid('/api/v1/profiles/p/practice-plans', { group_by: 'theme', plans: [{ id: '1', label: '', lesson_count: 1, lessons: [null] }] }), false)
})
test('reviews, mistakes and achievements permit true empty results', () => {
  assert.equal(valid('/api/v1/profiles/p/sessions', { sessions: [] }), true)
  assert.equal(valid('/api/v1/profiles/p/mistakes', { mistakes: [] }), true)
  assert.equal(valid('/api/v1/profiles/p/achievements', { achievements: [], review_recommendation: null }), true)
  assert.equal(valid('/api/v1/profiles/p/achievements', { achievements: [{ id: 'a' }], review_recommendation: null }), false)
})
test('admin contracts include source arrays, arbitrary content and optional old review fields', () => {
  assert.equal(valid('/api/v1/admin/lessons', { lessons: [admin] }), true)
  for (const path of ['/api/v1/admin/lessons/l', '/api/v1/admin/lessons/l/review', '/api/v1/admin/lessons/l/publish']) {
    assert.equal(valid(path, { lesson: { ...admin, review, content: { CORE: {} } } }), true)
    assert.equal(valid(path, { lesson: { ...admin, textbook_tags: null } }), false)
  }
})
