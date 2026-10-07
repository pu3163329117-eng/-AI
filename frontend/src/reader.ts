export type ReadingToken = { token: string; suffix: string; start: number; end: number; clickable: boolean }
export type ReadingTarget = { paragraph: number; start: number }

export function sentenceAt(paragraph: string, start: number, end: number) {
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

export function tokensFor(paragraph: string, terms: string[], characterMode: boolean): ReadingToken[] {
  const characters = Array.from(paragraph)
  const dictionary = characterMode ? [] : [...new Set(terms)].filter(term => term && Array.from(term).length <= 8).sort((a, b) => Array.from(b).length - Array.from(a).length)
  const tokens: ReadingToken[] = []
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

/** One Tab stop for the text; arrows navigate without making learning commands. */
export function readingIndex(key: string, current: number, targets: ReadingTarget[]) {
  if (!targets[current]) return null
  if (key === 'ArrowLeft') return Math.max(0, current - 1)
  if (key === 'ArrowRight') return Math.min(targets.length - 1, current + 1)
  const paragraph = targets[current].paragraph
  const indexes = targets.map((target, index) => ({ ...target, index }))
  if (key === 'Home') return indexes.find(target => target.paragraph === paragraph)?.index ?? current
  if (key === 'End') return indexes.filter(target => target.paragraph === paragraph).at(-1)?.index ?? current
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const candidates = indexes.filter(target => key === 'ArrowDown' ? target.paragraph > paragraph : target.paragraph < paragraph)
    if (!candidates.length) return current
    const nextParagraph = key === 'ArrowDown' ? Math.min(...candidates.map(target => target.paragraph)) : Math.max(...candidates.map(target => target.paragraph))
    return candidates.filter(target => target.paragraph === nextParagraph).sort((a, b) => Math.abs(a.start - targets[current].start) - Math.abs(b.start - targets[current].start))[0].index
  }
  return null
}
