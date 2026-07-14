# VideoForge

VideoForge 是一套本机运行的文章/抖音文案到讲解视频工作台。它把文案生成、网页演示、配音字幕、数字人口型和分章节预览组织成可回看、可重试的流水线。

## 快速启动

环境要求：Node.js 22+、npm、Git Bash、ffmpeg。数字人和抖音长视频转录还需要本机 HeyGem 与 Whisper 服务。

```powershell
npm install
npm run build
npm start
```

打开 <http://localhost:5401>。开发时可分别运行：

```powershell
npm run server
npm run dashboard
```

Dashboard 开发地址为 `http://localhost:5400`，API 为 `http://localhost:5401`。

## 核心流程

1. 从文章链接、直接文本或抖音分享链接创建内容。
2. 抖音长视频在后台提取，保存百分比、历史记录和完整转录；完成后由用户决定是否制作。
3. 生成并人工确认口播稿。
4. 选择画面主题与数字人占位。
5. 生成逐页网页演示并预览、对话微调。
6. MiniMax 生成配音与逐字字幕。
7. HeyGem 生成数字人口型，并拆分为章节预览。
8. 在数字人或导出环节检查完整音画。

当前架构、代码地图与文档索引见 [CLAUDE.md](CLAUDE.md)，启动与运维见 [OPERATIONS.md](OPERATIONS.md)，长期技术决策见 [PROJECT-MEMORY.md](PROJECT-MEMORY.md)。

## 数据与密钥

- `settings.local.json`：本机密钥，Git 忽略，接口只返回掩码。
- `data.db`：本机任务状态与历史，Git 忽略。
- `workspaces/`：作品源码、音频、字幕、数字人和预览，Git 忽略。
- `workspaces/_assets/avatars/`：本地数字人素材库。

不得把 API key、用户素材、数据库或生成视频提交到仓库。
