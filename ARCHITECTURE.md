# VideoForge 当前项目架构

> 本文档描述仓库当前已经运行的系统结构，是架构与模块边界的权威说明。
> 产品交互以 PRODUCT-SPEC.md 为准；启动与排障以 OPERATIONS.md 为准；长期决策以 PROJECT-MEMORY.md 为准；未来商业与云端规划放在 PRODUCT-PLAN.md，不与当前实现混写。
>
> 最后更新：2026-07-15。

## 1. 系统定位

VideoForge 是本机优先的视频生产工作台，把文章、直接文本或抖音内容转成口播稿、网页演示、配音、字幕、数字人口型视频和最终 MP4。

当前产品由三部分组成：

1. Dashboard：React + Vite 操作界面。
2. Server：Express API、SQLite 状态、流水线 worker、静态预览与成片渲染。
3. Workspace：每个作品独立的源码与媒体产物，是作品文件的真相源。

默认完全本机运行。未来账号、云控制面和远程算力属于 PRODUCT-PLAN.md 的规划，不是当前运行依赖。

## 2. 当前运行拓扑

    浏览器
      ├─ 生产控制台 http://127.0.0.1:5401
      │    ├─ /api/*                 Express API
      │    ├─ /preview/:jobId/       作品静态预览
      │    └─ dashboard/dist/        生产 Dashboard
      └─ 开发控制台 http://127.0.0.1:5400
           └─ Vite 代理 /api 到 5401

    VideoForge Server :5401
      ├─ SQLite data.db
      ├─ Pipeline Worker
      ├─ Claude Agent SDK / OpenAI 兼容生成引擎
      ├─ MiniMax TTS
      ├─ HeyGem :7861
      ├─ Whisper ASR :8765
      ├─ 系统 Chrome 或 Edge + playwright-core
      └─ ffmpeg / ffprobe

    workspaces/
      ├─ package.json + package-lock.json   共享演示依赖
      ├─ node_modules/                     运行态，不提交
      ├─ _assets/avatars/                  本地数字人素材库
      └─ job-N/                            单作品全部产物

生产模式只需要 5401。5300–5399 的 per-job Vite 预览仅保留为 previewMode=dev 的方法论开发或紧急回退路径；产品默认不再为每个作品启动独立端口。

## 3. 流水线状态机

阶段顺序由 server/src/stages.js 的 STAGES 定义，server/src/workers/pipeline.js 负责排队、执行、人工门和失败重试：

    gate_source → script_outline → gate_script → gate_style
      → scaffold → chapter_gen → gate_chapters
      → audio_synth → gate_audio → subtitle_cues → gate_subtitles
      → avatar_gen → gate_avatar → gate_render → render → done

gate_* 是人工确认门，其余为自动工作阶段。服务重启后，running 任务恢复为 queued，worker 继续处理。

| 阶段 | 主要职责 |
|---|---|
| gate_source | 用户确认原文章或抖音转录 |
| script_outline | 生成 script.md 与 outline.md |
| gate_script | 用户审阅口播稿 |
| gate_style | 确认主题、字幕和数字人占位 |
| scaffold | 创建 presentation 基础工程 |
| chapter_gen | 逐章生成 React/CSS 与章节注册 |
| gate_chapters | 逐章预览、确认和对话微调 |
| audio_synth | MiniMax 配音和逐字时间戳 |
| gate_audio | 用户验收声音 |
| subtitle_cues | 生成字幕 cues、组件与样式 |
| gate_subtitles | 用户验收字幕 |
| avatar_gen | HeyGem 口型、章节切片和页面接线 |
| gate_avatar | 逐章数字人验收 |
| gate_render | 用户确认完整预览 |
| render | 采帧、混音、生成 MP4 和封面 |
| done | 下载、播放或仅重新导出 |

## 4. 重做与复用边界

流水线遵循“从受影响的最晚阶段开始，复用所有仍有效的上游产物”。

| 用户操作 | 从哪里开始 | 复用 | 必须重做 |
|---|---|---|---|
| 只重新导出成片 | render | PPT、配音、字幕、数字人口型 | 采帧、混音、MP4、封面 |
| 更换数字人或重做口型 | avatar_gen | 原文、稿件、PPT、配音、字幕 | HeyGem 口型、切片、接线、最终导出 |
| 更换音色、语速或配音 | audio_synth | 原文、稿件、PPT | 配音、字幕、数字人、导出 |
| 修改字幕规则 | subtitle_cues | 原文、稿件、PPT、配音 | 字幕、合成检查、导出 |
| 修改单章画面 | gate_chapters 反馈入口 | 其他章节与稿件 | 目标章节及下游检查 |
| 更换主题或重建 PPT | scaffold | 原文与稿件 | 框架、章节及全部下游 |
| 修改稿件 | script_outline 或保存后从 scaffold | 原内容 | PPT、配音、字幕、数字人、导出 |

重要不变量：仅重新导出绝不调用 MiniMax 或 HeyGem，也不返回 PPT、字幕或数字人阶段。覆盖旧 MP4 前必须二次确认。

## 5. 预览架构

产品预览、封面截图和服务端渲染使用同一条静态链：

    presentation/src 或 public 变化
      → server/src/preview.js 计算元数据指纹
      → Vite build
      → presentation/dist/.build-fingerprint
      → Express 服务 /preview/:jobId/

关键规则：

- 指纹未变化时不重复构建。
- 静态请求先读 presentation/dist，再回退 presentation/public 中的媒体。
- 新作品共享 workspaces/node_modules，不执行 per-job npm install。
- previewMode 默认 static；dev 只用于方法论开发和紧急回退。
- 工作台 iframe、整片播放、封面截图与 render.js 使用同一个 preview URL。

## 6. 成片渲染架构

server/src/render.js 的导出流程：

1. preparePreview 确保静态预览已构建。
2. playwright-core 启动本机 Chrome 或 Edge。
3. 点击页面 auto-gate 启动完整自动播放；不能用 Space 替代，否则旧演示可能跳过第 0 步。
4. 监听每段音频 playing 事件，记录浏览器同源时钟中的真实起点。
5. 通过 CDP screencast 采集变长帧。
6. ffmpeg 按真实时间轴放置音轨并输出 workspaces/job-N/output.mp4。
7. 写 render-meta.json，更新封面；成功清理 render-tmp，失败保留现场。

render 路由异步返回，进度通过 job_events 的 progress|百分比|说明 事件呈现。同一作品由进程内 renderingJobs 集合防止重复渲染。

## 7. 数字人与字幕

数字人不是覆盖层。选择数字人后，演示布局必须永久让出右侧讲师安全区；当前标准预留宽度为 448px。

avatar_gen 当前负责：合并配音；必要时把源形象转为 H.264；调用 HeyGem；生成 lipsync.mp4；按章节切分预览；应用或校验 AvatarPresenter、Subtitle 组件与 CSS 接线；typecheck 并重新构建预览。

字幕样式和基础组件优先由确定性代码落盘；Agent 主要负责稿件、章节创作和需要语义判断的局部修改。媒体文件存在不等于页面接线成功，进入人工门前必须完成类型检查和浏览器预览。

## 8. 数据与文件真相源

SQLite data.db 保存 articles、jobs、job_events、feedback 和 douyin_extractions。数据库负责状态；workspace 负责文章、稿件、提纲、演示源码、音频、字幕、数字人视频、封面和最终 MP4。两者不能互相替代。

运行态文件不提交 Git：settings.local.json、config.json、data.db、workspaces 下除共享 package 清单以外的内容、output、dist、日志和媒体。密钥只能来自本地设置或环境变量，GET 接口必须打码。

## 9. 代码地图

| 路径 | 当前职责 |
|---|---|
| server/src/index.js | Express 入口、静态预览和 Dashboard 托管 |
| server/src/routes.js | HTTP API、人工门、审核和渲染入口 |
| server/src/db.js | SQLite schema、查询与任务恢复 |
| server/src/stages.js | 阶段表和各阶段实现 |
| server/src/workers/pipeline.js | job 队列、worker、审批与重试 |
| server/src/workers/extractions.js | 抖音后台提取 |
| server/src/agentRunner.js | Agent SDK、claude 兜底和 OpenAI 兼容工具循环 |
| server/src/providers.js | 轻量 LLM 完成与连接测试 |
| server/src/preview.js | 静态构建、指纹、类型检查和文件服务 |
| server/src/render.js | 浏览器采帧、音轨对齐、成片和封面 |
| server/src/minimax.js | TTS、时间戳、音色预览与克隆 |
| server/src/heygem.js | HeyGem 健康检查、提交、轮询与下载 |
| server/src/douyin.js | TikHub、原声选择、Whisper 和完整性校验 |
| dashboard/src/App.tsx | 页面路由与主导航 |
| dashboard/src/pages/Workbench.tsx | 七段式工作台、人工门、预览和重做说明 |
| dashboard/src/pages/Works.tsx | 作品列表、封面与人话状态 |
| dashboard/src/pages/NewWork.tsx | 新建内容和抖音提取入口 |
| dashboard/src/pages/Assets.tsx | 本地数字人素材库 |
| dashboard/src/pages/Settings.tsx | 服务与模型设置 |
| dashboard/src/pages/Usage.tsx | 本地用量汇总 |
| dashboard/src/lib/statusText.ts | 全站状态文案唯一映射 |
| skills/ | 随仓库提交的方法论与模板快照 |

routes.js、stages.js 和 Workbench.tsx 已较大。未来可按领域拆分，但不能改变状态机、文件格式或 API 契约；稳定性修复优先于纯结构重构。

## 10. 当前依赖与边界

必需依赖：Node.js 22+、npm、PATH 中的 ffmpeg/ffprobe，以及系统 Chrome 或 Edge。

按功能需要：Claude 订阅或 OpenAI 兼容 API、MiniMax、HeyGem :7861、Whisper ASR :8765、TikHub token。

agent.maxConcurrent 默认 1。不同作品保留独立状态，但重生成任务仍受 worker 和外部服务串行或限速约束；不要把“多作品存在”写成“所有生成阶段完全并行”。

## 11. 已知改进项

- 按稳定领域拆分 routes.js、stages.js 和 Workbench.tsx，保持外部契约不变。
- 为数字人媒体生成和页面接线增加细粒度 checkpoint，存在有效 lipsync.mp4 时避免重复调用 HeyGem。
- 补齐通用 fromStage 重做 API；当前只重新导出有独立 render API，其他重做仍依靠阶段专用入口和 retry。
- 静态预览稳定观察完成后，移除产品路径对 devServers 的兼容依赖并归还 5300–5399。
- 增加静态预览、数字人安全区、字幕、自动播放和重复导出覆盖确认的浏览器回归。

## 12. 维护纪律

- 改状态机或模块边界：更新 ARCHITECTURE.md、CLAUDE.md 和 PROJECT-MEMORY.md 中受影响的长期规则。
- 改页面流程或文案：更新 PRODUCT-SPEC.md。
- 改端口、启动命令或外部服务：更新 OPERATIONS.md。
- 改文件归属：更新 docs/FILE-OWNERSHIP.md 和 .gitignore。
- 新增密钥字段：后端打码、日志检查、示例配置和 Git 忽略一起处理。
- 交付前至少运行 npm run build、改动 server 文件的 node --check，以及 git diff --check。
