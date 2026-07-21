# VideoForge 项目记忆

## 2026-07-22 结构审计管辖权定稿 + v2b 端到端验证跑

- **审计管辖权铁律：结构审计只对"落定素颜版式"负责，镜头运动质量归 effectScore**。job-30 验证跑
  暴露假 0 分链：镜头推近/呼吸层的变换本来就该越出视口，走查节奏（120ms/步）一旦踩中镜头生效
  窗口，溢出/碰撞全是误报。**job-27 时代拿 100 的真相是走查快于镜头/入场动画的生效窗口——审计
  一直在测"未显影的页面"，等于系统性漏检**。修复：①审计页注入样式中和 `.camera-layer/.camera-punch/
  .camera-breath` 变换；②每步测量前 `document.getAnimations().finish()` 把 scene-lift/whip 等动画
  结算到终态（无限循环动画退 cancel）。首次诚实满显影测量 = job-27 回归 100/100 零误伤。
- **视觉检查三条校准**（首次接触满显影真实内容暴露的边界）：①幽灵底文豁免——低有效不透明度
  （≤0.55，含 3 层祖先连乘）**或**前景色对背景对比度 <3:1（WCAG 大字下限，主题无关）判"退后层"，
  与主体重叠是设计语言（rh-ghost×大数字）不计碰撞；②纯符号装饰（→/斜杠等，无字母数字汉字）骑
  容器边界是图示设计，不计 containerOverflow；③全出血背景媒体（≥70% 舞台面积，host-full 模糊填充
  视频）不是"内容媒体"，文字压背景是电影式设计不计 textOnMedia。校准后 job-30 审计只剩 1 个真缺陷
  （Counter 词触发件压卡片+溢出图表容器——审计抓对了）。
- **审计证据机器可读化**：collisionPairs（谁压谁+重叠面积）与 containerOverflowDetails（哪个叶子
  撑破哪个容器）进 quality-audit.json，修复回喂从"看截图猜"升级为"按选择器名单修"。
- **agentRunner 网络层容错**：`fetch` 抛错（fetch failed/AbortSignal 超时）原来直接冲出重试循环杀死
  整个阶段（job-30 修复轮实撞）；现与 HTTP 5xx 同等待遇，2s/4s 退避重试 3 次再判死。
- **Counter 前后缀正斜混排根治**（人眼校验 job-30 抓出，DOM 盒检测不可见的字形级缺陷）：
  `--hero-num-font` 类斜体英文展示字体缺 ¥/％/中文字形 → 回退字体正体渲染、度量不同，斜体数字
  负侧边距直接压进回退字形（"¥2" 互压成一团）。修复：Counter 的 prefix/suffix 独立
  `.fx-counter__affix` span，`font-style:normal` + `margin-inline:0.06em`。三真源同步
  （garden-skills/videoforge 快照/存量工作区）。**教训：字形级缺陷只有真实截图人眼看才能抓，
  DOM 盒检查对单文本运行内的字距问题天然失明——每轮新效果件验证必须含真节奏截图走查**。
- **v2b 端到端验证结论（job-30，gpt-5.6-sol 全自动）**：重生成 196s → 编排器 15 镜头 → 审计 80 抓真
  缺陷（Counter 词触发件压卡片）→ 自动修复 1 轮 → 100/100 过门 → effectScore 95 只记账，全程零人工。
  19 步真节奏走查：镜头全部正常生效回位（magnify2.8/focus1.45-2.2/pan1.2），修复步版式意图保留。
  MediaFrame/whip 本作未触发（无位图媒体、数字人关闭），视觉验收随下一个带媒体/数字人的作品补。
- **DEFAULTS 数字人尺寸裁定落地**：按 2026-07-17 用户拍板统一为 277×493/reserve480，DEFAULTS.md
  正文更正（旧值 360×640/420 是 ai-market-video 时期）、defaults.json 去除争议标记、defaults.test.js
  锁定该维（文本断言守卫 stages.js 与模板 avatarConfig.ts），claude-skills 源库同步提交。

