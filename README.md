# VideoForge

把「文章 → 讲解视频」流水线产品化的单机控制台。底层复用两个已验证的 Claude Code Skill：

- `web-video-presentation` — 文章 → 口播稿/outline → 网页演示（Vite+React）→ TTS 音频
- `video-avatar-subtitles` — 逐字时间戳精确字幕（+ 可选对口型头像，v1 未接入流水线）

## 形态与前提

**个人工具形态**：生成环节跑的是本机 headless Claude Code（`claude -p`），走你已登录的订阅，
不需要 Anthropic API key。前提：

- 本机 `claude` 命令可用且已登录
- 两个 Skill 已安装在 `~/.claude/skills/`（路径可在 config.json 改）
- Git Bash 可用（脚手架脚本用 bash）
- TTS 需要 MiniMax key：启动 server 的终端里先 `set MINIMAX_API_KEY=sk-api-...`

## 运行

```bash
npm install          # 一次，装 server + dashboard
npm run server       # 终端 1 → http://localhost:5401 (API)
npm run dashboard    # 终端 2 → http://localhost:5400 (控制台，代理 /api)
```

生产模式：`npm run build` 后只跑 `npm start`（server 直接伺服打包好的控制台）。

配置：复制 `config.example.json` 为 `config.json` 按需改（主题、skill 路径、TTS 音色、并发数）。

## 流水线

```
选题(RSS 定时抓取/手动 URL) → 做成视频(建 Job + workspace/article.md)
  → script_outline   agent 产出口播稿+outline（自检后落盘）
  → [稿件审批门]      控制台里看 workspace 下的 script.md/outline.md，点通过
  → scaffold         bash 脚手架（主题固定 config.theme）
  → chapter_gen      agent 按 outline 建全部章节 + tsc + 自检
  → [章节验收门]      启动预览 iframe 看片；反馈框把修改意见发给 scoped agent，改完刷新再看；满意点通过
  → audio_synth      MiniMax 合成（增量、限流、带逐字时间戳）
  → subtitle_cues    时间戳→字幕 cues + agent 接线 Subtitle 组件
  → render           输出录屏指引（?auto=1 一镜到底）；后续版本接 Playwright 自动录制
```

失败的阶段在任务详情页一键重试；server 重启后 running 状态的任务自动回队列续跑
（真相全在 workspace 文件系统里，阶段幂等）。

## 已知边界（v1）

- 成片录制是手动的（页面 `?auto=1` + OS 录屏）——最可靠；自动化录制（Playwright+ffmpeg）留给 v2
- 对口型头像未进流水线（需要 HeyGem 本地服务 + 素材），要做时对着 `video-avatar-subtitles` skill 的 AVATAR-PIPELINE.md 加一个 stage 即可
- 文章正文抽取是朴素的 HTML 去标签，微信公众号一类反爬站点建议手动贴正文
- 订阅额度就是吞吐上限：agent 并发默认 1，撞限时任务会失败，等窗口重置后重试
