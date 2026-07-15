# VideoForge 项目记忆

## 2026-07-15 B8 收尾能力

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

## 修改纪律

- 变更流水线或模块边界时同步更新 `ARCHITECTURE.md`、`CLAUDE.md`，并把长期决策写入本文件。
- 变更服务路径或端口时同步更新 `OPERATIONS.md`。
- 新增密钥字段必须加入后端打码与 `.gitignore` 检查。
- 推送前运行 `npm run build`、Node 语法检查和敏感信息扫描。
