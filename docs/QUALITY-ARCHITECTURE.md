# VideoForge 质量与修改架构

更新时间：2026-07-16

本文收敛近期关于 PPT 首次生成质量、截图审计、右侧对话修改、Skill 经验回写、字幕与数字人同步的讨论。它描述当前决策，并明确区分已实现能力与待实现能力。

## 1. 核心目标

- VideoForge 自身应稳定产出高质量作品，Codex 和人工逐页修复不是日常生产依赖。
- 90 分是交付门槛，不是生成方法；首先提高初次生成质量，截图只负责发现静态规则覆盖不到的问题。
- 可确定的问题交给代码、组件和检查器；需要内容与审美判断的问题交给 Skill 和生成模型。
- 修复经验必须回写为通用规则。只修当前作品而不归因，不能算质量闭环。

## 2. PPT 生成质量链路

```text
文章/口播稿
  -> Skill 首次生成契约
  -> 主题 token + 固定舞台 + 安全区组件
  -> 章节生成
  -> 全 step DOM 结构门禁（不截图）
       | 通过：进入人工画面验收
       | 失败：生成截图证据 -> 最多 3 轮局部修复 -> 重新从结构门禁开始
  -> 手动/专项全量截图审计（按需）
```

首次生成契约包括：标题最多两行、字号下限、单屏信息预算、长文本限制、字幕与数字人安全区并集、禁止缩字硬塞、图表连线不得穿过文字。规则位于 Skill 真源和产品快照的 `CHAPTER-CRAFT.md`。

当前已经实现：

- 全部章节和 step 的无截图 DOM 结构检查。
- 溢出、文字碰撞、标题行数、长文本、字幕和数字人边界评分。
- 低于 90 时才生成逐屏截图并进入有限修复。
- 手动 `POST /api/jobs/:id/quality-audit` 保留全量截图模式。
- 最新结果统一写入 `quality-audit.json`，避免修复后仍读取旧失败状态。

当前进展（2026-07-16）：首次分统计与缺陷归因已由 quality-ledger 承接（GET /api/quality/ledger）；静态 linter 已落地（server/src/chapterLint.js：字号下限=error，写死颜色/超长文本=warn，lint-allow 豁免通道）——流水线观察模式记账、受保护事务中阻断回滚，规则稳定后流水线转执法。仍未完成：按主题/版式的失败类型细分。

## 3. Skill 经验回写

经验分三类处理：

| 缺陷类型 | 归属 | 示例 |
|---|---|---|
| 可确定、可测量 | 代码/组件/linter | 字号下限、标题行数、溢出、安全区、字幕字数 |
| 跨内容通用的生成方法 | Skill 真源和产品快照 | 信息预算、先拆 step、视觉层级、图表组织 |
| 单作品特例 | 当前 workspace | 特定文案措辞、某页特殊构图 |

方法论修改顺序：先改 `F:\Projects\claude-skills\garden-skills\skills\web-video-presentation` 真源，验证后同步到 `F:\Projects\videoforge\skills\web-video-presentation` 产品快照。主题特例不得污染全局规则。

## 4. 右侧对话修改

当前已经实现：阶段范围提示、全局/单章节选择、最小修改提示、TypeScript 检查、预览重建与刷新、参考图、Enter 发送、Shift+Enter 换行。

当前核心缺口：范围主要靠 prompt 约束，没有改前快照、服务端 changed-files 白名单、改后质量对比和失败自动回滚。因此右侧对话仍可能越界修改或越修越乱，不能视为 Codex 等级的可靠修改器。

目标架构是受保护事务：

```text
记录作用域和改前文件
  -> 建立快照与质量基线
  -> Agent 最小修改
  -> 服务端校验真实文件差异
  -> typecheck + build
  -> 静态门禁；高风险或失败时截图复核
  -> 通过则提交结果；越界、降分或构建失败则自动还原
```

单章节修改只允许写选中章节目录和极少数明确注册文件；不能信任模型自述的 `git diff`。该事务已于 2026-07-16 实现（server/src/feedbackTransaction.js）：快照+基线分 → Agent → 真实差异白名单校验（越界文件自动还原）→ typecheck+build → 结构门禁分数对比 → 降分/失败整体回滚。R1 意图路由与 L1 质量记账本同日落地（feedbackRouter.js / qualityLedger.js，GET /api/quality/ledger）。

