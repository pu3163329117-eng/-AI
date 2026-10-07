import { useEffect, useMemo, useRef, useState } from 'react'
import type { CommandType, ContextScope, ContextSelection, TrainingSession } from '../types'
import { WordKnowledge } from './WordKnowledge'
import { KnowledgeCoverage } from './KnowledgeCoverage'
import { readingIndex, sentenceAt, tokensFor } from '../reader'

const layers: [ContextScope, string][] = [['WORD', '词'], ['SENTENCE', '句'], ['PARAGRAPH', '段'], ['WORK', '篇'], ['ERA', '时代']]
const extentLabels = { FULL: '全文', CHAPTER: '完整章节', EXCERPT: '课内节选', PROMPT: '题目原文' }

function defaultSelection(session: TrainingSession, paragraphs: string[]): ContextSelection | null {
  // The same glyph may occur several times in one paragraph. Locate it inside
  // the frozen prompt first, rather than taking the paragraph's first glyph.
  const normalizedPassage = Array.from(session.passage).filter(char => /[\p{L}\p{N}]/u.test(char)).join('')
  const normalizedVariable = Array.from(session.variable).filter(char => /[\p{L}\p{N}]/u.test(char)).join('')
  const variableOffset = normalizedPassage.indexOf(normalizedVariable)
  if (normalizedPassage && normalizedVariable && variableOffset >= 0) {
    for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
      const paragraph = paragraphs[paragraphIndex]
      const positions = Array.from(paragraph).map((char, index) => ({ char, index })).filter(item => /[\p{L}\p{N}]/u.test(item.char))
      const normalized = positions.map(item => item.char).join('')
      const passageOffset = normalized.indexOf(normalizedPassage)
      if (passageOffset < 0) continue
      const before = Array.from(normalized.slice(0, passageOffset)).length
      const within = Array.from(normalizedPassage.slice(0, variableOffset)).length
      const length = Array.from(normalizedVariable).length
      const start = positions[before + within].index
      const end = positions[before + within + length - 1].index + 1
      return { paragraph_index: paragraphIndex, start, end, token: Array.from(paragraph).slice(start, end).join(''), paragraph, sentence: sentenceAt(paragraph, start, end), scope: 'WORD' }
    }
  }
  const paragraphIndex = paragraphs.findIndex(paragraph => paragraph.includes(session.variable) && paragraph.includes(session.evidence))
  const index = paragraphIndex < 0 ? paragraphs.findIndex(paragraph => paragraph.includes(session.variable)) : paragraphIndex
  if (index < 0) return null
  const paragraph = paragraphs[index]
  const start = Array.from(paragraph.slice(0, paragraph.indexOf(session.variable))).length
  const end = start + Array.from(session.variable).length
  return { paragraph_index: index, start, end, token: session.variable, paragraph, sentence: sentenceAt(paragraph, start, end), scope: 'WORD' }
}

