# VideoForge 全流程与架构审计报告 - 2026-07-14

## Job #14 API 模式全流程补充结论

- 测试文章：2,722 字符；全程保持 API 模式，实际生成服务为 `openai-compatible/gpt-5.6-terra`，未切换订阅模式。
- 最终状态：`done`，工作台七个阶段全部完成。
- 成片：`workspaces/job-14/output.mp4`，195 秒，1920x1080，30fps，H.264 + AAC，5,637,958 字节。
- 口播与画面：生成 10 章 React 演示，实时预览正常。
- 配音：20/20 MiniMax 片段生成成功，审计 `audio.ok=true`。
- 字幕：自动高对比、底部位置，审计 `subtitle.ok=true`。
- 数字人：本作品明确选择“不使用”，因此未调用 HeyGem 生成；HeyGem 健康检查仍为 ready。
- 导出：服务端采帧与混音完成 20/20 片段，审计 `render.ok=true`。

本轮发现并修复：章节就绪校验错误要求每章独立 CSS；生成工程的旁白提取器无法处理注册 ID 与目录名不完全一致；成功重试后 API 仍显示历史失败信息。验证执行 `npm run build`、`node --check server/src/routes.js`、`git diff --check`，均通过（仅既有换行符提示）。

检查时间：2026-07-14（Asia/Singapore）  
主测试作品：Job #13《引入 AI 编程工具前先想清楚的三件事》  
成功成片基线：Job #5《AI 开发工具实力榜：2026 年 7 月版（全流程自检）》

## 1. 结论

当前架构适合作为单机、单用户的快速迭代工作台，核心技术路线已经成立：React/Vite 工作台、Express/SQLite 状态机、workspace 文件真相源、按作品启动预览、MiniMax 字幕时间轴、HeyGem 对口型以及 Chrome + ffmpeg 服务端成片都已有真实产物证明。

但本次不能判定“全流程稳定通过”，也不建议把当前状态视为可连续无人值守出片。Job #13 已完成稿件、5 章画面、18 段配音、18 组逐字时间轴、77.28 秒数字人视频和 5 个章节预览，最终停在 `avatar_gen / failed`。直接原因是数字人接入页面的 Agent SDK 遇到订阅会话限额；生成代码还漏掉 `AvatarPresenter.css` 和 `Subtitle.css` 的导入，浏览器中数字人和字幕布局实际失效。

综合判断：基础设施可用，流程编排可恢复，服务端渲染已被 Job #5 实证；当前发布结论为 **No-Go**，需先修复 P0 项再做一次不人工改文件的全新作品回归。

## 2. 服务状态

| 服务 | 状态 | 实测结果 |
| --- | --- | --- |
| VideoForge 生产控制台/API :5401 | 通过 | `/api/health` 返回 `{"ok":true}`，生产 Dashboard 可打开 |
| Dashboard 开发端口 :5400 | 未运行 | 不影响 :5401 生产构建 |
| Job #13 预览 :5313 | 通过 | Vite 页面、5 章导航、音频驱动字幕数据均可加载 |
| HeyGem :7861 | 通过 | `processor_ready:true`，健康检查 2-6ms |
| Whisper/FunASR :8765 | 失败 | 无监听；会阻断无内嵌字幕的抖音本地转写 |
| IndexTTS :8766 | 未运行 | 当前 VideoForge 主流程使用 MiniMax，不是直接阻断项 |
| ffmpeg / ffprobe | 通过 | ffmpeg 8.1，均在 PATH |
| Chrome | 通过 | 系统 Chrome 路径可被渲染器发现 |
| yyagent 控制面 | 通过 | 公网 `/api/health` 可访问 |
| frpc / HeyGem 外网隧道 | 失败 | frpc 未运行，外网 HeyGem 健康检查失败 |

未重新调用 TikHub、MiniMax 测试音频、LLM 测试接口或 HeyGem 全量生成。原因是这些调用可能计费或消耗模型额度；本报告使用当天 Job #13 的真实调用记录和现有落盘产物完成验证。

## 3. Job #13 全流程结果

