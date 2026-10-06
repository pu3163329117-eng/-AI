import { useState } from 'react'
import type { CommandType, ContextScope, ContextSelection, TrainingSession } from '../types'

const layers: [ContextScope, string][] = [['WORD', '词'], ['SENTENCE', '句'], ['PARAGRAPH', '段'], ['WORK', '篇'], ['ERA', '时代']]
const extentLabels = { FULL: '全文', CHAPTER: '完整章节', EXCERPT: '课内节选', PROMPT: '题目原文' }

function sentenceAt(paragraph: string, start: number, end: number) {
  const characters = Array.from(paragraph)
  while (start > 0 && !'。！？'.includes(characters[start - 1])) start -= 1
  if (!'。！？'.includes(characters[end - 1])) {
    while (end < characters.length) {
      const character = characters[end++]
      if ('。！？'.includes(character)) break
    }
  }
  return characters.slice(start, end).join('')
}

function tokensFor(paragraph: string, terms: string[], characterMode: boolean) {
  const characters = Array.from(paragraph)
  const dictionary = characterMode ? [] : terms.filter(term => Array.from(term).length <= 8).sort((a, b) => Array.from(b).length - Array.from(a).length)
  const tokens: { token: string; suffix: string; start: number; end: number; clickable: boolean }[] = []
  for (let start = 0; start < characters.length;) {
    const remainder = characters.slice(start).join('')
    const token = dictionary.find(term => remainder.startsWith(term)) ?? characters[start]
    const end = start + Array.from(token).length
    let next = end
    while (next < characters.length && '，。；：！？、”’）》」』】'.includes(characters[next])) next += 1
    tokens.push({ token, suffix: characters.slice(end, next).join(''), start, end, clickable: /[\p{L}\p{N}]/u.test(token) })
    start = next
  }
  return tokens
}

function defaultSelection(session: TrainingSession, paragraphs: string[]): ContextSelection | null {
  const paragraphIndex = paragraphs.findIndex(paragraph => paragraph.includes(session.variable) && paragraph.includes(session.evidence))
  const index = paragraphIndex < 0 ? paragraphs.findIndex(paragraph => paragraph.includes(session.variable)) : paragraphIndex
  if (index < 0) return null
  const paragraph = paragraphs[index]
  const start = Array.from(paragraph.slice(0, paragraph.indexOf(session.variable))).length
  const end = start + Array.from(session.variable).length
  return { paragraph_index: index, start, end, token: session.variable, paragraph, sentence: sentenceAt(paragraph, start, end), scope: 'WORD' }
}

export function ContextReader({ session, busy, onCommand }: {
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
  const extent = extentLabels[context?.extent ?? 'EXCERPT']
  const sourceUrl = context?.source_url && /^https?:\/\//i.test(context.source_url) ? context.source_url : null

  function select(paragraphIndex: number, start: number, end: number, scope: ContextScope = selection?.scope ?? 'WORD') {
    if (busy) return
    if (rangeMode) {
      if (!anchor || anchor.paragraph !== paragraphIndex) { setAnchor({ paragraph: paragraphIndex, start }); setRangeError(''); return }
      const rangeStart = Math.min(anchor.start, start)
      const rangeEnd = Math.max(anchor.start + 1, end)
      if (rangeEnd - rangeStart > 80) { setRangeError('词组最多选择 80 个字，请重新选择。'); setAnchor(null); return }
      start = rangeStart; end = rangeEnd
      setAnchor(null); setRangeMode(false)
    }
    onCommand('REQUEST_MORE_CONTEXT', { paragraph_index: paragraphIndex, start, end, scope })
  }

  return <section className="fulltext-reader" aria-labelledby="fulltext-title" aria-busy={busy}>
    <header className="fulltext-heading">
      <div><p className="stage-label">原文点读 · {extent}</p><h2 id="fulltext-title">先在篇中读，再回到词上。</h2></div>
      <button type="button" className="reader-range-toggle" aria-pressed={rangeMode} disabled={busy}
        onClick={() => { setRangeMode(!rangeMode); setAnchor(null); setRangeError('') }}>{rangeMode ? '取消词组选择' : '选择任意词组'}</button>
    </header>
    <p className="reader-guide" aria-live="polite">{rangeError || (rangeMode ? (anchor ? '再点同段的结束字，选取整段词组。' : '先点词组起始字，再点结束字。') : '点击字词查看五层语境；选择任意词组可精确定位同段连续文字。')}</p>
    <div className="fulltext-layout">
      <div className="fulltext-canvas" tabIndex={0} aria-label={`${session.source}${extent}`}>
        <p className="fulltext-source">{session.source} · {context?.work_note ?? '当前课内原文'}</p>
        {paragraphs.map((paragraph, paragraphIndex) => <p className="fulltext-paragraph" key={paragraphIndex}>
          {tokensFor(paragraph, context?.terms ?? [], rangeMode).map(({ token, suffix, start, end, clickable }) => {
            const selected = selection?.paragraph_index === paragraphIndex && start < selection.end && end > selection.start
            const anchored = anchor?.paragraph === paragraphIndex && anchor.start === start
            return clickable ? <span className="reader-word" key={start}><button type="button" disabled={busy}
              className={`text-token${selected ? ' is-selected' : ''}${anchored ? ' is-anchor' : ''}`} aria-pressed={selected}
              aria-label={`第 ${paragraphIndex + 1} 段第 ${start + 1} 字，查看“${token}”的语境`}
              onClick={() => select(paragraphIndex, start, end)}>{token}</button>{suffix}</span> : <span key={start}>{token}{suffix}</span>
          })}
        </p>)}
        <p className="reader-version">{context?.text_version ?? '资料版本待校订'}{sourceUrl && <> · <a href={sourceUrl} target="_blank" rel="noreferrer">核对原文</a></>}</p>
      </div>
      <aside className="context-layers" aria-live="polite" aria-label="当前字词的五层语境">
        <p className="stage-label">语境标尺 · {session.context_selection ? '已保存' : '点击后保存'}</p>
        <ol>{layers.map(([scope, label]) => <li key={scope} className={selection?.scope === scope ? 'active-layer' : ''}>
          <button type="button" aria-pressed={selection?.scope === scope} disabled={!selection || busy || rangeMode}
            onClick={() => selection && onCommand('REQUEST_MORE_CONTEXT', { paragraph_index: selection.paragraph_index, start: selection.start, end: selection.end, scope })}>{label}</button>
          <div>{scope === 'WORD' ? <><strong>“{selection?.token ?? '待选择'}”</strong><p>{selection ? `第 ${selection.paragraph_index + 1} 段 · 第 ${selection.start + 1}–${selection.end} 字` : '点击原文中的字词。'}</p></> :
            <p>{scope === 'SENTENCE' ? selection?.sentence ?? '选词后显示所在句。' : scope === 'PARAGRAPH' ? selection?.paragraph ?? '选词后显示所在段。' : scope === 'WORK' ? `${session.source} · ${extent}。${context?.work_note ?? '篇章信息待补充'}` : `${context?.author ?? '作者待补充'} · ${context?.era ?? '时代待补充'}`}</p>}</div>
        </li>)}</ol>
        <p className="reader-version">语境提供阅读依据，不直接代替你的词义判断。</p>
      </aside>
    </div>
  </section>
}
