# VideoForge 项目记忆

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
- 判断当前实现优先参考 `CLAUDE.md`；`ARCHITECTURE.md` 主要保留未来规划和历史决策。

该文件保存长期有效的工程决策，不保存密钥、个人素材或临时任务状态。

## 产品原则

- 以用户提供的 standalone HTML 为视觉与结构基准，工作台必须保留轻量编辑部质感。
- 每个阶段内容可回看；长任务必须显示明确阶段和百分比。
- 数字人不是覆盖层：选择出镜后，PPT 必须永久让出人物区域。
- 数字人环节必须直接预览合成效果和分章节视频，不要求返回上一环节。
- 素材库暂时纯本地，路径为 `workspaces/_assets/avatars/`。
- 抖音提取完成后由用户决定是否制作；历史记录永久保留并与唯一作品关联。
- 不允许把标题、描述或短 OCR 文本标成完整文案。

## 已验证事实

- A6 OpenAI 兼容 LLM 可运行文案与章节工具循环。
- TikHub 分享链接接口可获取抖音 `aweme_detail`。
- 本机 Whisper medium 可把 586 秒原声转录为 3352 字。
- MiniMax 已生成真实配音和逐字时间轴。
- HeyGem 已生成 105 秒数字人视频并拆成章节预览。
- 右侧讲师区现按 448px 预留（标准 640px 三分之一区域缩小 30%），保持右侧原锚点；安全区审计兼容新旧作品。

## 固定端口

- `5401` VideoForge 生产控制台/API。
- `5400` Dashboard 开发服务器。
- `5300-5399` 每个作品的预览服务器。
- `8765` Whisper ASR。
- `7861` HeyGem。

## 当前边界

- 服务端一键成片已实现（2026-07-14，`server/src/render.js`）：render 阶段/导出面板可直接产出 `output.mp4`；手动录屏降级为渲染失败时的兜底。
- 数字人全片已可用，但 10 秒分段、乒乓源循环、边界交叉相关对齐仍需继续实现和专项验证。
- `ARCHITECTURE.md` 包含未来云控制面和跨设备规划，不能当作当前运行状态。

## 修改纪律

- 变更流水线时同步更新 `CLAUDE.md`。
- 变更服务路径或端口时同步更新 `OPERATIONS.md`。
- 新增密钥字段必须加入后端打码与 `.gitignore` 检查。
- 推送前运行 `npm run build`、Node 语法检查和敏感信息扫描。
