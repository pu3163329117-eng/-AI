import type { ContextSelection, ReasoningGraph, TrainingStage } from './types'

/** Display data from the current lookup; only the identifier/version/position are submitted. */
export type AnnotationBasisSelection = {
  sessionId: string
  stage: TrainingStage
  annotation_id: string
  annotation_version: number
  paragraph_index: number
  start: number
  end: number
  token: string
  meaning: string
  status: 'DRAFT' | 'APPROVED'
}

export type ContextBasisSelection = { sessionId: string; stage: TrainingStage; selection: ContextSelection }

export function contextBasisSelectionIsCurrent(value: ContextBasisSelection | null | undefined, sessionId: string | undefined, stage: TrainingStage): value is ContextBasisSelection {
  return !!value && !!sessionId && value.sessionId === sessionId && value.stage === stage && !!value.selection
    && Number.isSafeInteger(value.selection.paragraph_index) && value.selection.paragraph_index >= 0
    && Number.isSafeInteger(value.selection.start) && value.selection.start >= 0 && Number.isSafeInteger(value.selection.end) && value.selection.end > value.selection.start
    && value.selection.end - value.selection.start <= 80 && typeof value.selection.token === 'string'
}

export type EvidenceBasis = { kind: 'CONTEXT'; evidence: ContextSelection } | { kind: 'ANNOTATION'; annotation: AnnotationBasisSelection }

export function annotationSelectionIsCurrent(value: AnnotationBasisSelection | null | undefined, sessionId: string | undefined, stage: TrainingStage): value is AnnotationBasisSelection {
  return !!value && !!sessionId && value.sessionId === sessionId && value.stage === stage
    && typeof value.annotation_id === 'string' && value.annotation_id.length > 0
    && Number.isSafeInteger(value.annotation_version) && value.annotation_version >= 0
    && Number.isSafeInteger(value.paragraph_index) && value.paragraph_index >= 0
    && Number.isSafeInteger(value.start) && value.start >= 0 && Number.isSafeInteger(value.end) && value.end > value.start
}

export function savedBasis(graph: ReasoningGraph | null | undefined, sessionId: string): EvidenceBasis | null {
  if (!graph) return null
  if (graph.basis_kind === 'ANNOTATION' && graph.annotation) return { kind: 'ANNOTATION', annotation: {
    sessionId, stage: graph.stage, annotation_id: graph.annotation.id, annotation_version: graph.annotation.version,
    paragraph_index: graph.evidence.paragraph_index, start: graph.evidence.start, end: graph.evidence.end,
    token: graph.evidence.token, meaning: graph.annotation.meaning, status: graph.annotation.status,
  } }
  return { kind: 'CONTEXT', evidence: graph.evidence }
}

export function basisMatchesGraph(basis: EvidenceBasis | null, graph: ReasoningGraph | null | undefined) {
  if (!basis || !graph) return false
  if (basis.kind === 'ANNOTATION') return graph.basis_kind === 'ANNOTATION' && graph.annotation?.id === basis.annotation.annotation_id
    && graph.annotation.version === basis.annotation.annotation_version && graph.evidence.paragraph_index === basis.annotation.paragraph_index
    && graph.evidence.start === basis.annotation.start && graph.evidence.end === basis.annotation.end
  return graph.basis_kind !== 'ANNOTATION' && graph.evidence.paragraph_index === basis.evidence.paragraph_index
    && graph.evidence.start === basis.evidence.start && graph.evidence.end === basis.evidence.end
}

export function evidencePayload(basis: EvidenceBasis, reason: string, conclusion: string): Record<string, unknown> {
  const position = basis.kind === 'CONTEXT' ? basis.evidence : basis.annotation
  return {
    basis_kind: basis.kind, paragraph_index: position.paragraph_index, start: position.start, end: position.end,
    reason: reason.trim(), conclusion,
    ...(basis.kind === 'ANNOTATION' ? { annotation_id: basis.annotation.annotation_id, annotation_version: basis.annotation.annotation_version } : {}),
  }
}
