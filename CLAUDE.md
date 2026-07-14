# VideoForge

本机运行的「文章/抖音文案 → 讲解视频」工作台：文案生成、网页演示、配音字幕、数字人口型、分章节预览组成可回看、可重试的流水线。React+Vite dashboard（:5400 dev）+ Express+node:sqlite server（:5401）。

## 启动

```powershell
npm install && npm run build && npm start   # 生产：http://localhost:5401
npm run server / npm run dashboard          # 开发：API :5401 + Vite :5400
```

依赖服务：Whisper ASR :8765、HeyGem :7861（启动命令见 `OPERATIONS.md`；一键体检 `F:\Projects\check-services.ps1`）。后台启动的重定向日志写到 `logs/`，不要写在仓库根目录。

## 代码地图

- `server/src/routes.js` — HTTP API 与本地文件服务
- `server/src/workers/pipeline.js` — 流水线调度与重启恢复；`workers/extractions.js` — 抖音提取任务
- `server/src/stages.js` — 文案/画面/音频/字幕/数字人/导出各阶段实现
- `server/src/render.js` — 服务端一键成片：无头 Chromium（playwright-core + 系统 Chrome/Edge）实播采帧 + ffmpeg 按真实时间轴混音，产出 `workspaces/job-N/output.mp4`
- `server/src/agentRunner.js` — 生成引擎三路径：订阅模式走 Claude Agent SDK（主）→ `claude -p`（兜底）；API 模式走 OpenAI 兼容工具循环
- `server/src/douyin.js` — TikHub、原声选择、Whisper、完整性校验
- `server/src/devServers.js` — 按作品分配 :5300-5399 预览端口
- `dashboard/src/pages/Workbench.tsx` — 七阶段工作台；`NewWork.tsx` 内容入口；`Settings.tsx` 服务配置
- `skills/` — 随仓库提交的方法论快照（产品 prompt 的真源，见下"skills 规则"）

## 流水线与数据

阶段：`script_outline → gate_script → scaffold → chapter_gen → gate_chapters → audio_synth → subtitle_cues → avatar_gen → render → done`。两个 gate 必须人工确认；重启后 `running` 任务自动回队列。

SQLite（`data.db`）：`articles` / `jobs` / `job_events` / `feedback` / `douyin_extractions`。文件真相源在 `workspaces/job-N/`（article.md、script.md、outline.md、presentation/）。

## 文档路由（改什么读什么）

| 要做什么 | 读 |
|---|---|
| 安装、启动、依赖服务、常见故障 | `OPERATIONS.md` |
| 长期技术决策、已验证事实、修改纪律 | `PROJECT-MEMORY.md` |
| 做 UI / 页面交互 | `PRODUCT-SPEC.md` |
| 未来规划、云端架构（**不是现状**） | `ARCHITECTURE.md`、`PRODUCT-PLAN.md` |
| 文件归属与提交规则 | `docs/FILE-OWNERSHIP.md` |
| 历史测试报告 | `docs/reports/` |

本文件是现状与入口的唯一权威；旧的 CURRENT-ARCHITECTURE.md / docs/PROJECT-STATUS.md / docs/README.md 已并入此处。

## skills 规则

产品 prompt 引用 `videoforge/skills/`（仓库内快照），**不引用** `C:/Users/木木/.claude/skills/`（那是交互会话的个人安装位，经 junction 指向 `F:\Projects\claude-skills` 源码库）。改方法论：先改 `claude-skills` 源码库，确认后同步快照进本仓库并提交，两边都要生效。个人定稿参数（语速 1.12、音色 GongheJiucun02、字幕/头像布局等）以 `skills/article2video/references/DEFAULTS.md` 为准，server 默认值不得与其漂移。

## 修改纪律

- 变更流水线/模块边界 → 同步更新本文件的代码地图与阶段图
- 变更端口、启动命令、依赖服务 → 同步更新 `OPERATIONS.md`
- 长期决策与验证事实 → 写入 `PROJECT-MEMORY.md`
- 新增密钥字段 → 后端打码 + `.gitignore` 检查
- 推送前：`npm run build` + `node --check` 改动的 server 文件 + 敏感信息扫描

## 数据与红线

`settings.local.json`（应用密钥，注意与 `.claude/settings.local.json` 是两个无关文件）、`data.db`、`workspaces/`、`output/`、`*.log` 均不进 Git。API key 只走环境变量或 settings.local.json，永不写入文档/代码/对话。TikHub 请求计费，重复提取先查历史。**严禁重新克隆声音**（GongheJiucun02 已付费定稿）。
