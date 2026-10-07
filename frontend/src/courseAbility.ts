export const abilityDimensions = ['vocabulary', 'syntax', 'context', 'chapter', 'translation', 'transfer'] as const
export const abilityDimensionLabels: Record<string, string> = { vocabulary: '字词理解', syntax: '句式理解', context: '语境推断', chapter: '篇章理解', translation: '翻译表达', transfer: '语境迁移' }
export type CourseAbility = { lesson_id: string; ability_level: 'L1' | 'L2' | 'L3' | null; dimension_tags: string[]; version: number; actor: string | null; note: string; updated_at: string | null; content_version?: string | null; current_content_version?: string; valid_for_content?: boolean }

export function isCourseAbilityResponse(value: unknown): value is { ability: CourseAbility } {
  if (!value || typeof value !== 'object') return false
  const row = (value as { ability?: Record<string, unknown> }).ability
  return !!row && typeof row === 'object' && typeof row.lesson_id === 'string' && row.lesson_id.length > 0 &&
    (row.ability_level === null || ['L1', 'L2', 'L3'].includes(row.ability_level as string)) &&
    Array.isArray(row.dimension_tags) && row.dimension_tags.every(tag => typeof tag === 'string' && abilityDimensions.includes(tag as typeof abilityDimensions[number])) &&
    new Set(row.dimension_tags).size === row.dimension_tags.length &&
    Number.isInteger(row.version) && (row.version as number) >= 0 &&
    (row.actor === null || typeof row.actor === 'string') && typeof row.note === 'string' &&
    (row.updated_at === null || typeof row.updated_at === 'string') &&
    (row.content_version === undefined || row.content_version === null || (typeof row.content_version === 'string' && /^[a-f0-9]{12}$/.test(row.content_version))) &&
    (row.current_content_version === undefined || (typeof row.current_content_version === 'string' && /^[a-f0-9]{12}$/.test(row.current_content_version))) &&
    (row.valid_for_content === undefined || typeof row.valid_for_content === 'boolean') &&
    (row.valid_for_content !== true || (typeof row.content_version === 'string' && row.content_version === row.current_content_version))
}