## 2026-07-20 竞品动效对标批次（效果 v2b）+ 节奏对齐口播

- **竞品实证转场纪律**（逐帧分析 10 条知识类博主片、40 个切换点）：切本身 85%+ 是硬切，
  **零交叉淡化、零滑动**——句级永远硬切；"人↔素材"情绪升档边界用甩切（whip，径向 scale+blur
  冲击 ~190ms）；章节级才允许仪式动作。动画预算全押"切后 1 秒的分层入场"（先框架后数据）。
- 效果 v2b 新件：`enter:"whip"`（CameraCue 正交字段，每章 ≤1，cameraCheck 强制；编排器自动在
  非首章的数字人/章节卡章首布点）、`MediaFrame`（截图/屏录永不裸放：描边浮卡+角标+暗角+框内
  Ken Burns+3D 倾角，chapterLint `bare-media` warn 记账）、ChapterCard `anchor` 变体（选中框
  描边生长+锚点弹入，竞品签名动作）与 `exit` 谢幕、Counter `colorRamp` 随值变色、`.scene-lift`
  场景提亮。effectScore 词表同步收录（fx.media、whipCount 维度）。
- **特效节奏对齐口播的机制定稿**：cue 数据升级为字级时间轴（`charMs`，gen-subtitle-cues 从
  words.json 逐字产出，subtitleCheck 校验与文本逐字对齐）；`useSpeechTrigger` 统一时钟 hook，
  Counter/Slam/Shine/Annotate 均支持 `word` 触发词（旁白念到才播），WordMark 升级字级精度
  （点亮时刻 = 该词首字真实开口时刻，原来只有句级 cue 精度、误差最大 2.5s）。写死毫秒 delay
  只做同拍内错峰。
- **字幕静默劣化升为门禁**：有音频却无 cue 的 step（TTS 未返回 words.json）以前只 warn，播放层
  会退化成 1800ms 墙钟轮换=必然不同步；现 subtitleCheck 判 `step-silent-fallback` error，阶段失败
  要求重跑音频合成。无音频过场步保持 warn。
- **render 结构分补三个盲区**：文字压位图媒体（textOnMedia，svg 豁免——手绘图表标签叠放是设计内；
  figcaption/数字人窗豁免）、字撑破有形容器（containerOverflow，视口内也算破版）、短标签意外
  换行（wrapViolations，≤16 字被挤成两行）。原碰撞检测只算"双方都有文字"，文字压图从此不再被放过。
- effectScore.mjs 路径改走 config.workspacesRoot（B2 纪律，原来硬编码 cwd/workspaces）。
- **质量闭环 P0（把"测量代码在仓库但靠人跑"补成自动闭环）**：①effectScore 从孤儿 CLI 接进
  chapter_gen 后管线（`effectScoreRunner.js` 子进程跑并解析打分卡，`config.effectScore` gate 默认
  false=只记账校准，稳定后开门禁触发效果向修复）；②lint/camera error 自动回喂模型修复 ≤2 轮再判
  失败（`stages.repairFromEvidence`，证据精确到文件+行号），不再只判失败等人工点重试；③`ledgerStats`
  复发缺陷（30 天≥2 次）回流注入 chapter_gen prompt 当"病历"；④个人定稿机器可读化
  `skills/article2video/references/defaults.json` + `defaults.test.js` 一致性守卫（锁语速 1.12/音色/
  字幕上限 10，防 server 默认漂移）。测试 60 项全绿。
- **生成引擎真相 + SSE 修复**：本机 API 模式实配 = OpenAI 兼容代理、模型 `gpt-5.6-sol`（非 Claude，
  印证用户"工作台搭载其他模型"）。agentRunner "上游返回非 JSON 响应（data:{...chat.completion.chunk}）"
  根因 = 上游默认 SSE 流式而代码按整体 JSON 解析；修复：请求带 `stream:false` + `parseChatCompletion`
  兼容两类上游（SSE 时按 index 聚合 tool_calls 的 name/arguments）。
