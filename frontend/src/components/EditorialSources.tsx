type Props = { core: string; transfer: string }

const extentLabels: Record<string, string> = { FULL: '全文', CHAPTER: '完整章', EXCERPT: '连续节选', PROMPT: '仅题目原文' }

function materialFrom(text: string) {
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const context = value.reading_context
    return {
      source: typeof value.source === 'string' ? value.source : '出处待填写',
      context: context && typeof context === 'object' && !Array.isArray(context) ? context as Record<string, unknown> : null,
    }
  } catch { return null }
}

export function EditorialSources({ core, transfer }: Props) {
  return <section className="editor-sources" aria-label="当前编辑稿的原文来源">
    <h3>原文与版本</h3>
    <p className="field-note">以下来自当前编辑稿；保存后才进入审核。来源链接用于人工核对，系统不代替文本校勘。</p>
    <div className="source-stage-list">{[['CORE', core], ['TRANSFER', transfer]].map(([stage, text]) => {
      const material = materialFrom(text)
      const context = material?.context
      const url = typeof context?.source_url === 'string' && /^https?:\/\//i.test(context.source_url) ? context.source_url : null
      const paragraphs = Array.isArray(context?.paragraphs) ? context.paragraphs.filter((item): item is string => typeof item === 'string') : []
      return <article key={stage}>
        <p className="stage-label">{stage === 'CORE' ? '核心原文' : '迁移原文'}</p>
        <h4>{material?.source ?? 'JSON 尚未填写或格式有误'}</h4>
        <p>{extentLabels[String(context?.extent ?? '')] ?? '材料范围待核对'} · {paragraphs.length} 段 · {Array.from(paragraphs.join('')).length} 字（含标点）</p>
        <p>{String(context?.author ?? '作者待补充')} · {String(context?.era ?? '时代待补充')}</p>
        <p>{String(context?.work_note ?? '请填写阅读单元的完整范围。')}</p>
        <p className="source-version">{String(context?.text_version ?? '资料版本待补充')}</p>
        {url ? <a href={url} target="_blank" rel="noreferrer">打开原文来源核对 ↗</a> : <p>缺少公开原文来源链接，请在 reading_context.source_url 填写。</p>}
      </article>
    })}</div>
  </section>
}
