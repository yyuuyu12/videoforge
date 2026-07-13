# VideoForge 当前架构

最后更新：2026-07-13。本文描述已经运行的代码；`ARCHITECTURE.md` 保留中长期规划。

## 组件

```text
浏览器
  -> dashboard (React + TypeScript + Vite)
  -> server :5401 (Express + node:sqlite)
       -> LLM: 本机 Claude CLI 或 OpenAI 兼容 API
       -> TikHub: 抖音视频信息与完整原声地址
       -> Whisper :8765: 原声转文字
       -> MiniMax: 配音与逐字时间戳
       -> HeyGem :7861: 数字人口型
       -> workspace/presentation: 每个作品独立的 React 演示
```

## 代码地图

- `dashboard/src/pages/Works.tsx`：作品卡片与真实封面。
- `dashboard/src/pages/NewWork.tsx`：文本、文章、抖音入口；抖音后台进度与历史。
- `dashboard/src/pages/Workbench.tsx`：七阶段工作台、回看、预览、对话调整。
- `dashboard/src/pages/Assets.tsx`：本地数字人素材库。
- `dashboard/src/pages/Settings.tsx`：LLM、TikHub/ASR、MiniMax、声音克隆、HeyGem。
- `server/src/routes.js`：HTTP API 与本地文件服务。
- `server/src/workers/pipeline.js`：作品流水线调度与恢复。
- `server/src/workers/extractions.js`：持久化抖音提取任务。
- `server/src/stages.js`：文案、画面、音频、字幕、数字人和导出阶段。
- `server/src/douyin.js`：TikHub、原声音轨选择、Whisper、完整性校验。
- `server/src/agentRunner.js`：Claude CLI/OpenAI 兼容工具循环。
- `server/src/devServers.js`：按作品启动 Vite 预览端口。

## 数据模型

SQLite 表：

- `articles`：文章或完整抖音转录。
- `jobs`：作品阶段、状态和参数。
- `job_events`：长任务与错误日志。
- `feedback`：右侧对话修改记录。
- `douyin_extractions`：抖音提取链接、阶段、百分比、文案、文章及作品关联。

文件真相源：

```text
workspaces/job-N/
  article.md
  script.md
  outline.md
  assets/presenter.mp4
  presentation/
    src/chapters/
    public/audio/
    public/avatar/lipsync.mp4
    public/avatar/chapters/*.mp4
```

## 流水线阶段

```text
script_outline -> gate_script -> scaffold -> chapter_gen -> gate_chapters
-> audio_synth -> subtitle_cues -> avatar_gen -> render -> done
```

`gate_script` 与 `gate_chapters` 必须人工确认。已完成环节始终可回看。服务重启后 `running` 任务回到队列继续。

## 抖音提取

1. 提交后写入 `douyin_extractions`，HTTP 立即返回任务号。
2. TikHub 根据分享链接获取原视频数据。
3. 内嵌文本按视频时长检查；短标题不能冒充完整字幕。
4. 优先选择与视频时长匹配的原声 MP3，否则使用低码率视频流。
5. Whisper 最长轮询 10 分钟，页面每 2 秒读取持久化进度。
6. 长视频最低合理字数按 `max(200, durationSeconds * 1.1)` 校验。
7. 完成后只保存历史；用户点击后才创建作品，并记录唯一 `job_id`。

## 安全边界

- 密钥只在 `settings.local.json` 或环境变量。
- 前端读取的密钥全部打码。
- 用户数据库、素材、作品和日志不进入 Git。
- TikHub 真实请求可能计费；重复提取应从历史记录复用。
