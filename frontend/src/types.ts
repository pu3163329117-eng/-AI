export type TrainingState =
  | 'AWAITING_INITIAL_ATTEMPT'
  | 'VARIABLE_DEFERRED'
  | 'VARIABLE_REVISITED'
  | 'HINT_PRESENTED'
  | 'AWAITING_REASONING'
  | 'ANSWER_VALIDATED'
  | 'AWAITING_TRANSFER_ATTEMPT'
  | 'AWAITING_TRANSFER_REASONING'
  | 'TRANSFER_VALIDATED'
  | 'SESSION_COMPLETED'

export type TrainingStage = 'CORE' | 'TRANSFER'

export type TrainingSummary = {
  accumulation: string
  reasoning: string
  earned_points: number
}

export type TrainingSession = {
  stage: TrainingStage
  state: TrainingState
  state_version: number
  source: string
  passage: string
  variable: string
  question: string
  choices: string[]
  evidence: string
  selected_answer: string | null
  evidence_selected: boolean
  deferred: boolean
  hint_level: number
  hint: string | null
  feedback: string
  transfer_ready: boolean
  summary_ready: boolean
  summary: TrainingSummary | null
  completed: boolean
}

export type CommandType =
  | 'SELECT_EVIDENCE'
  | 'DEFER_VARIABLE'
  | 'REQUEST_HINT'
  | 'SUBMIT_ATTEMPT'
  | 'CONTINUE_TO_TRANSFER'
  | 'COMPLETE_SESSION'
