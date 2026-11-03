import type { Page } from '../navigation'
import './AboutPage.css'

type Props = {
  onNavigate: (page: Page) => void
  onReplayTour?: () => void
}

const contextLayers = [
  ['词', '这个字词，在这里是什么意思？'],
  ['句', '前后词句，提供了什么线索？'],
  ['段', '这一段，在说明什么？'],
  ['篇', '放回整篇，是否讲得通？'],
  ['时代', '作者与时代，带来什么背景？'],
] as const

const learningSteps = [
  ['先读原文', '进入今日训练，先读文章或标明范围的选段，试着给出自己的判断。'],
  ['找出依据', '点读字词、查看语境，明确选择原文上下文或本句注释作为依据；使用注释会记为辅助。'],
  ['核对判断', '对照原文检查线索；自己的推断理由可以展开选填，不写也能继续训练。'],
  ['换句试试', '在新的句子中尝试迁移，练过之后再用复习和专项练习巩固。'],
] as const

/** An honest product introduction, with no data fetching or account writes. */
export function AboutPage({ onNavigate, onReplayTour }: Props) {
  return <main className="about-page" aria-labelledby="about-title">
    <header className="about-intro">
      <p className="about-kicker">关于文言·推理</p>
      <h1 id="about-title">关于我们</h1>
      <p className="about-statement">不只记住答案，<br />更要读懂为什么。</p>
      <p className="about-summary">文言·推理是一个围绕原文、语境与证据展开的文言文学习产品。我们希望把“这个词是什么意思”，继续追问成“为什么在这里是这个意思”。</p>
      <div className="about-actions">
        <button type="button" className="about-action about-action-primary" onClick={() => onNavigate('home')}>进入今日训练</button>
        {onReplayTour && <button type="button" className="about-action" onClick={onReplayTour}>重新了解产品功能</button>}
      </div>
    </header>

    <section className="about-purpose" aria-labelledby="about-purpose-title">
      <div>
        <p className="about-kicker">我们的初心</p>
        <h2 id="about-purpose-title">把理解，放回原文。</h2>
        <p>一个字可以有不同的意思，熟悉的解释未必适合眼前这句话。我们想让学习者有机会先思考、再找证据，也能看见自己在哪一步还不确定。</p>
      </div>
      <div>
        <p className="about-kicker">我们的愿景</p>
        <h2>从读懂这一句，到敢读下一篇。</h2>
        <p>我们希望陪伴学习者逐渐形成独立阅读的方法：有依据地判断、清楚地表达，也愿意在遇到新材料时修正自己的理解。这是持续打磨的方向，不是一次练习就能保证的效果。</p>
      </div>
    </section>

    <section className="about-section" aria-labelledby="about-context-title">
      <div className="about-section-heading">
        <p className="about-kicker">核心功能 · 原文点读</p>
        <h2 id="about-context-title">点一个词，读五层语境。</h2>
        <p>在已提供的文章或选段中点选字词，结合注释与前后文理解含义。词义不只是一条释义，也需要一句话、一段文字来支持。</p>
      </div>
      <ol className="about-context-layers" aria-label="五层语境">
        {contextLayers.map(([label, description]) => <li key={label}>
          <strong>{label}</strong>
          <p>{description}</p>
        </li>)}
      </ol>
      <p className="about-note">点读信息的覆盖和审核状态以具体条目标记为准；缺失或待审核内容不应当作已确认的结论。</p>
    </section>

    <section className="about-section" aria-labelledby="about-start-title">
      <div className="about-section-heading">
        <p className="about-kicker">怎么使用 · 一次完整训练</p>
        <h2 id="about-start-title">判断、选依据、核对，再到迁移。</h2>
        <p>首次使用先完善学习资料，选择初中或高中起点，再从今日训练开始。已有档案可以继续使用，不用重新填写。</p>
      </div>
      <ol className="about-learning-steps">
        {learningSteps.map(([title, description], index) => <li key={title}>
          <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          <div><h3>{title}</h3><p>{description}</p></div>
        </li>)}
      </ol>
    </section>

    <section className="about-section" aria-labelledby="about-progress-title">
      <div className="about-section-heading">
        <p className="about-kicker">练过之后</p>
        <h2 id="about-progress-title">看见进展，也看见边界。</h2>
      </div>
      <dl className="about-feature-list">
        <div><dt>复习与专项练习</dt><dd>回看需要巩固的内容，再按具体训练方向选择练习，不必反复寻找入口。</dd></div>
        <div><dt>能力地图与学习报告</dt><dd>结合已有学习记录观察训练表现和样本情况；尚未练习的部分，不把它当作已经掌握。</dd></div>
        <div><dt>能力试测</dt><dd>用于了解当前选择题表现与样本边界。试测参考分不等于正式能力等级，也不代表翻译或开放表达能力已被完整评估。</dd></div>
      </dl>
      <div className="about-actions">
        <button type="button" className="about-action" onClick={() => onNavigate('review')}>打开复习</button>
        <button type="button" className="about-action" onClick={() => onNavigate('report')}>查看学习报告</button>
      </div>
    </section>

    <aside className="about-beta-note" aria-labelledby="about-beta-title">
      <h2 id="about-beta-title">和你一起，把内测版本做扎实。</h2>
      <p>我们仍在完善内容、交互和手机体验。正式能力等级需完成题目审核与校准后再开放；当前功能和内容范围以页面实际说明为准。</p>
      <p>发现问题、提出建议，或需要咨询账号与数据，请使用页面底部的“反馈与帮助”。请勿在反馈中填写验证码、邀请码、密钥或他人的学习记录。</p>
    </aside>
  </main>
}
