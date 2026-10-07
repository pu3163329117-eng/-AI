export const abilityDimensions = ['vocabulary', 'syntax', 'context', 'chapter', 'translation', 'transfer'] as const
export const abilityDimensionLabels: Record<string, string> = { vocabulary: '字词理解', syntax: '句式理解', context: '语境推断', chapter: '篇章理解', translation: '翻译表达', transfer: '语境迁移' }
export type CourseAbility = { lesson_id: string; ability_level: 'L1' | 'L2' | 'L3' | null; dimension_tags: string[]; version: number; actor: string | null; note: string; updated_at: string | null }

export function isCourseAbilityResponse(value: unknown): value is { ability: CourseAbility } {
  if (!value || typeof value !== 'object') return false
  const row = (value as { ability?: Record<string, unknown> }).ability
  return !!row && typeof row === 'object' && typeof row.lesson_id === 'string' && row.lesson_id.length > 0 &&
    (row.ability_level === null || ['L1', 'L2', 'L3'].includes(row.ability_level as string)) &&
    Array.isArray(row.dimension_tags) && row.dimension_tags.every(tag => typeof tag === 'string' && abilityDimensions.includes(tag as typeof abilityDimensions[number])) &&
    new Set(row.dimension_tags).size === row.dimension_tags.length &&
    Number.isInteger(row.version) && (row.version as number) >= 0 &&
    (row.actor === null || typeof row.actor === 'string') && typeof row.note === 'string' &&
    (row.updated_at === null || typeof row.updated_at === 'string')
}
