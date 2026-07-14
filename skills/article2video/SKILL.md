---
name: article2video
description: 「文章→带真人头像的讲解视频」全流程总控。把 web-video-presentation（文章→网页演示+口播音频）和 video-avatar-subtitles（精确字幕+对口型头像）串成一条流水线，并叠加本人已调教定稿的全部个人规范（音色/语速/情绪、字幕样式、头像窗口布局、乒乓分段、MiniMax 调用方式等）——这些规范一律直接采用，不再向用户重复确认。用户只需要回答 5 个决策：①主题/文章 ②视觉主题 ③逐章确认还是一次做完 ④是否合成音频 ⑤是否生成对口型头像。适用：用户说"做个新视频"“把这篇文章做成视频"“新视频项目"时，用这个 skill 而不是直接用底层两个 skill——底层 skill 是方法论，这个 skill 是"带着我全部偏好的一键流程"。
---

# article2video · 文章→讲解视频 一键流水线（个人规范版）

这是**总控 skill**：流程和方法论来自两个底层 skill，个人偏好来自本文件 + `references/DEFAULTS.md`。三层关系：

```
article2video (本文件)          ← 决策入口 + 个人规范，唯一需要"问用户"的层
 ├─ web-video-presentation      ← 基础：文章→口播稿→outline→网页章节→音频（上游 garden-skills 的通用方法论）
 └─ video-avatar-subtitles      ← 精修：逐字字幕 / 对口型头像 / 手机体检（本人踩坑沉淀）
```

**核心原则：除下面 5 个决策外，一切参数按 `references/DEFAULTS.md` 直接执行，不要再问。**
用户此前已在多个项目里反复调教过这些参数（语速、情绪、字幕样式、头像布局、分段长度…），再问一遍就是浪费他的时间。DEFAULTS.md 里的值有明确出处（哪个项目、哪轮反馈定下来的），要改也是用户主动说，不是你猜。

---

## 唯一需要用户回答的 5 个决策

项目开始时一次性问齐（用选项形式，别开放式提问）：

| # | 决策 | 选项 | 默认 |
|---|------|------|------|
| 1 | **主题/文章** | 用户给文章全文 / 给 URL / 只给主题方向（则先帮他找料写稿） | —— 必答 |
| 2 | **视觉主题** | 技术/开发类 → 推荐 `midnight-press`；新闻/政论/社会类 → 推荐 `newsroom`；其他给 2-3 个候选 | 按内容基调推荐 |
| 3 | **开发模式** | 逐章做完给他确认 / 一次全部做完自检后交付 | 一次做完（他两个项目都最终选了这个） |
| 4 | **是否合成音频** | 是 / 否（只要网页） | 是 |
| 5 | **是否对口型头像** | 是（需出镜素材路径，或复用已有素材）/ 否 | 问一次素材在哪 |

问完这 5 个，中途只在两个既有检查点停：**口播稿+outline 确认**（web-video-presentation 自带）、以及模式 3 选"逐章"时的章节验收。其余全程自动推进。

---

## 执行流程

```
① 决策问卷（上面 5 问）
② 按 web-video-presentation 跑：口播稿+outline → [用户确认稿子] → 脚手架+章节开发
   ⚠ 脚手架建好后立即做 Phase 0 体检（见下）
③ 按 video-avatar-subtitles 跑 Phase S：带逐字时间戳重合成音频（语速/情绪按 DEFAULTS）→ 字幕 cues → 接线
④ （决策5=是）按 video-avatar-subtitles 跑 Phase A：乒乓母版 → ~10s 分段 HeyGem 生成 → 交叉相关 offset → 音频时钟从动播放
⑤ 按 video-avatar-subtitles 跑 Phase M：手机字号体检 + 字幕/头像遮挡扫描（全部 step，两个方向）
⑥ 交付：告诉用户录制方法（?auto=1 → Space → OS 录屏），并主动报告最终状态
```

**改动的级联规则**：音频参数（文案/语速/情绪）一旦变更，下游全部失效，必须按 ③→④ 顺序整链重跑（字幕 cues、乒乓切片、offset 都依赖音频时长）。详见 video-avatar-subtitles/references/AVATAR-PIPELINE.md 的"完整重跑顺序"。

---

## Phase 0 · 新项目脚手架体检（每个新项目必做，做完再开发章节）

1. **Space 键双重监听 bug**：`useStepper.ts` 补 `suppressSpace` 选项 + `App.tsx` 传 `mode==="auto" && !autoStarted`——不补的话录制时第 0 步会被跳过。详见 video-avatar-subtitles SKILL.md Phase 0。
2. **端口唯一化**：scaffold 默认 5174，本机多个视频项目并存会冲突。给新项目分配一个没占用的端口（vite.config.ts + .claude/launch.json 同步改）。
3. **jq 不可用**：本机 Git Bash 无 jq 且不允许自动装二进制 → 官方 `synthesize-audio.sh` 跑不了，直接用 skill 里的 `synthesize-audio-node.mjs`（Node 原生 fetch，零依赖）。
4. **HeyGem 服务确认**（决策 5=是时）：`GET http://127.0.0.1:7861/health` 等 `processor_ready:true`；没起就自己拉起来（启动命令见 `F:\Projects\MACHINE-INDEX.md` 服务表），模型加载约 30-90s。

---

## 关键文件索引（去哪找什么）

| 要做什么 | 去哪 |
|---|---|
| 全部个人参数默认值（一张表） | 本 skill `references/DEFAULTS.md` |
| 口播稿写法 / outline 格式 / 主题列表 / 章节动画法则 | `~/.claude/skills/web-video-presentation/references/` |
| 字幕分组算法 / 合成参数调优 / 无时间戳兜底 | `~/.claude/skills/video-avatar-subtitles/references/SUBTITLE-SYNC.md` |
| 头像全管线（乒乓/分段/交叉相关/音频时钟从动/布局） | `~/.claude/skills/video-avatar-subtitles/references/AVATAR-PIPELINE.md` |
| 手机字号体检清单 | `~/.claude/skills/video-avatar-subtitles/references/MOBILE-SIZING.md` |
| 现成脚本（复制进新项目 `presentation/scripts/` 即用） | `~/.claude/skills/video-avatar-subtitles/scripts/`：`synthesize-audio-node.mjs`（TTS+时间戳）、`gen-subtitle-cues.mjs`（字幕 cues）、`heygem-batch-segments.py`（乒乓分段批量生成，改头部路径）、`align-avatar-offsets.py`（交叉相关 offset）、`chunk-subtitle.mjs`、`subtitle-overlap-sweep.js` |
| HeyGem 服务位置/启动/API | `F:\Projects\MACHINE-INDEX.md` 服务表（API 契约另见 video-avatar-subtitles/references/AVATAR-PIPELINE.md「HeyGem 服务」节） |
| 密钥处理红线 | `~/.claude/CLAUDE.md`（一句话版：key 只走环境变量，永不贴 chat、永不写文件，检查只用布尔判断） |

## 硬性红线（任何模型执行都不可违反）

- **绝不重新克隆声音**。`GongheJiucun02` 是已付费的永久音色，克隆收费（~9.9 元/次）；合成才是便宜的按次操作。只有用户明确说"换人声"才走克隆流程。
- **绝不让用户把 API key 粘贴到对话里**，也绝不把 key 写进任何文件。缺 key 时：给用户 `setx MINIMAX_API_KEY <占位>` 让他自己在自己终端跑，然后重启会话。
- **模型调用（HeyGem/TTS 全量重合成）前先报预估耗时/费用**，得到确认再跑；跑完如实报告成功/失败数，不要静默。