export function ContextReader({ sessionId, session, busy, onCommand }: {
  sessionId: string
  session: TrainingSession
  busy: boolean
  onCommand: (type: CommandType, payload?: Record<string, unknown>) => void
}) {
  const context = session.reading_context
  const paragraphs = context?.paragraphs?.length ? context.paragraphs : [session.passage]
  const selection = session.context_selection ?? defaultSelection(session, paragraphs)
  const [rangeMode, setRangeMode] = useState(false)
  const [anchor, setAnchor] = useState<{ paragraph: number; start: number } | null>(null)
  const [rangeError, setRangeError] = useState('')
  const [focusKey, setFocusKey] = useState('')
  const canvasRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const requested = useRef<string | null>(null)
  const tokenParagraphs = useMemo(() => paragraphs.map(paragraph => tokensFor(paragraph, context?.terms ?? [], rangeMode)), [paragraphs, context?.terms, rangeMode])
  const targets = tokenParagraphs.flatMap((tokens, paragraph) => tokens.filter(token => token.clickable).map(token => ({ paragraph, start: token.start })))
  const activeKey = targets.some(target => `${target.paragraph}:${target.start}` === focusKey) ? focusKey : `${targets[0]?.paragraph}:${targets[0]?.start}`
  const selectionKey = session.context_selection ? `${session.context_selection.paragraph_index}:${session.context_selection.start}:${session.context_selection.end}` : ''
  useEffect(() => {
    if (!selectionKey || requested.current !== selectionKey) return
    requested.current = null
    const panel = panelRef.current; const canvas = canvasRef.current
    if (!panel || !canvas) return
    panel.scrollTop = 0
    if (panel.getBoundingClientRect().top >= canvas.getBoundingClientRect().bottom - 5) {
      panel.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
      panel.querySelector<HTMLElement>('#word-meaning-title')?.focus({ preventScroll: true })
    }
  }, [selectionKey, session.state_version])
  const extent = extentLabels[context?.extent ?? 'EXCERPT']
  const sourceUrl = context?.source_url && /^https?:\/\//i.test(context.source_url) ? context.source_url : null

  function select(paragraphIndex: number, start: number, end: number, scope: ContextScope = selection?.scope ?? 'WORD') {
    if (busy) return
    if (rangeMode) {
      if (!anchor || anchor.paragraph !== paragraphIndex) { setAnchor({ paragraph: paragraphIndex, start }); setRangeError(anchor ? '词组须在同一段。已将起点改到当前段，请再选结束字。' : ''); return }
      const rangeStart = Math.min(anchor.start, start)
      const rangeEnd = Math.max(anchor.start + 1, end)
      if (rangeEnd - rangeStart > 80) { setRangeError('词组最多选择 80 个字，请重新选择。'); setAnchor(null); return }
      start = rangeStart; end = rangeEnd
      setAnchor(null); setRangeMode(false)
    }
    setFocusKey(`${paragraphIndex}:${start}`)
    requested.current = `${paragraphIndex}:${start}:${end}`
    setRangeError('')
    onCommand('REQUEST_MORE_CONTEXT', { paragraph_index: paragraphIndex, start, end, scope })
  }

  return <section className="fulltext-reader" aria-labelledby="fulltext-title" aria-busy={busy} onKeyDown={event => {
    if (event.key === 'Escape' && rangeMode) { event.preventDefault(); setRangeMode(false); setAnchor(null); setRangeError('已取消词组选择。') }
  }}>
    <header className="fulltext-heading">
      <div><p className="stage-label">原文点读 · {extent}</p><h2 id="fulltext-title" tabIndex={-1}>先在篇中读，再回到词上。</h2></div>
      <button type="button" className="reader-range-toggle" aria-pressed={rangeMode} disabled={busy}
        onClick={() => { setRangeMode(!rangeMode); setAnchor(null); setRangeError('') }}>{rangeMode ? '取消词组选择' : '选择任意词组'}</button>
    </header>
    <p className="reader-guide" aria-live="polite">{rangeError || (rangeMode ? (anchor ? '再点同段的结束字，选取整段词组；Esc 可取消。' : '先点词组起始字，再点结束字；Esc 可取消。') : '点击字词查看本句释义、变量判断和五层语境；词组可选择起止位置。')}</p>
    <p className="reader-keyboard-guide" id="reader-keyboard-guide">键盘：左右键移到相邻字词，上下键切换段落，Home / End 移到段首／段末，Enter 查看释义。</p>
    <KnowledgeCoverage />
    <div className="fulltext-layout">
      <div className="fulltext-canvas" ref={canvasRef} aria-label={`${session.source}${extent}`} aria-describedby="reader-keyboard-guide">
        <p className="fulltext-source">{session.source} · {context?.work_note ?? '当前课内原文'}</p>
        {paragraphs.map((paragraph, paragraphIndex) => <p className="fulltext-paragraph" key={paragraphIndex}>
          {tokenParagraphs[paragraphIndex].map(({ token, suffix, start, end, clickable }) => {
            const selected = selection?.paragraph_index === paragraphIndex && start < selection.end && end > selection.start
            const anchored = anchor?.paragraph === paragraphIndex && anchor.start === start
            return clickable ? <span className="reader-word" key={start}><button type="button" disabled={busy} tabIndex={activeKey === `${paragraphIndex}:${start}` ? 0 : -1}
              onFocus={() => setFocusKey(`${paragraphIndex}:${start}`)}
              onKeyDown={event => {
                const current = targets.findIndex(target => target.paragraph === paragraphIndex && target.start === start)
                const next = readingIndex(event.key, current, targets)
                if (next === null) return
                event.preventDefault()
                const button = canvasRef.current?.querySelectorAll<HTMLButtonElement>('button.text-token')[next]
                button?.focus({ preventScroll: true }); button?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
              }}
              className={`text-token${selected ? ' is-selected' : ''}${anchored ? ' is-anchor' : ''}`} aria-pressed={selected}
              aria-label={`第 ${paragraphIndex + 1} 段第 ${start + 1} 字，查看“${token}”的语境`}
              onClick={() => select(paragraphIndex, start, end)}>{token}</button>{suffix}</span> : <span key={start}>{token}{suffix}</span>
          })}
        </p>)}
        <p className="reader-version">{context?.text_version ?? '资料版本待校订'}{sourceUrl && <> · <a href={sourceUrl} target="_blank" rel="noreferrer">核对原文</a></>}</p>
      </div>
      <aside className="context-layers" ref={panelRef} aria-label="当前字词的五层语境">
        <div className="context-panel-heading"><p className="stage-label">语境标尺 · {session.context_selection ? '已保存' : '点击后保存'}</p><button type="button" className="knowledge-action" onClick={() => {
          const button = canvasRef.current?.querySelector<HTMLButtonElement>('.text-token.is-selected') ?? canvasRef.current?.querySelector<HTMLButtonElement>('.text-token')
          button?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); button?.focus({ preventScroll: true })
        }}>返回原文字词</button></div>
        {session.context_selection ? <WordKnowledge sessionId={sessionId} selection={session.context_selection} stage={session.stage} /> :
          <p className="reader-version">点击原文字词，查看本句解释与其他语境。释义按需展开，不在进入训练时自动揭示。</p>}
        <ol>{layers.map(([scope, label]) => <li key={scope} className={selection?.scope === scope ? 'active-layer' : ''}>
          <button type="button" aria-pressed={selection?.scope === scope} disabled={!selection || busy || rangeMode}
            onClick={() => selection && onCommand('REQUEST_MORE_CONTEXT', { paragraph_index: selection.paragraph_index, start: selection.start, end: selection.end, scope })}>{label}</button>
          <div>{scope === 'WORD' ? <><strong>“{selection?.token ?? '待选择'}”</strong><p>{selection ? `第 ${selection.paragraph_index + 1} 段 · 第 ${selection.start + 1}–${selection.end} 字` : '点击原文中的字词。'}</p></> :
            <p>{scope === 'SENTENCE' ? selection?.sentence ?? '选词后显示所在句。' : scope === 'PARAGRAPH' ? selection?.paragraph ?? '选词后显示所在段。' : scope === 'WORK' ? `${session.source} · ${extent}。${context?.work_note ?? '篇章信息待补充'}` : `${context?.author ?? '作者待补充'} · ${context?.era ?? '时代待补充'}`}</p>}</div>
        </li>)}</ol>
        <p className="reader-version">原典链接用于核对原文，不代表释义已经教师审定。</p>
      </aside>
    </div>
  </section>
}
