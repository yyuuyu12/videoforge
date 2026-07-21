# 个人规范总表（已调教定稿，直接采用，不再询问）

每一项都标注了出处（在哪个项目、因为什么反馈定下来的），改动需用户主动提出。

## 1. 语音合成（MiniMax t2a_v2）

| 参数 | 定稿值 | 出处 |
|---|---|---|
| 供应商/接口 | MiniMax REST `POST https://api.minimaxi.com/v1/t2a_v2`（mmx-cli 已废弃：登录过期且不收 REST key） | harnessH5video |
| model | `speech-2.8-hd` | harnessH5video |
| voice_id | `GongheJiucun02`（永久克隆音色，**严禁重新克隆**） | harnessH5video，用户定稿 |
| speed | **1.12**（同时起到压缩气口的作用） | ai-market-video，5 版 A/B 试听后用户选定 |
| emotion | **`angry`**（对克隆音色也生效，已实测；按内容基调可换——呼吁/批判类用 angry，中性讲解可 A/B 后再定） | ai-market-video，用户选定 |
| pitch / vol | 0 / 1.0（降 pitch 被否决过："变老头"） | harnessH5video |
| 字幕时间戳 | 请求体加 `subtitle_enable: true, subtitle_type: "word"`；返回的 `subtitle_file` 链接 24h 有效，逐条下载存 `<n>.words.json` | 两项目通用 |
| 限流 | 串行 + 每请求间隔 1.5s（无间隔连打 45 条会撞 RPM 1002） | harnessH5video 实测 |
| 密钥 | 环境变量 `MINIMAX_API_KEY`（用户已 setx 持久化）；缺失时按 credential-handling-protocol 处理 | —— |
| A/B 试听流程 | 改语速/情绪前：用 1 句真实文案合成 3-5 个候选 → data-URI 塞 `<audio>` 做成 Artifact 对比页 → 用户选定 → 才全量重合成 | ai-market-video |

响应里音频是 HEX：`bytes.fromhex()` / `Buffer.from(hex,"hex")` 解出 mp3。

## 2. 字幕

| 项 | 定稿值 | 出处 |
|---|---|---|
| 样式 | **纯黑字（#000），无底框、无背景、无圆角、无入场动画**；白字+黑底条、渐变 scrim 都被两轮否决（"不要模板"） | ai-market-video |
| 字色安全性 | 纯黑只在浅色主题安全；深色主题（如 midnight-press）要反过来用浅色字 | 推论，开工时按主题定 |
| 位置 | 底部**相对整个画面居中**，`left: 60px; right: 60px`，`bottom: 58px`——不为头像窗偏移（旧值 right:460px 造成整体偏左，2026-07-16 用户否决） | VideoForge 定稿 2026-07-16 |
| 粒度 | 一次一行，正文目标 8 字/硬上限 10 字（纯拉丁词/短语豁免），逐字时间戳驱动 | VideoForge 定稿 2026-07-16 |
| 断句 | **气口必断**：。！？…；：，遇到即切（顿号软断，≥8 字才切）；**词完整**：Intl.Segmenter 中文分词，cue 边界只落词边界（"高兴"绝不拆两页） | VideoForge 定稿 2026-07-16 |
| 尾标点 | cue 结尾的 。，、；：… 一律剥离不显示（分页展示后分隔标点无意义）；？！保留（承载语气，不占字数预算） | VideoForge 定稿 2026-07-16 |
| 同步机制 | rAF 轮询 `audio.currentTime`，不用 timeupdate；只依赖每段起始时间 | 两项目通用 |
| 分组算法 | 见 video-avatar-subtitles/scripts/gen-subtitle-cues.mjs（已含：MiniMax 按句分段+嵌套结构展开；连续重复拉丁词条去重；Intl.Segmenter 词级归组） | VideoForge 修正版 2026-07-16 |

## 3. 对口型头像

| 项 | 定稿值 | 出处 |
|---|---|---|
| 布局 | **右侧竖屏大窗口**：277×493（1920×1080 stage 坐标系）、圆角 28px、右锚定、垂直居中。不用右下角小圆窗 | 2026-07-17 用户拍板（252×448 基础上"再大 10%"），取代 ai-market-video 时期 360×640 旧值 |
| 正文避让 | `--stage-pad-x-end: 480px`（right-third 位；其余位 392px），由 avatar_wire 写入 `registry/avatarConfig.ts` 驱动 | 2026-07-17 拍板同批定稿 |
| 素材 | 竖屏出镜视频（1440×2560 已验证），乒乓母版用 **concat filter 重编码**（不能 demuxer 流拷贝 reverse 片段） | ai-market-video |
| 分段 | **~10s 一段**（上限 13s），step 粒度贪心打包，可跨章节；切片游标只进不退 + **跳避乒乓翻转点** | ai-market-video，用户指定 10s |
| offset | **交叉相关**（step 音频 vs 模型输出自带音频轨），置信度 <0.7 才退比例估算（每段末步会退化，正常） | ai-market-video |
| 运行时 | **音频时钟从动**：每帧 `video.currentTime = offset + audio.currentTime`（>80ms 才纠正），视频永不自播。禁止"每步 seek"（每句闪）和"free-run"（口型漂移） | ai-market-video，三轮踩坑定稿 |
| 模型服务 | 本地 HeyGem V2，原生 Windows，端口 7861（位置/启动见 `F:\Projects\MACHINE-INDEX.md` 服务表）；45 句/10 段全程约 5 分钟 | —— |

## 4. 视觉主题偏好

| 内容类型 | 主题 | 出处 |
|---|---|---|
| 技术/开发/AI 工具教程 | `midnight-press`（暖黑+热橙） | 用户跨两个项目重复选定："记住这个主题" |
| 新闻/政论/社会议题 | `newsroom`（报纸米白+墨黑+红 accent） | ai-market-video |
| 其他 | 从 23 主题里按基调荐 2-3 个 | —— |

## 5. 排版/移动端

- kicker ≥24px、label-mono ≥18px、badge-mono ≥19px（"超级加大"轮定的全局基线）
- 铁律：字看不清 = 重新排版（减元素、拉间距），不是 +2px 字号
- 每次改字幕/头像尺寸或大改章节排版后，必跑 overlap sweep（底部 vs 字幕、右缘 vs 头像窗，两个方向、全部 step）

## 6. 交付/录制

- 交付形态：`localhost:<端口>/?auto=1` → 按 Space 启动 → OS 录屏（Win+G/OBS）→ 掐头去尾
- Auto 推进规则：每段音频播完 +200ms 自动 next，无"等动画"兜底——动画超时长就改动画/拆 step
