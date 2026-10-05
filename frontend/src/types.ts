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

export type ReadingContext = {
  paragraphs: string[]
  full_text: string
  author: string
  era: string
  work_note: string
}

export type SchoolStage = 'JUNIOR' | 'SENIOR'

export type LearnerProfile = {
  id: string
  display_name: string
  school_stage: SchoolStage
  total_points: number
  completed_levels: number
}

export type WeakSkill = {
  label: string
  attempts: number
  /** The service may return either 0–1 or 0–100; the UI normalizes both. */
  accuracy: number
}

export type RecentActivity = {
  date: string
  points: number
  completed_sessions: number
}

export type LearningSummary = {
  total_points: number
  completed_lessons: number
  completed_sessions: number
  current_streak_days: number
  weak_skills: WeakSkill[]
  recent_activity: RecentActivity[]
}

export type Achievement = {
  id: string
  label: string
  description: string
  unlocked: boolean
  current: number
  target: number
}

export type ReviewRecommendation = {
  kind: string
  title: string
  description: string
  action_label: string
}

export type Achievements = {
  achievements: Achievement[]
  review_recommendation: ReviewRecommendation | null
}

export type Lesson = {
  id: string
  title: string
  source: string
  difficulty: string
  estimated_minutes: number
  summary: string
}

export type DailyMission = {
  mission_date: string
  target_completed_sessions: number
  completed_sessions_today: number
  completed: boolean
  recommended_lesson: Lesson | null
}

export type PracticePlanGroupBy = 'theme' | 'textbook_tag' | 'reasoning_point'

/** A focused, editorially grouped route back into published lessons. */
export type PracticePlan = {
  id: string
  label: string
  lesson_count: number
  lessons: Lesson[]
}

export type PracticePlans = {
  group_by: PracticePlanGroupBy
  plans: PracticePlan[]
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

export type Mistake = {
  lesson_id: string
  title: string
  source: string
  variable: string
  passage: string
  wrong_attempts: number
  latest_attempt_at: string | null
  review_hint: string
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
  reading_context?: ReadingContext
  profile_id?: string
}

export type CommandType =
  | 'SELECT_EVIDENCE'
  | 'DEFER_VARIABLE'
  | 'REQUEST_HINT'
  | 'SUBMIT_ATTEMPT'
  | 'CONTINUE_TO_TRANSFER'
  | 'COMPLETE_SESSION'
