# VideoForge PPT 质量与音画同步长测（2026-07-16）

## 结论

- 作品 #15 更换风格后已从 0/8 重新生成，生成服务为 `openai-compatible/gpt-5.6-sol`。
- 新质量审计会遍历全部章节和全部 step，保存每屏 1920x1080 截图，最终分数取最低分；低于 90 分不得进入画面验收。
- #15 共 30 屏，初次审计因短标题被挤成三行得 80 分；多模态修复后 30 屏最低分 100，人工抽查第 2、4、8 章未见正文重叠或字幕遮挡。
- 配音共 30 段，音频文件 30 个、逐字时间文件 30 个；字幕共 30 个 step、104 个 cue，最大 10 字，超限 0，时间戳严格递增。
- 数字人阶段发现并修复严重同步错误：旧代码按目录字母顺序合并音频，导致 `accumulate` 先于 `hook`，全片口型和章节切片错位。现在严格按 `audio-segments.json` 顺序合并与切分，并有回归测试。

## 真实测试结果

| 作品 | 结果 | 全屏数 | 最低分/问题 |
|---|---|---:|---|
| #1 | 失败 | - | 旧工程示例章节缺失，类型检查失败 |
| #4 | 不通过 | 25 | 0 |
| #5 | 不通过 | 19 | 18 |
| #7 | 不通过 | 21 | 28 |
| #11 | 不通过 | 10 | 0 |
| #12 | 失败 | - | 旧工程缺少 Vite `ImportMeta.env` 类型 |
| #13 | 不通过 | 18 | 3 |
| #14 | 不通过 | 20 | 39，字幕 17 字且压住底部正文 |
| #15 | 通过 | 30 | 80 -> 自动修复 -> 100 |
| #18 | 通过 | 16 | 新建第 10 个长测项目，首次自动验收 100 |

当前已覆盖 10 个真实作品：9 个历史作品回归或失败基线，加 1 个新建项目 #18。#18 使用强信号、超大字、留白多、字幕开启且不使用数字人，4 章 16 屏首次自动验收 100；人工抽查首屏、中段和结尾未见拥挤或字幕遮挡。

## 质量门槛

- 非设计性文字重叠、正文越界、字幕越界直接扣分。
- 字幕单次一行，中文目标 8 字、硬上限 10 字。
- 单块正文超过 28 字扣分；标题超过两行扣分，禁止缩小字号硬塞。
- 章节生成结束后自动审计；失败时把最低分截图交给 `gpt-5.6-sol` 修复，最多 3 轮，每轮重新构建和重新审计。
- 审计产物：`workspaces/job-N/presentation/public/quality-audit.json` 与 `quality-audit/*.png`。

## 音画同步契约

```text
chapters.ts 顺序
  -> narrations.ts step 顺序
  -> audio-segments.json 顺序
  -> public/audio/<chapter>/<step>.mp3
  -> subtitleCues.ts 同 chapter/step
  -> avatar/audio-list.txt 同一顺序
  -> lipsync.mp4 累计时间轴
  -> avatar/chapters/<chapter>.mp4
```

任何一层都不得自行按目录名排序。step 结构变化必须重做配音、字幕和数字人口型，不能复用旧下游文件。

## 项目结构

```text
F:\Projects\videoforge
|-- AGENTS.md / CLAUDE.md          项目入口与执行约束
|-- ARCHITECTURE.md                当前架构
|-- PRODUCT-SPEC.md                UI 与交互规范
|-- PRODUCT-PLAN.md                后续路线图
|-- PROJECT-MEMORY.md              长期工程事实
|-- OPERATIONS.md                  启动、服务、打包、排障
|-- dashboard/src/
|   |-- pages/Workbench.tsx        七阶段工作台
|   |-- pages/NewWork.tsx          内容入口
|   |-- pages/Settings.tsx         服务配置
|   |-- api.ts                     前端 API 契约
|   `-- *.css                      工作台与进度样式
|-- server/
|   |-- src/
|   |   |-- routes.js              API 与本地文件服务
|   |   |-- stages.js              生成阶段、质量修复、音画顺序
|   |   |-- workers/pipeline.js    调度、重试、自动质量门
|   |   |-- render.js              全屏质量审计与服务端成片
|   |   |-- preview.js             静态预览构建与指纹
|   |   |-- agentRunner.js         三路径生成引擎
|   |   |-- douyin.js              抖音提取与 ASR
|   |   |-- settings.js            本地设置与默认模型
|   |   `-- *.test.js              后端回归测试
|   `-- templates/                 音频与字幕确定性脚本
|-- skills/
|   |-- web-video-presentation/    PPT 方法论快照
|   `-- video-avatar-subtitles/    字幕/数字人方法论快照
|-- scripts/                       便携包与冒烟脚本
|-- docs/reports/                  测试与审计报告
|-- workspaces/                    本机作品与媒体，不进 Git
|-- data.db                        SQLite 运行状态，不进 Git
|-- settings.local.json            本机密钥，不进 Git
|-- logs/                          后台服务日志，不进 Git
`-- output/                        便携包与导出产物，不进 Git
```

方法论源库位于 `F:\Projects\claude-skills`，产品运行快照位于本仓库 `skills/`；方法论修改必须两边同步。

## 验证

- `npm test`：17/17 通过。
- `npm run build`：通过。
- `node --check server/src/render.js`：通过。
- `node --check server/src/stages.js`：通过。
- `node --check server/src/workers/pipeline.js`：通过。
- #15 字幕：30 step、104 cue、最大 10 字、0 超限、时间戳递增。

## 最终成片验证

- #15 第二次 HeyGem 使用正确音频顺序完成；章节切片起点从 `hook 0.000s` 到 `review 136.121s`，顺序与 PPT 一致。
- 8 个章节视频与对应音频时长差均在 0.2 秒内，属于视频帧边界取整；接口和界面列表均按 manifest 章节顺序返回。
- 数字人接线后再次审计 30 屏，最低分 100。
- 服务端最终成片：169 秒、3615 帧、30/30 段配音；H.264 1920x1080 视频 + AAC 32kHz 音频，`render-meta.json` 记录 `segmentsPlaced=30`、`segmentsExpected=30`。

## 后续长测

- 当前 10 个项目中，历史项目的低分和类型错误被保留为回归基线，不代表它们已全部修复。
- 下一轮应继续用新建项目验证其他主题、无字幕模式和不同数字人占位；每次仍以全部 step 的最低分为准。
