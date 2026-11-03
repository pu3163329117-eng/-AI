import { useState } from 'react'
import { errorMessage } from '../http'
import { optionIndex } from '../navigation'
import { InkScene } from '../motion/InkScene'
import type { PracticePlan, PracticePlanGroupBy } from '../types'
import './specializedPractice.css'

export const practiceGroupOptions: Array<{ value: PracticePlanGroupBy; label: string; description: string }> = [
  { value: 'theme', label: '主题', description: '围绕同一阅读语境，连续练习。' },
  { value: 'textbook_tag', label: '教材标签', description: '按教材单元与篇目线索回看。' },
  { value: 'reasoning_point', label: '推理考点', description: '把同一种推断方法练得更扎实。' },
]

export type SpecializedPracticeProps = {
  plans: PracticePlan[]
  groupBy: PracticePlanGroupBy
  loading: boolean
  error: string | null
  startingLesson: boolean
  startError: string | null
  onGroupByChange: (groupBy: PracticePlanGroupBy) => void
  onRetry: () => void
  onStartLesson: (lessonId: string) => void
  inkMotion?: { enabled: boolean }
}

/** Group identity owns disclosure state; coincident plan IDs never leak across tabs. */
export function SpecializedPracticePage(props: SpecializedPracticeProps) {
  return <PracticeContents key={props.groupBy} {...props} />
}

function PracticeContents({ plans, groupBy, loading, error, startingLesson, startError, onGroupByChange, onRetry, onStartLesson, inkMotion }: SpecializedPracticeProps) {
  // undefined = automatic first usable topic, null = an explicit user collapse.
  const [chosenPlanId, setChosenPlanId] = useState<string | null | undefined>(undefined)
  const automaticPlanId = plans.find(plan => plan.lessons.length > 0)?.id ?? plans[0]?.id ?? null
  const openPlanId = chosenPlanId === null ? null : plans.some(plan => plan.id === chosenPlanId) ? chosenPlanId : automaticPlanId
  const activeOption = practiceGroupOptions.find(option => option.value === groupBy) ?? practiceGroupOptions[0]
  const courseCount = plans.reduce((count, plan) => count + plan.lessons.length, 0)

  return <main className="practice-page practice-discovery">
    <header className={`practice-heading${inkMotion ? ' has-ink-scene' : ''}`}>
      {inkMotion && <InkScene enabled={inkMotion.enabled} compact sceneKey="practice" />}
      <div><p className="eyebrow">专项练习</p><h1>选一篇文章，开始训练。</h1><p>题目在文章训练里。先选专题，再点文章下方的“开始训练题”，就能进入练习。</p></div>
      <aside className="practice-signal" aria-label="当前专项练习模式"><span>当前聚合</span><strong>{activeOption.label}</strong><small>{activeOption.description}</small></aside>
    </header>

    <ol className="practice-entry-steps" aria-label="进入专项练习的三个步骤"><li>选专题</li><li>选文章</li><li>开始训练题</li></ol>

    <section className="practice-controls" aria-label="专项练习分类"><p>按什么找专题？</p><div role="tablist" aria-label="专项练习分类方式">
      {practiceGroupOptions.map((option, index) => <button key={option.value} type="button" role="tab" id={`practice-tab-${option.value}`} aria-selected={groupBy === option.value} aria-controls="practice-results" tabIndex={groupBy === option.value ? 0 : -1} className={groupBy === option.value ? 'is-active' : ''} disabled={startingLesson}
        onClick={() => { if (!startingLesson && option.value !== groupBy) onGroupByChange(option.value) }}
        onKeyDown={event => {
          if (startingLesson) return
          const next = optionIndex(event.key, index, practiceGroupOptions.length)
          if (next === null) return
          event.preventDefault()
          onGroupByChange(practiceGroupOptions[next].value)
          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
        }}>{option.label}</button>)}
    </div></section>

    <section className="practice-plan-list" id="practice-results" role="tabpanel" aria-labelledby={`practice-tab-${groupBy}`} aria-busy={loading || startingLesson}>
      <header className="practice-list-heading"><div><p className="eyebrow">课程专题</p><h2 id="practice-list-title">选择专题，查看可练文章</h2></div>{!loading && !error && <span>{plans.length} 个专题 · {courseCount} 个可开始课程入口</span>}</header>
      {loading ? <div className="practice-state" role="status"><b>正在整理专项练习…</b><p>正在按{activeOption.label}汇总已发布的课程。</p></div>
        : error ? <div className="practice-state" role="alert"><b>专项练习暂时无法读取。</b><p>{errorMessage(error)} 可以重新读取，已保存的训练不受影响。</p><button type="button" className="text-button" disabled={startingLesson} onClick={() => { if (!startingLesson) onRetry() }}>重新读取 →</button></div>
          : plans.length === 0 ? <div className="practice-state"><b>暂时没有可用的专项练习。</b><p>教研内容发布并补齐{activeOption.label}后，会出现在这里。当前没有可开始的文章或训练题。</p></div>
            : <div className="practice-plans">{plans.map((plan, planIndex) => {
              const isOpen = openPlanId === plan.id
              const panelId = `practice-lessons-${groupBy}-${planIndex}`
              return <article className={isOpen ? 'practice-plan is-open' : 'practice-plan'} key={plan.id}>
                <button className="practice-plan-summary" type="button" aria-expanded={isOpen} aria-controls={panelId} disabled={startingLesson} onClick={() => { if (!startingLesson) setChosenPlanId(isOpen ? null : plan.id) }}>
                  <span className="practice-plan-index" aria-hidden="true">{String(planIndex + 1).padStart(2, '0')}</span>
                  <span className="practice-plan-copy"><small>{plan.lessons.length} 个可开始课程</small><strong>{plan.label}</strong></span>
                  <span className="practice-plan-toggle">{isOpen ? '收起文章列表' : '查看可练文章'}</span>
                </button>
                <div id={panelId} className="practice-lessons" hidden={!isOpen} aria-label={`${plan.label}课程列表`}>
                  {plan.lessons.length === 0 ? <p className="practice-no-lessons">这个专题暂时没有可开始的课程或训练题，请选择其他专题。</p> : plan.lessons.map((lesson, lessonIndex) => <article className="practice-lesson" key={lesson.id}>
                    <div><span>{String(lessonIndex + 1).padStart(2, '0')}</span><h3>{lesson.title}</h3><p>{lesson.summary}</p><small>{lesson.source} · {lesson.difficulty} · 约 {lesson.estimated_minutes} 分钟</small></div>
                    <button type="button" className="button button-secondary practice-start" aria-label={`${startingLesson ? '正在进入训练' : '开始训练题'}：${lesson.title}`} onClick={() => { if (!startingLesson) onStartLesson(lesson.id) }} disabled={startingLesson}>{startingLesson ? '正在进入训练…' : '开始训练题'} <span aria-hidden="true">→</span></button>
                  </article>)}
                </div>
              </article>
            })}</div>}
      {startingLesson && <p className="practice-start-status" role="status">正在创建训练并打开题目，请稍候；不用再次点击。</p>}
      {startError && <p className="request-error practice-action-error" role="alert">无法开始专项练习：{startError}</p>}
    </section>
  </main>
}
