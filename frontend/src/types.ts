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

export type SchoolStage = 'JUNIOR' | 'SENIOR'

export type LearnerProfile = {
  id: string
  display_name: string
  school_stage: SchoolStage
  total_points: number
  completed_levels: number
}

export type Lesson = {
  id: string
  title: string
  source: string
  difficulty: string
  estimated_minutes: number
  summary: string
}

export type LessonStatus = 'DRAFT' | 'PUBLISHED'

/** Editorial metadata is intentionally separate from the learner catalogue shape. */
export type AdminLesson = Lesson & {
  school_stage: SchoolStage
  status: LessonStatus
  textbook_tags: string[]
  theme: string
  accumulation_points: string[]
  reasoning_points: string[]
  reasoning_level: string
  content?: Record<string, unknown>
}

export type AdminLessonInput = {
  school_stage: SchoolStage
  title: string
  source: string
  difficulty: string
  estimated_minutes: number
  summary: string
  textbook_tags: string[]
  theme: string
  accumulation_points: string[]
  reasoning_points: string[]
  reasoning_level: string
  content?: Record<string, unknown>
}

export type ReviewSession = {
  session_id: string
  source: string
  stage: TrainingStage
  completed: boolean
  feedback: string
  updated_at: string | null
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
  profile_id?: string
}

export type CommandType =
  | 'SELECT_EVIDENCE'
  | 'DEFER_VARIABLE'
  | 'REQUEST_HINT'
  | 'SUBMIT_ATTEMPT'
  | 'CONTINUE_TO_TRANSFER'
  | 'COMPLETE_SESSION'
