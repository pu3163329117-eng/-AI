export type TrainingState =
  | 'AWAITING_INITIAL_ATTEMPT'
  | 'VARIABLE_DEFERRED'
  | 'VARIABLE_REVISITED'
  | 'HINT_PRESENTED'
  | 'AWAITING_REASONING'
  | 'ANSWER_VALIDATED'
  | 'SESSION_COMPLETED'

export type TrainingSession = {
  state: TrainingState
  state_version: number
  passage: string
  variable: string
  choices: string[]
  selected_answer: string | null
  evidence_selected: boolean
  deferred: boolean
  hint_level: number
  hint: string | null
  feedback: string
  transfer_ready: boolean
  completed: boolean
}

export type CommandType =
  | 'SELECT_EVIDENCE'
  | 'DEFER_VARIABLE'
  | 'REQUEST_HINT'
  | 'SUBMIT_ATTEMPT'
  | 'CONTINUE_TO_TRANSFER'