## 5. 字幕与数字人同步

同步以同一份顺序清单为真相源：

```text
narrations.ts
  -> audio-segments.json
  -> mp3 + words.json
  -> subtitleCues.ts
  -> avatar/audio-list.txt
  -> HeyGem lipsync.mp4
  -> 章节切片和 UI 章节顺序
```

任何一层不得按目录字母排序。step 结构变化后必须重做配音、字幕和数字人口型，不能复用旧下游媒体。字幕目标 8 字、硬上限 10 字、单行、cue 时间递增；章节音视频时长误差门槛为 0.2 秒。

当前已经修复 `audio-segments.json` 顺序被目录排序破坏的问题。仍需继续处理数字人断续感：验证不能只比较总时长，还应检查章节边界的静音、重复帧、时间戳跳变、音频波形连续性和视频帧连续性。此类同步与拼接问题主要属于代码和媒体管线，不应只靠 Skill 提示词解决。

字幕契约已于 2026-07-16 转确定性执法（server/src/subtitleCheck.js）：subtitle_cues 阶段生成后立即校验 cue ≤10 字（不可拆纯拉丁整词如 "Transformer" 豁免）与时间递增，违规即阶段失败并记入质量账本。同日修复切分器一处真缺陷：MiniMax 对数字/英文按音节逐条返回整词文本（"2017" 出现 4 条），直接拼接产出 "20172017…" 连体怪——切分器现对连续同文本拉丁/数字词条去重（gen-subtitle-cues.mjs，产品模板与 skill 双真源已同步）。job-13/14 旧数据已用新切分器重生成并通过校验；重生成只重写 subtitleCues.ts、时间戳仍来自 words.json，不会引入音画不同步。

## 6. 最近验证证据

- AUTO-QA #19：3 章 12 屏，初审 76，经修复到 100；全局对话后仍为 100。
- AUTO-QA #20：6 章 22 屏，初审、单章节对话后和数字人接线后均为 100。
- #20 新结构门禁回归：22 屏最低 100，`mode=structure-first`，`screenshotsCaptured=0`。
- #20 字幕共 95 cue，最大 10 字；22 段 narration、mp3、words 和 avatar audio-list 顺序一致。
- #20 六个数字人章节切片与音频时长误差均不超过 0.2 秒，但这不等于已经排除主观可感知的断续感。

## 7. 文档与记忆入口

- 项目长期记忆：`F:\Projects\videoforge\PROJECT-MEMORY.md`
- 本质量架构：`F:\Projects\videoforge\docs\QUALITY-ARCHITECTURE.md`
- 最新 AUTO-QA：`F:\Projects\videoforge\docs\reports\AUTO-QA-2026-07-16.md`
- 最新质量与同步长测：`F:\Projects\videoforge\docs\reports\FULL-FLOW-TEST-2026-07-16.md`
- 产品交互规范：`F:\Projects\videoforge\PRODUCT-SPEC.md`
- 当前技术架构：`F:\Projects\videoforge\ARCHITECTURE.md`
- 运维说明：`F:\Projects\videoforge\OPERATIONS.md`
- 自动化运行记忆：`C:\Users\木木\.codex\automations\videoforge\memory.md`
- Skill 真源：`F:\Projects\claude-skills\garden-skills\skills\web-video-presentation`
- 产品 Skill 快照：`F:\Projects\videoforge\skills\web-video-presentation`

两小时自动化当前为暂停状态。

## 8. 质量为什么不累积——机制澄清与回写闭环（2026-07-16 决策）

### 8.1 先回答核心困惑

每次章节生成是**无状态**的：输入只有 Skill 快照（CHAPTER-CRAFT 等）+ 模板组件 + 主题 token + 本篇文章。因此：

- 上一个作品的 30 分**不会**拖累下一个作品（不存在跨作品记忆污染）；
- 上一个作品修到 90 分也**不会**自动让下一个作品变好——除非修复被回写到持久层。

修复只有两种去向，判断标准一句话：**改了 workspace = 只帮这一次；改了持久层 = 帮以后每一次。**持久层就三个：①模板/组件（结构性防错）②Skill 真源（生成方法）③结构门禁/linter（兜底检查）。"下次还能不能 80-90 分"完全取决于这轮修复有多少被归因回写——目前回写靠自觉，这就是不确定感的根源。