| 阶段 | 结果 | 证据 |
| --- | --- | --- |
| `script_outline` | 通过 | 110 秒生成 `article.md`、`script.md`、`outline.md` |
| `gate_script` | 通过 | 人工审批事件存在 |
| `gate_style` | 通过 | 人工审批事件存在；该阶段未写入当前入口文档的阶段图 |
| `scaffold` | 通过 | 25 秒；演示工程依赖和 TypeScript 检查成功 |
| `chapter_gen` | 重试后通过 | 首次撞 40 轮上限，第二次 HTTP 524，第三次 330 秒完成 5 章 |
| `gate_chapters` | 通过 | 人工审批事件存在 |
| `audio_synth` | 通过 | 48 秒；18/18 MP3，410 字符，18/18 `.words.json` |
| `subtitle_cues` | 通过但过度依赖 LLM | 671 秒；确定性 cues 已生成，但组件接线仍交给 Agent |
| `avatar_gen` | 产物完成、阶段失败 | 77.28 秒 H.264 对口型视频和 5/5 章节预览存在；页面接线因订阅限额失败 |
| `render` | 未进入 | 导出阶段被失败状态锁住；未对错误布局强行渲染 |

Job #13 浏览器实测：自动模式点击入口后字幕文本会推进，`lipsync.mp4` 可解码到 `readyState=4`。但 `AvatarPresenter.css` 与 `Subtitle.css` 未导入，数字人 `<aside>` 退化为普通流式布局，视频矩形位于可视舞台左侧；字幕样式也未生效。自动审计同时报告 5/5 章节未识别到安全区，因此不能视为视觉验收通过。

## 4. 成片基线

Job #5 的 `output.mp4` 验证通过：

- 1920x1080、30fps、H.264 High + AAC mono。
- 时长 112.87 秒，文件 24.84MB。
- 抽帧确认右侧数字人、正文让位和高对比字幕均正常。
- 音频平均响度约 -22.8dB，峰值 -2.1dB。
- 未检测到 0.5 秒以上黑场；结尾约 2.1 秒静帧，属于可接受的收尾停留。

这证明 `server/src/render.js` 的 Chrome 采帧 + ffmpeg 混音路线可用。需要注意：Job #4、#11 虽为 `done`，但没有 `output.mp4`；当前 `done` 表示流水线完成，不等于服务端成片已经生成。

## 5. P0 问题

### P0-1 确定性接线放在昂贵阶段之后交给 LLM

`avatar_gen` 先完成音频合并、HeyGem 推理、下载和章节切片，最后才调用 Agent 修改 React 代码。任何会话限额、上游超时或漏改 CSS 都会让已完成的数字人产物无法进入导出。重试当前阶段还会重新提交 HeyGem，没有以 `lipsync.mp4` 和接线完成标记做细粒度 checkpoint。

建议把 Subtitle/Avatar 组件、CSS、App 导入和安全区变量改成仓库内确定性模板；Agent 只负责章节创作。`avatar_gen` 至少拆为 `avatar_media` 与 `avatar_wire`，并根据产物哈希跳过已完成的模型计算。

### P0-2 本机服务暴露到局域网且无认证

5401 当前监听 `::`，通过本机局域网 IPv4 地址也能访问。API 没有认证，包含设置修改、作品删除、重试、上传和声音克隆等写操作；`GET /api/settings` 还会返回密钥尾部提示。对“仅本机工作台”应显式监听 `127.0.0.1`，并增加 Host/Origin 校验。若未来允许远程访问，则必须增加正式认证和 CSRF 防护。

### P0-3 失败原因没有持久化到 Job

`jobs` 表没有 `error` 字段，worker 失败时只把详细错误写进 `job_events`，Dashboard 却读取 `job.error`。因此 Job #13 页面显示“后端未返回具体错误”，实际事件中已有明确的订阅限额原因。应增加 `jobs.error`/`failed_at`，失败时原子写入，重试成功后清空。

### P0-4 当前自动审计不能作为发布门

安全区审计只匹配少量 `padding-right`、固定网格列和 448/600/700px 宽度写法，Job #13 使用 `inset: ... 360px ...` 时全部判失败。另一方面，Job #13 的 meta 没有 `avatar.position`，代码默认只预留 360px，与项目记忆里的 448px 和 DEFAULTS 的 420px 右侧内边距存在三套口径。应统一为结构化布局 token，并在浏览器里用真实 DOM 矩形做 overlap audit，而不是正则扫 CSS。