- ~~悬而未决~~（两项均已在 2026-07-22 批次解决，见上一节）：①验证跑 job-30 →已完成端到端校验并
  顺带根治审计假 0 分与 fetch 容错两缺陷；②DEFAULTS 数字人尺寸冲突 → 按 2026-07-17 拍板统一并锁测试。

## 2026-07-17 效果系统定稿：放置机制与密度纪律

- **"什么地方加什么效果"由三个信号源决定**（生成时 AI 按契约执行、校验器把关、审计兜底）：
  ①**数据结构信号**——章节数据里有 figure（大数字）→ 强推近/magnify/Slam；有 items（列表）→ spotlight；
  章首 step → ChapterCard/host；核心结论 lead → QuoteCard；②**口播节奏信号**——钩子句/转折词/结论句
  对应 host 时刻与强调件，WordMark 的词必须与 narration 原词一致；③**预算与平滑纪律**——密度档位
  （dense 默认：每章 2-4 内容镜头且 ≥2）、相邻 step 不连续两个强推近、magnify 每章 ≤1、QuoteCard 全片 ≤2。
- **效果参数保守=用户发现不了问题=迭代停滞**（job-24 首作 AI 只放 2 个 1.12 倍镜头的教训）：
  默认值必须一眼可见——focus 默认 2.0（<1.4 判违规）、magnify 2.6-3.0、上限 3.0。
- 卡片类效果件（QuoteCard/ChapterCard）右侧内边距必须吃进 `--stage-pad-x-end`（数字人安全区），
  2026-07-17 实测金句卡压数字人窗一次，几何断言（右缘<窗左缘）修复后通过。
- 呼吸感微推是独立嵌套层（camera-breath），与镜头变换复合；章节代码不得再写整屏缓推动画（会共振）。
- 数字人窗口定稿 277×493（原 252×448 +10%，2026-07-17 用户拍板），right-third 预留 480px。

## 2026-07-16 字幕对齐三层排查结论 + 渲染时间轴铁律

- 字幕对齐要分三层看：①数据层（words.json vs mp3）实测偏差恒定 -0.04s；②预览播放层（rAF 采样）实测切换偏差 4-26ms（一个 rAF 帧内）；③**成片渲染层才是漂移源**——帧清单曾对相同/乱序时间戳垫 8ms 假时长，视频时间轴被累计拉长而配音按真实挂钟摆放，负载越高垫得越多（"时快时慢"）。修复：重复/乱序时间戳帧直接丢弃，时间轴与挂钟严格一致；render-meta.json 记 droppedFrames/timelineSpanSec 供核对。
- **铁律：判断音画不同步先问用户看的是预览还是成片、哪个作品**——旧成片带旧数据，重渲即修，别在新代码里找不存在的 bug。
- 覆盖 workspace 组件前必须核对各作品的组件接口：旧脚手架有 chapterId/step（章节切片版，job-14）与 videoTimeOffset（offset 版，job-4）两种历史接口，盲目用模板版覆盖会 TS 报错、渲染失败（2026-07-16 实翻车一次，靠 9/9 tsc 全查恢复）。
- 服务预检落地：server/src/preflight.js（servicesStatus + preflightWarnings），GET /api/services/status；流水线 script_outline 开工时记 warning 事件（不阻断，硬检查仍在消费阶段）。默认数字人：settings.avatar.defaultFilename（选择即记默认），avatar_media 无素材时自动带出。

## 2026-07-16 数字人断续的真因与播放架构定稿

