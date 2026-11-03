/** A selected but unsubmitted option is a draft, even with no reasoning edits. */
export function trainingDraftIsDirty(answer: string | null, savedAnswer: string | null, reasoningDirty: boolean, completed: boolean): boolean {
  return !completed && (reasoningDirty || answer !== savedAnswer)
}