### P0-5 Whisper 服务离线

现有三条抖音提取历史都成功，但当前 :8765 无监听。无字幕抖音的新提取会在本地 ASR 路径失败。需恢复 startup 自启或把设置页明确显示为阻断状态。

## 6. P1 架构与治理问题

- `routes.js` 约 36KB、`stages.js` 约 27KB、`Workbench.tsx` 约 36KB，已经超过单文件易维护范围。未来规划中的按领域拆分是合理方向，但应在稳定性 P0 后执行。
- `subtitle_cues` 的数据生成是确定性的，组件接入却使用 LLM，Job #13 为此耗时 671 秒并经历多次 524。该步骤应完全模板化。
- `audio_synth` 只检查 `MINIMAX_API_KEY` 环境变量，而设置模块支持把 MiniMax key 存在 `settings.local.json`。设置页显示“已配置”不代表流水线一定能读到同一个 key 来源。
- `express.json` 注释写 30MB，实际限制 250MB；Base64 上传 180MB 视频会显著放大内存。应改流式 multipart 上传，并在服务端验证文件大小和媒体类型。
- worker 重启时把所有 `running` 任务直接改回 `queued`，但 Agent 阶段只是“idempotent-ish”。没有阶段 attempt、lease、checkpoint 和产物提交协议，崩溃恢复可能重复调用模型或覆盖半成品。
- `run_command` 允许 API Agent 在 workspace 内执行任意 shell 命令。文件路径工具有越界保护，但 shell 命令本身没有命令白名单或进程级沙箱；在未来多用户/远程模式下不可直接沿用。
- `AGENTS.md`/`CLAUDE.md` 的阶段图缺少 `gate_style`；`ARCHITECTURE.md` 仍把多个已完成功能标为待建，虽已注明是未来规划，但顶部仍称“唯一结构权威文档”，容易误导。
- `article2video` 与 `video-avatar-subtitles` 的源码库和产品快照各有一处说明漂移；`web-video-presentation` 一致。全局规范称 junction 后无需同步，但产品实际读取 `videoforge/skills/`，仍需显式同步快照。

## 7. Git 与供应链

- `videoforge/master` 与 `origin/master` 同步，当前保留用户未提交改动：`server/src/agentRunner.js`、`server/src/settings.js`，以及未跟踪 `AGENTS.md`。
- `F:\Projects` 和 `F:\Projects\claude-skills` 为本地 Git 仓库，但未配置 remote。
- `garden-skills/main` 比 `origin/main` ahead 1，包含本地 `suppressSpace` 模板补丁，尚未 push。
- `settings.local.json`、`data.db`、`workspaces/`、`logs/`、`output/` 均被正确忽略，没有运行态文件被 Git 跟踪。
- `npm audit --omit=dev`：0 个已知漏洞。
- 仓库敏感信息模式扫描：无命中。

## 8. 本次验证命令与结果

- `npm run build`：通过。
- 全部 17 个 `server/src/**/*.js` 执行 `node --check`：通过。
- Job #13 `presentation/npm run build`：通过。
- `npm audit --omit=dev`：通过，0 漏洞。
- Playwright：生产控制台、Job #13 工作台、独立预览和自动播放入口均已打开验证。
- ffprobe/ffmpeg：Job #13 数字人媒体、Job #5 最终成片、响度、黑场和静帧均已检查。
- `check-services.ps1`：已执行，结果见服务状态表。

## 9. 建议修复顺序

1. 将字幕和数字人接线模板化，增加分阶段 checkpoint，保证重试不重复模型计算。
2. 增加 `jobs.error`，让失败原因在工作台可见。
3. 绑定 `127.0.0.1`，收紧本机 API 暴露面。
4. 统一右侧数字人布局 token，并把浏览器 DOM overlap audit 设为进入 render 前的硬门。
5. 恢复 Whisper/frpc 自启并重新跑服务体检。
6. 修复 MiniMax key 来源不一致、上传内存问题和文档/skill 快照漂移。
7. 用一篇新的短文执行一次全新回归：全程不人工改 workspace 文件，要求最终 `done`、自动审计全绿并生成 `output.mp4`。