- **HeyGem 推理内部自带乒乓延长**（正放→倒放→正放），无需也不要在上传前自行拼接素材。job-20 证据：54.5s 素材铺 165.7s 音频，输出在 54.5s/109s 两个折返点抽帧无跳切、t=30 与原素材姿势 1:1 对齐、无重复帧。底层推理是编译产物（`hdModule/main.cp310-win_amd64.pyd`），不可修改；可改的是包装层 `heygem_server_v2.py`（XiaMuagent/desktop_client）与我们自己的媒体/播放层。
- **"一顿一顿"的真因在播放层**：旧 AvatarPresenter 用"视频常暂停 + 每帧 rAF seek"对齐口型，而 HeyGem 输出关键帧间隔 10s，每次 seek 需从关键帧解码，每秒 60 次 seek 实际只渲染几帧。**禁止用逐帧 seek 驱动视频**。
- 定稿播放架构：视频跟随音频时钟"播放 + 微调"——音频播放则 video.play()，|偏差|<0.5s 用 playbackRate 0.9~1.1 缓慢追齐，换步/换章才硬 seek，音频暂停则视频暂停落位（阈值 0.2s 防 seek 风暴）。实测 25fps 满帧、0 丢帧、速率微调生效（1.016x）。
- lipsync.mp4 下载后必须重编码 `-g 25`（1s 关键帧），章节切片同参；否则任何 seek 都慢。存量作品修复 = 重编码 lipsync + 替换组件 + 预览重建，零模型成本。
- 浏览器无手势时音频不自动播放：实测预览页要用 `?auto=1` + 点击 `.auto-gate`（真实点击）启动，JS `.click()` 不算手势；headless 验证用 `--autoplay-policy=no-user-gesture-required`（与 render.js 同参）。

## 2026-07-16 首次生成优先的质量门禁

- 90 分是交付门槛，不是生成方法。章节生成后的默认路径改为遍历全部 step 的 DOM 结构检查，不写截图；检查覆盖溢出、文字碰撞、标题行数、长文本块、字幕/数字人边界等确定性问题。
- 只有结构检查不通过时才进入截图证据模式并调用最多 3 轮局部修复；修复后重新从无截图结构检查开始。手动 `POST /api/jobs/:id/quality-audit` 继续保留全量截图，用于专项 QA 与发布验收。
- 方法论真源和产品快照新增“首次生成质量契约”：内容预算、字号下限、标题行数和安全区必须在写页面前满足，不能依赖事后缩字或截图修复。
- `quality-audit.json` 始终记录最后一次检查结果；无截图通过时清除陈旧的最低分指针，避免 UI 把已修复作品继续显示为失败。

## 2026-07-16 AUTO-QA 多格式进度与媒体提取兼容

- outline 章节总数需要兼容三类真实格式：旧时间表行、`## 1. 标题`、以及 `## 开场` / `## 第X章`。章节生成开始前必须给出稳定的 `0/N`，不能随生成目录出现从 `0/0` 动态增长。
- `narrations.ts` 允许多行数组与压缩单行数组；工作台 step 计数和音频提取都必须兼容。`chapters.ts` 也允许格式化或压缩导入，提取器匹配 `from` 后不能强制空格。
- 数字人右侧 448px 预留可以表达为 `padding-right`、固定网格列或绝对定位 `right:448px`；确定性布局审计必须识别这些等价表达。
- 真实证据：AUTO-QA #19 为 3 章 12 屏，初审 76 经修复到 100；#20 为 6 章 22 屏，初审、单章对话后和数字人接线后均为 100。#20 的 22 段 narration/mp3/words、95 个字幕 cue 和 22 条 avatar audio-list 顺序一致，字幕最大 10 字；6 个数字人章节切片与音频时长差均不超过 0.2 秒。

## 2026-07-16 PPT 质量门与数字人时间轴

