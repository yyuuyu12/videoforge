# 满分样例库（L3）——首次生成的参照骨架

来源：真实作品首次自动验收 100/100 的章节（VideoForge job-23，2026-07-16，9 章 38 屏结构+截图双审满分）。
**用法**：借鉴的是**版式骨架、约束表达和信息密度**，不是内容——文案、配色语义、章节主题必须按当前作品原创。三个样例覆盖三类高频版式：开场 hero / 数据卡片推进 / 清单收束。

## 为什么这些能拿 100 分（对照契约逐条看）

1. **安全区写死在容器上**：内容容器 `right:448px`（数字人窗）+ `bottom:210~220px`(字幕条)，任何 step 的内容都不可能越界——不是"小心别碰"，是"物理够不着"。
2. **字号从 26px 起步**，正文 30px+，标题 66-84px；小注释用 `--text-mute` 降对比而不是缩字号。
3. **单屏信息预算**：每个 step 一个主意思——一张卡/一句话/一组≤5项的列表；超预算就拆 step，绝不硬塞。
4. **全部用主题 token**（`var(--accent)/--surface-2/--rule/--text-2`），换主题零改动。
5. **数据驱动 step**：内容进数组，JSX 按 `step` 切换——步数变化时结构稳定，narrations 与画面天然对齐。

## 样例一：开场 hero（大标题 + 渐进悬念）

```tsx
import type{ChapterStepProps}from"../../registry/types";import"./chapter.css";
export default function ColdOpen({ step }: ChapterStepProps) {
  return <section className="c01-root">
    <div className="c01-grid" aria-hidden="true" />
    <div className="c01-content">
      <div className="c01-label">SIGNAL 01 · 2026 推流观察</div>
      {step === 0 && <><h1>为什么你的<br/><em>流量不好？</em></h1><div className="c01-pulse">问题不止一个数据</div></>}
      {step === 1 && <><div className="c01-strike">完播率不够</div><h1 className="c01-question">评价方式<br/><em>变了？</em></h1></>}
      {step >= 2 && <><h1 className="c01-title">重做<br/><em>3 个判断</em></h1><div className="c01-tags"><span>谁在评价</span><span>推荐谁</span><span>何为优质</span></div></>}
    </div>
    <div className="c01-index">01—09</div>
  </section>;
}
```

## 样例二：数据卡片推进（每 step 换一种子版式，全程安全区内）

```tsx
import type{ChapterStepProps}from"../../registry/types";import"./chapter.css";
const data=[{t:"旧理解",h:"随机小流量池",p:"完播 · 点赞"},{t:"观察到的变化",h:"相关领域受众",p:"更快参与评价"},{t:"第一批裁判",h:"懂行用户",p:"长期行为形成领域认知"},{t:"专业反馈",h:"收藏 · 停留 · 深评",p:"可能更有参考价值"},{t:"反馈链",h:"看懂 → 收藏 → 复看",p:"深度评论 → 更大人群"}];
export default function Judge({step}:ChapterStepProps){let d=data[step]??data[0];return <section className="c03-root"><div className="c03-wrap"><div className="c03-label">CHAPTER 01 · 内容裁判</div><div className="c03-head"><span>0{step+1}</span><h1>{d.h}</h1></div><p className="c03-sub">{d.t} / {d.p}</p>{step<2?<div className="c03-pools"><div>泛人群<small>随机理解</small></div><b>→</b><div className="on">领域人群<small>相关判断</small></div></div>:step===2?<div className="c03-people">{["创作者","运营者","长期关注者"].map(x=><span key={x}>{x}</span>)}</div>:step===3?<div className="c03-signals">{["收藏","停留","深评"].map((x,i)=><span key={x}><i>{i+1}</i>{x}</span>)}</div>:<div className="c03-chain">{["看懂","收藏","复看","深评"].map(x=><span key={x}>{x}</span>)}</div>}</div><div className="c03-demo">示意 · 非算法权重</div></section>}
```

配套 CSS（注意安全区与 token 的写法）：

```css
.c03-root{position:absolute;inset:0;font-family:var(--font-body)}
.c03-wrap{position:absolute;left:96px;right:448px;top:72px;bottom:220px}  /* ← 安全区并集写死在容器 */
.c03-label{font:30px var(--font-display-en);color:var(--accent);letter-spacing:.06em}
.c03-head{display:flex;align-items:flex-end;gap:30px;margin-top:54px}
.c03-head span{font:76px var(--hero-num-font);color:var(--accent);line-height:.9}
.c03-head h1{font-size:84px;line-height:1;margin:0}
.c03-sub{font-size:30px;color:var(--text-2);margin:24px 0 40px}
.c03-pools{display:flex;align-items:center;gap:28px}
.c03-pools div{width:390px;padding:34px;font-size:42px;background:var(--surface-2);border:2px solid var(--rule)}
.c03-pools div.on{border-color:var(--accent)}
```

## 样例三：清单收束（滚动窗口列表，条数不超屏）

```tsx
import type{ChapterStepProps}from"../../registry/types";import"./chapter.css";
const qs=["有同领域的新信息？","能执行一个具体动作？","有你的真实判断？","能连接下一条内容？","去掉包装仍值得收藏？"];
export default function Checklist({step}:ChapterStepProps){const start=Math.max(0,step-3);const visible=step<5?qs.slice(start,step+1):[];return <section className="c08-root"><div className="c08-wrap"><div className="c08-label">FIELD CHECK · 五问自检</div><h1>{step<5?"你的内容，过关吗？":"先改内容，再看包装"}</h1>{step<5?<div className="c08-list">{visible.map((q,j)=>{const i=start+j;return <article className="on" key={q}><b>0{i+1}</b><span>{q}</span><i>✓</i></article>})}</div>:<div className="c08-summary"><b>3 个答不上来</b><span>暂停研究发布时间、标签和音乐</span><strong>CONTENT FIRST</strong></div>}</div></section>}
```

要点：列表用 `slice(start, step+1)` 做**滚动窗口**——item 再多也永远只显示 ≤4 条，天然不会溢出；收尾 step 切换成总结版式而不是堆满列表。