### 8.2 首次质量提升的四个杠杆（按 ROI 排序）

**L1 回写强制化（质量记账本）**：每轮修复循环结束必须产出缺陷账目（类型/章节/主题/修复层级），追加写入 `docs/quality-ledger.jsonl`。铁律：**同类缺陷出现第二次 = 必须回写持久层**（linter 规则或 CHAPTER-CRAFT 条目二选一），只修 workspace 不允许结案。门禁已输出分数与缺陷类型，账本只是持久化+统计。

**L2 契约前移进模板**：凡能用组件/CSS 锁死的规则从 prompt 挪进模板——模板锁死一条，CHAPTER-CRAFT 就少求一条，首次分数结构性上移。下一批候选：标题组件内置两行截断、字号 token 化（章节代码只允许预设字阶，禁止任意 px）、信息密度容器（超预算在构建时报错）。

**L3 高分样例库**：把 90+ 分章节按版式类型（数据对比/时间线/结论页…）沉淀进 Skill 的 EXAMPLES/，生成 prompt 要求"先看同版式样例再写"。模型从"凭规则凭空写"变成"照及格样例改"——生成侧提升首次质量最直接的一招。

**L4 首次分数统计**：账本按周汇总"修复前首次分"中位数，这是"底层能力是否在提升"的唯一真相。目标：首次中位分 ≥85 后，修复循环从常态降级为异常处理。

## 9. 右侧对话修改——三层修复方案（2026-07-16 决策）

### 9.1 顾此失彼的三个根因

1. **意图错配（最大根因）**：音画不同步、断续、时序类问题本质是媒体管线问题（§5），让对话 Agent 改章节代码去"修同步"，正确解法根本不在它能触达的层面——必然拆东墙补西墙。
2. **无事务保护**：无改前快照、无 changed-files 白名单、无改后分数对比与自动回滚（§4 已识别）。
3. **引擎差距**：对话走 API 模式 4 工具循环（read/write/list/run_command），没有 grep/全局搜索，模型只能读它猜到的文件——天然局部视野，不具备 Codex/Claude Code 的"搜索→通读→改→验证"能力。

### 9.2 方案（按实施顺序）

**R1 意图路由（先做，半天）**：对话入口先分类再分发——
- 同步/断续/音画/时长类 → **不进 Agent**，直接给"重跑对应确定性阶段"按钮（audio_synth → subtitle_cues → avatar 级联），必要时自动触发；
- 视觉/文案类 → 进受保护事务 Agent（R2）；
- 全局风格类（换主题/字号基线）→ 改 token/配置 + 全量重建，不逐章改代码。
起步用关键词规则分类即可，后续可升级为 LLM 分类器。（2026-07-16 增量：字幕呈现类表述——"太长/几行/一句一句/像电影字幕"——同样路由到 subtitle_cues 重跑；此前用户在对话里调字幕长度导致音画不同步，正是错配型修改的实例。）

**R2 受保护事务落地（§4 方案的实施细则，约 1 天）**：`feedbackTransaction.js` 包装层——①改前把 `presentation/src` 复制为 `.feedback-snapshot/` 并记录 quality-audit 基线分；②Agent 执行，白名单 = 选中章节目录 + 明确注册文件，服务端按真实文件 mtime/差异校验，越界文件直接从快照还原；③改后 tsc + build + 结构门禁重跑；④分数不降且构建通过才保留，否则整体还原并把失败证据回给用户。不信任模型自述的 diff。

**R3 引擎与证据升级（半天）**：右侧对话允许走订阅 Agent SDK 路径（自带 Grep/Glob/多文件编辑，接近 Claude Code 修改能力；三路径引擎已具备，只差 feedback 调用时选路）；同时把 quality-audit 的缺陷 JSON 与截图直接喂进 feedback prompt——现在的 Agent 是盲修，先给它证据再谈能力。

### 9.3 组合效果

R1 消灭最大一类"越修越坏"（错配型）；R2 保证剩下的修改"最多无效、不会变坏"（可回滚）；R3 提升"有效"的比例。三者与 §8 的回写闭环合流：事务通过的修复同样要过 L1 账本归因。