- 本节关于“默认逐屏截图”的旧策略已由上方“首次生成优先的质量门禁”替代；全量截图现在仅在结构门禁失败或手动专项 QA 时执行。其余同步结论和历史测试证据仍有效。
- 更换风格是完整画面重做：必须清空旧 `presentation/` 内容及下游渲染产物，章节进度从 0 开始；旧 Vite 进程可能锁住目录根，Windows 上保留根目录并逐项删除内部内容。
- 章节生成后的质量验收必须遍历所有章节和所有 step，按 1920x1080 截图逐屏评分并以最低分为最终分。低于 90 分时把最低分截图交给生成模型修复，重新构建、重新评分，最多 3 轮；仍不达标不得进入人工验收。
- 字幕契约：单次只显示一行，中文目标 8 字、硬上限 10 字，下一句出现时上一句消失；字幕 cue 必须沿用真实逐字时间戳且 chapter/step 与 narration、音频一致。
- 数字人音频合并和章节切片必须严格按 `presentation/audio-segments.json` 的顺序。禁止用文件系统或目录字母排序；2026-07-16 在 job #15 实测旧排序会让 `accumulate` 先于 `hook`，造成全片口型与画面累计偏移错位。
- 当前默认与本机 API 模型为 `openai-compatible/gpt-5.6-sol`。历史作品事件仍可显示旧模型名，那是历史记录，不代表下一次生成配置。
- 本轮真实证据：9 个历史作品目录完成回归或类型检查，第 10 个新建项目 job #18 生成 4 章 16 屏并首次自动验收 100；job #15 重新生成 30 屏，初审 80，经截图驱动修复后最低分 100。其 30 段配音、30 个逐字时间文件、30 个字幕 step、104 个 cue 均对齐，字幕最大 10 字且时间戳递增。修复数字人字母排序错误后重新生成口型并完成 169 秒成片，30/30 段配音、3615 帧，数字人接线后逐屏审计仍为 100。

## 2026-07-15 工作台反馈与字幕安全区契约

- 桌面工作台左右栏等高并限制在可视工作区内，各自独立滚动；900px 以下恢复自然高度单栏。原文确认没有对话修改，用户可直接编辑、保存并手动确认下一步。
- 对话修改不能只更新右侧状态：口播稿完成后重新读取 `script.md`，画面完成后重建并刷新静态预览；处理期间左侧旧内容必须显示遮罩，完成后明确提示更新范围。逐页反馈支持全局与单章两种作用域。
- 字幕是章节生成时的布局约束，不是成片阶段的覆盖层。底部 / 下三分之一 / 顶部字幕分别预留 190px / 290px / 170px 无正文安全带；与数字人同时启用时取安全区并集。方法论源码与产品快照必须同步。

## 2026-07-15 B8 收尾能力

- 对话修改与预览建立完成契约：逐页画面、配音字幕、数字人修改成功后，feedback 只有在静态预览重建成功后才标记 done；Workbench 仅跟踪本页新提交的反馈，完成时自动刷新一次，并用 `?chapter=` 与旧版 cursor 存储同步当前验收章节。
- Dashboard 的 API 请求统一在 `dashboard/src/api.ts` 翻译常见技术错误；优先保留简短、明确的中文业务校验，连接、超时、鉴权、额度、HeyGem、Whisper 和 ffmpeg 故障必须给出可执行的下一步。
- 便携包脚本 `scripts/package-portable.ps1` 会复制打包机 PATH 中的 `ffmpeg.exe` / `ffprobe.exe` 到包根目录，启动脚本将包根目录置于 PATH 首位；打包前需确认两者均可执行。
- `/api/diagnostics` 是远程排障入口：只导出公开配置状态、最近 20 个作品、最近 200 条事件和日志文件元数据；Bearer、API key、`sk-` 密钥和 JWT 形态内容必须脱敏。
- `/api/version` 仅查询 GitHub Release 并提示新版，5 秒超时、15 分钟缓存；检查失败不阻塞启动，也不自动下载、覆盖程序或修改用户数据。

## 2026-07-15 架构与重做边界更新

- ARCHITECTURE.md 已从“未来三面架构规划”重写为当前运行架构；未来云控制面、跨设备和远程算力继续只放 PRODUCT-PLAN.md，不能写成现有依赖。
- 当前生产拓扑只有 Dashboard/Express 的 5401 主服务；作品预览统一走 /preview/:id/ 静态链。5300–5399 只保留给 previewMode=dev 的方法论开发或紧急回退，不再是每个作品的默认预览端口。
- 作品重做遵循最小下游原则：只重新导出从 render 开始；更换数字人从 avatar_gen 开始；更换配音从 audio_synth 开始；重建 PPT 从 scaffold 开始。仍有效的上游产物必须复用。
- “仅重新导出成片”不得调用 MiniMax、HeyGem 或重新接线数字人，只重新采帧、混音、覆盖 output.mp4 并更新封面；覆盖前必须二次确认。
- 数字人不是渲染时临时贴层。它在 avatar_gen 阶段生成口型、章节切片并接入演示，gate_avatar 验收后成为可复用的 PPT 组成部分。只有更换数字人、配音、字幕结构或重建 PPT 时才重新经过相关下游阶段。
- 数字人和字幕基础接线优先由确定性代码完成；Agent 负责语义创作和局部修改。媒体文件存在不代表接线成功，进入验收门前仍需 typecheck、静态构建和浏览器预览。
- Workbench 导出区现在明确展示“复用 / 重做 / 下一步”，完成作品的按钮为“仅重新导出成片”，并使用确认对话框说明覆盖范围。

