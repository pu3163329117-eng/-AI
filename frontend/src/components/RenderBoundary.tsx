import { Component, createRef, type ReactNode } from 'react'

/** Last-resort render protection. Network errors belong to normal page states.
 * It does not intercept mutations, clear storage or auto-replay any operation. */
export class RenderBoundary extends Component<{ children: ReactNode; onHome?: () => void }, { failed: boolean }> {
  state = { failed: false }
  private heading = createRef<HTMLHeadingElement>()
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() {
    this.heading.current?.focus({ preventScroll: true })
    this.heading.current?.scrollIntoView({ block: 'start', behavior: 'auto' })
  }
  render() {
    if (!this.state.failed) return this.props.children
    return <main className="render-recovery" role="alert" aria-labelledby="render-error-title">
      <p className="eyebrow">学习页面 · 显示异常</p>
      <h1 id="render-error-title" tabIndex={-1} ref={this.heading}>当前页面显示出了问题。</h1>
      <p>已保存的学习记录不会因此被删除。重新读取只加载数据，不会自动提交答案；本页未保存的输入可能丢失。</p>
      <div className="recovery-actions"><button type="button" className="button button-primary" onClick={() => window.location.reload()}>重新读取当前页面</button>
        {this.props.onHome && <button type="button" className="button button-secondary" onClick={this.props.onHome}>返回今日训练</button>}</div>
    </main>
  }
}