## 2026-07-14 配置体检整理

- 统一文档入口为 `CLAUDE.md`（并入原 CURRENT-ARCHITECTURE.md、docs/PROJECT-STATUS.md、docs/README.md，三者已删除）。
- 测试报告归档在 `docs/reports/`；文件归属和提交规则在 `docs/FILE-OWNERSHIP.md`。
- 删除了 agent-workspace 模板残留（IDENTITY.md / USER.md / BOOTSTRAP.md）。
- 方法论快照 vendored 进 `skills/`，`server/src/config.js` 指向仓库内路径（不再依赖 `~/.claude/skills` 个人安装位）；TTS 兜底默认 speed 与 DEFAULTS.md 对齐为 1.12。
- 个人安装位 `~/.claude/skills` 三个视频 skill 已 junction 化 → `F:\Projects\claude-skills` 源码库；机器级路径事实以 `F:\Projects\MACHINE-INDEX.md` + `check-services.ps1` 为准。
- 服务端一键成片落地：页面内拦截每段配音 `playing` 事件取真实起点，CDP screencast 变长帧采集，ffmpeg adelay 精确摆放混音——帧与音轨同机同源时钟，无需录屏。HeyGem 上传前对非 H.264 源自动转码（cv2 读不了 HEVC，job#11 实证）。
- 渲染器启动整片播放必须点击 `.auto-gate` 遮罩，不能按 Space——未打 suppressSpace 补丁的旧 scaffold 双监听会跳过第 0 步（实测丢开场第一段，18/19）。scaffold 模板已打补丁（新项目免疫）。
- 订阅模式生成引擎已迁 Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`，permissionMode=bypassPermissions + settingSources=[]）：无信任对话框 hack、真实 usage/费用上报、个人全局配置不再漏进产品 prompt；`claude -p` 降级为 SDK 不可用时的兜底（仅兜底路径保留 ensureWorkspaceTrusted）。烟测实证：订阅登录直接可用，Write 工具落盘成功。
- `output/`、运行日志、SQLite 数据库和 `workspaces/` 均视为本地运行态，不提交 Git。
- 判断当前系统结构与模块边界优先参考 `ARCHITECTURE.md`；`CLAUDE.md` 保留项目入口、当前实现摘要与开发约定；未来规划以 `PRODUCT-PLAN.md` 为准。

该文件保存长期有效的工程决策，不保存密钥、个人素材或临时任务状态。

## 2026-07-15 B1/B2 落地

- 数据目录分离（B2）：DATA_ROOT 解析 = env VIDEOFORGE_DATA_DIR > config.dataRoot > 旧布局就地 > %APPDATA%VideoForge；冷启动自动供给结构并接走旧密钥/数据库（复制不移动）。
- 数字人拆分（B1）：avatar_media（HeyGem 推理+章节预览，输入指纹 checkpoint，重试不重推理）+ avatar_wire（确定性接线：只写 src/registry/avatarConfig.ts，模板组件数据驱动）。新 scaffold 含 avatar-mount:v1 契约与 Subtitle/AvatarPresenter 模板组件（Subtitle 取自 job-14 审计通过版）；无契约的旧作品自动回退 LLM 接线。在途作品 stage 由 db 迁移平移到 avatar_media。
- 讲师区尺寸定稿沿用：右侧竖窗 252×448、正文预留 448px（角落小窗预留 360px）。

## 产品原则

- 以用户提供的 standalone HTML 为视觉与结构基准，工作台必须保留轻量编辑部质感。
- 每个阶段内容可回看；长任务必须显示明确阶段和百分比。
- 数字人不是覆盖层：选择出镜后，PPT 必须永久让出人物区域。
- 数字人环节必须直接预览合成效果和分章节视频，不要求返回上一环节。
- 素材库暂时纯本地，路径为 `workspaces/_assets/avatars/`。
- 抖音提取完成后由用户决定是否制作；历史记录永久保留并与唯一作品关联。
- 所有内容入口创建作品后统一停在 `gate_source / waiting_approval`；原文允许手动保存调整，确认前不得调用模型。
- 不允许把标题、描述或短 OCR 文本标成完整文案。

## 已验证事实

- A6 OpenAI 兼容 LLM 可运行文案与章节工具循环。
- TikHub 分享链接接口可获取抖音 `aweme_detail`。
- TikHub 的长视频 `caption` 可能恰好在 1000 字处截断；不得将其标记为完整文案，必须转入原声 ASR。
- 本机 Whisper medium 可把 586 秒原声转录为 3352 字。
- MiniMax 已生成真实配音和逐字时间轴。
- HeyGem 已生成 105 秒数字人视频并拆成章节预览。
- 右侧讲师区现按 448px 预留（标准 640px 三分之一区域缩小 30%），保持右侧原锚点；安全区审计兼容新旧作品。

## 固定端口

- `5401` VideoForge 生产控制台/API。
- `5400` Dashboard 开发服务器。
- `5300-5399` 仅供 `previewMode=dev` 方法论开发或紧急回退；产品默认预览不占这些端口。
- `8765` Whisper ASR。
- `7861` HeyGem。

## 当前边界

- 服务端一键成片已实现（2026-07-14，`server/src/render.js`）：render 阶段/导出面板可直接产出 `output.mp4`；手动录屏降级为渲染失败时的兜底。
- 数字人全片已可用，已有音频合并、HeyGem 口型、章节切片、接线与逐章预览；媒体生成与接线 checkpoint 仍需细化，避免接线重试时重复调用昂贵的 HeyGem。
- `ARCHITECTURE.md` 现在只描述当前运行架构；未来云控制面和跨设备规划以 `PRODUCT-PLAN.md` 为准。

## 2026-07-14 预览静态化

- 产品预览、封面截图和服务端渲染统一使用 Express 的 `/preview/:id/` 静态链：先服务 `presentation/dist/`，媒体再回退 `presentation/public/`，不再自动启动 per-job Vite 进程。
- `server/src/preview.js` 对 `src/`、`public/` 和构建配置计算元数据指纹；命中 `dist/.build-fingerprint` 时跳过构建，章节生成成功后先构建再进入人工验收。
- 新作品依赖由提交的 `workspaces/package.json` 锁定并安装到 `workspaces/node_modules/`；各作品不再执行 `npm install`。旧作品如有自己的依赖则保持优先解析。
- 过渡期开关为 `config.previewMode: "static" | "dev"`，默认 `static`；`devServers.js` 仍可用于方法论开发与紧急回退，观察稳定性后再删除自动回退路径。

## 2026-07-15 换风格预览与进度编码

- 换风格重做画面时，旧 `dist/.build-fingerprint` 必须立即失效。`chapter_gen` 期间展示生成遮罩，以进入 `gate_chapters` 且静态构建完成作为新版画面可验收的唯一信号。
- `.videoforge-chapter-progress.json` 真源编码为 UTF-8；服务端为 Windows shell 产生的历史或在途 GB18030 文件保留兼容解码，避免进度中文乱码。

## 修改纪律

- 变更流水线或模块边界时同步更新 `ARCHITECTURE.md`、`CLAUDE.md`，并把长期决策写入本文件。
- 变更服务路径或端口时同步更新 `OPERATIONS.md`。
- 新增密钥字段必须加入后端打码与 `.gitignore` 检查。
- 推送前运行 `npm run build`、Node 语法检查和敏感信息扫描。
