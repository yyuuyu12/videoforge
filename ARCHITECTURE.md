# VideoForge 结构总纲（v2 · 权威结构文档）

> **这是本项目唯一的结构权威文档**。三文档分工：`PRODUCT-PLAN.md` 商业方向｜`PRODUCT-SPEC.md` 产品页面规格（做 UI 读它）｜**本文档：系统结构、技术决策、实施路径（改架构先改这里）**。
> 最后更新：2026-07-12（v2.1：云控制面易主——backend 已从 Zeabur 迁至自有阿里云上海机 106.14.151.37，pm2 :3001 + 本机 MariaDB，nginx 直反代，见 F:\Projects\MACHINE-INDEX.md 云端拓扑节。**本文档所有 "Zeabur 控制面/云控制面" 字样今后均指这台自有服务器**——契约、路由、/api/relay 规划全部不变，只是部署位置换了，且不再受 Zeabur 付费墙/BYOC 网络限制）
> 上一版：2026-07-07（v2：按五大需求重组为"三面架构"）

本文档围绕五个硬需求组织（§二逐条对应怎么满足）：
① 换任何模型都能达到同等效果 ② 每个环节可中途调整/预览 ③ 界面美观简洁、多任务并行 ④ 别的电脑也能跑、调用"我"电脑上的模型 ⑤ 后端控制走已有的 Zeabur 服务

---

## 一、三面架构总图

```
┌─────────────── 执行面（每台用户电脑，轻量：Node + 浏览器）───────────────┐
│  VideoForge 本体                                                        │
│   dashboard(:5400)  工作台/新建向导/素材库/设置（PRODUCT-SPEC 定义）        │
│   server(:5401)     流水线引擎 · Provider Adapter · workspace 文件真相源   │
│   产物全在本地：workspaces/job-N/{article,script,outline,presentation/…}  │
└──────────┬──────────────────────────┬──────────────────────────────────┘
           │ 用户自己的 LLM key         │ 登录 token（一次登录，全部远程能力）
           ▼                          ▼
   LLM 供应商                ┌─── 云控制面（Zeabur · 已存在 · 复用）────────┐
   Anthropic/OpenAI兼容/     │  https://www.yyagent.top（Copywriter 后端）  │
   本机 claude 订阅          │   /api/auth/*        账号·登录·每日额度       │
                            │   /api/extract       抖音提取(TikHub key 在云端)│
                            │   /api/douyinToText  等既有能力               │
                            │   [新增] /api/relay/* 算力中继·服务注册·token   │
                            └───────────┬─────────────────────────────────┘
                                        │ frp 隧道（已在跑）
                            ┌─── 算力面（你的 Windows GPU 机）──────────────┐
                            │  HeyGem 对口型 :7861   → heygem.yyagent.top   │
                            │  Whisper ASR          → asr.yyagent.top      │
                            │  （形象库 avatar_key/user_id 隔离已内置）        │
                            └──────────────────────────────────────────────┘
   MiniMax（云 TTS/克隆）：执行面直连，key 用户自备或（后续）云端代付
```

**一句话**：视频的文件与预览永远在用户本地（执行面）；账号、额度、抖音提取、算力入口走你已有的 Zeabur（控制面）；重 GPU 活只发生在你的机器上（算力面）。三面之间只有两种通信：LLM API 调用、带 token 的 HTTPS 任务提交/轮询。

## 二、五大需求 → 结构上如何满足

**① 换模型等效**
- 一切 LLM 调用收口到 `server/src/providers.js` 三后端：`subscription`(claude -p)｜`anthropic-api`(Agent SDK)｜`openai-compatible`(DeepSeek/Kimi/GLM…)。
- **方法论随仓库走，不依赖 Claude 生态**：把三个 skill（article2video/web-video-presentation/video-avatar-subtitles）快照进 `videoforge/skills/`，stages 的 prompt 引用仓库内路径。任何模型拿到的是同一套规范文本；个人参数（语速 1.12/emotion angry/头像 360×640/10s 分段…）在 `skills/article2video/references/DEFAULTS.md`，是产品各环节的默认值来源。
- 能确定性的绝不交给模型（已做到）：TTS、字幕 cues、乒乓切片、交叉相关 offset 全是脚本；模型只负责"写稿"和"写章节代码"两类生成任务 + 自检循环。这是"换模型效果稳定"的真正保障。
- 每个 job 记录 provider/model（jobs.meta），产物可追溯。
- 现实差距：重 agent 阶段（chapter_gen）目前仅 subscription 实现——API 双后端是 P0 缺口（§八）。

**② 每环节可调整/预览**
- 流水线从"单向直线"升级为**阶段图 + 调整矩阵**（§五）：每个已完成阶段在详情页有「调整」入口，改动按矩阵只作废受影响的下游，不全推倒。
- 预览随时可开（devServers 按 job 分端口），验收门自带聊天式反馈改章节。

**③ 美观简洁 + 多任务**
- 页面规格全在 `PRODUCT-SPEC.md`（工作台卡片流/五步向导/人话状态映射/素材库）。
- 并发模型：job 级并行由 pipeline worker 调度；瓶颈是 agent 并发——subscription 模式全局 1（订阅限速），API 模式按 key 并发 N（config.agent.maxConcurrent 按 provider 分档）。deterministic 阶段（音频/字幕/切片）天然可多 job 并行。

**④ 别的电脑跑 + 用你的算力**
- 执行面零重依赖：Node 22+ 即可（无 GPU、无 Python 硬需求——avatar 对齐脚本的 numpy 部分改由算力面/或打包 pyodide 兜底，见 §八缺口）。
- 远程算力 = 登录 yyagent.top 后自动获得：HeyGem/ASR 的中继地址 + token，settings 里不再手填 IP。本机有 GPU 的高级用户仍可直填 127.0.0.1:7861（现有能力保留）。

**⑤ 后端控制走 Zeabur**
- 复用既有：账号/登录/每日额度（Copywriter 的 users/usage_logs 直接是现成的计费雏形）、/api/extract（抖音提取云端版，TikHub key 存云端 system_config——**普通用户无需自备 TikHub key**，本地 douyin.js 降级为自备 key 模式）。
- 需在 Zeabur 侧新增（薄薄一层，§七给出完整契约）：算力服务注册表 + 中继鉴权 + （可选）HeyGem 任务排队。
- 阿里云定位调整：不再作为控制面（Zeabur 已有），保留为可选的大文件 OSS / 未来 GPU 扩容位。

## 三、仓库目标结构

```
videoforge/
├─ ARCHITECTURE.md / PRODUCT-SPEC.md / PRODUCT-PLAN.md
├─ config.example.json          # 非密钥配置（可分享）
├─ settings.local.json          # 密钥（gitignore，GET 打码）
├─ skills/                      # ★新增：方法论快照（模型无关的规范文本）
│   ├─ article2video/           #   总控+个人 DEFAULTS（各环节默认值的唯一来源）
│   ├─ web-video-presentation/  #   文章→网页演示方法论+主题库
│   └─ video-avatar-subtitles/  #   字幕/头像管线方法论+确定性脚本
├─ server/src/
│   ├─ index.js routes.js db.js config.js settings.js
│   ├─ providers.js             # LLM 三后端适配（含 agent loop，P0 补 API 双后端）
│   ├─ cloud.js                 # ★新增：Zeabur 控制面客户端（登录/额度/extract/中继发现）
│   ├─ minimax.js heygem.js douyin.js search.js
│   ├─ stages/                  # ★由单文件 stages.js 拆目录：一阶段一文件 + graph.js(阶段图+调整矩阵)
│   └─ workers/ devServers.js agentRunner.js
├─ dashboard/src/
│   ├─ pages/ {Works,New,WorkDetail,Assets,Settings,Onboarding}.tsx   # PRODUCT-SPEC 的六页面
│   └─ lib/statusText.ts        # 人话状态映射（全站唯一来源）
└─ workspaces/                  # 产物真相源（job-N/ + _assets/{voices,avatars}/）
```

## 四、数据与产物

- **SQLite（data.db）**：articles/jobs/job_events/feedback + jobs.meta 记 provider/model/参数快照。只存状态，不存产物。
- **workspace 文件系统**：每 job 的全部产物，阶段幂等可重跑；`_assets/` 存跨 job 素材（克隆音色元数据、形象视频）。
- **密钥三层**（不变的红线）：config.json 可分享 ≠ settings.local.json 密钥本地 ≠ 环境变量兜底；密钥不进库、不进日志、GET 打码。
- 云端（Zeabur/Postgres）只存：账号、额度、服务注册、（可选）job 元数据镜像用于跨设备看进度——**产物永不上云**（除非用户主动导出到 OSS）。

## 五、阶段图与调整矩阵（需求②的核心设计）

```
选题 → 写稿(script_outline) → [确认稿件] → 搭框架(scaffold) → 章节(chapter_gen)
     → [验收+对话修改] → 配音(audio_synth) → 字幕(subtitle_cues) → 头像(avatar_gen,P0待接) → 导出
```

用户可在详情页对任何**已完成**阶段点「调整」，按此矩阵最小化重跑（API：`POST /jobs/:id/rerun {fromStage, params}`，params 覆盖 jobs.meta 里的对应项）：

| 用户想改 | 从哪重跑 | 保留 | 作废（自动级联） |
|---|---|---|---|
| 换稿子写法/改文案 | script_outline（或行内编辑 script.md 后从 scaffold） | 选题 | 其后全部 |
| 换视觉主题/风格 | scaffold（--theme 换参） | 稿子 | 章节/音频/字幕/头像 |
| 改某一章画面 | 反馈对话（scoped agent，不算重跑） | 其余章 | 无（改后仅需刷新预览） |
| 换语速/情绪/音色 | audio_synth | 稿子+章节 | 字幕/头像（音频时长变了） |
| 换头像形象/不要头像 | avatar_gen | 音频及之前全部 | 仅头像轨 |
| 只重录某几句 | audio_synth 增量（脚本本身支持 skip-if-exists，删除对应 mp3 即可） | 其余音频 | 字幕/头像需重算 |

实现要点：rerun 把 job.stage 拨回目标阶段并清掉下游产物标记；级联规则写死在 `stages/graph.js`（就是 ai-market-video 项目实测踩出来的"改音频→字幕/切片/offset 全重跑"经验的产品化）。

## 六、代码地图（现状，含缺口标注）

| 模块 | 状态 | 说明 |
|---|---|---|
| server routes/db/config/settings | ✅ | 端点清单见文末附录 |
| providers.js | ⚠️ 半成 | complete()+测试连接✅；**重 agent 的 anthropic-api/openai 后端未实现（P0）** |
| stages.js | ⚠️ 待拆 | 线性可用✅；拆 stages/ 目录+graph.js 调整矩阵（P0.5）；**avatar_gen 阶段未接（P0）** |
| agentRunner.js | ✅ | 含 ensureWorkspaceTrusted（不做这个 headless 权限静默失效，实测踩坑） |
| cloud.js | ❌ 未建 | Zeabur 客户端（P0.5，等 §七契约确认） |
| search.js / douyin.js | ✅ | 搜索实测通过（JSONL 逐行容错解析——整体 JSON.parse 会被未转义引号打挂，别改回去）；抖音本地 key 模式✅，云端 extract 模式待 cloud.js |
| minimax.js / heygem.js | ✅ | 克隆防重复；heygem 客户端就绪等 avatar_gen 用 |
| dashboard 六页面 | ⚠️ | 现为开发控制台三页；按 PRODUCT-SPEC Phase A 改版（P0，纯前端） |

## 七、Zeabur 控制面契约（需你确认/提供 ⬅）

**已确认存在**（来自 XiaMuDesktop/Copywriter 源码）：`https://www.yyagent.top`，Node+Express+Postgres（zbpack 部署），路由含 /api/auth/*、/api/extract、/api/douyinToText、/api/rewrite、/api/history、/api/config；TikHub key 与 asr_url 存云端 system_config；frp：heygem.yyagent.top、asr.yyagent.top。

**videoforge 要用的最小面（新增一组 /api/relay/）**：
```
POST /api/relay/login            # 复用现有 auth，换发 videoforge 长效 token
GET  /api/relay/services         # 返回当前可用算力：[{kind:"heygem"|"asr", baseUrl, healthy}]
POST /api/relay/heygem/generate  # 透传到 heygem.yyagent.top，带排队与额度扣减
GET  /api/relay/heygem/task/:id  # 轮询透传
GET  /api/relay/heygem/file/:id  # 结果下载透传（或直给 frp 直链+一次性签名）
```
排队与额度直接用 users.daily_limit/usage_logs 的现成模式。HeyGem 侧无需改代码（XiaMuDesktop 已验证纯透传可行）。

**⬅ 需要你提供的**（给了就能把 cloud.js + relay 做完）：
1. Zeabur 上那个服务的**代码仓库位置**（是不是就是 F:/Projects/Copywriter？部署分支/方式），我直接在里面加 /api/relay/
2. 一个**测试账号**（或告诉我注册开着没）；管理员在 system_config 里改配置的现行方式
3. frp 隧道清单与常在线情况（heygem/asr 之外还有吗？tts？）
4. 决策：普通用户抖音提取**共用你云端 TikHub key**（走 /api/extract，计入他的每日额度）还是各自填 key？——我默认按"共用+计额度"设计
5. 阿里云的角色确认：按本文档降级为"可选 OSS/扩容位"是否 OK

## 八、实施顺序（唯一待办清单，做完勾掉）

**P0（跑通"别人电脑上的完整体验"）**
1. [ ] providers.js 补重 agent 双后端：anthropic-api（Claude Agent SDK headless）+ openai-compatible（通用 tool-loop：读写文件/跑命令三工具），chapter_gen/script_outline 全量走 Provider
2. [ ] avatar_gen 阶段接入（素材库形象 → 乒乓 → HeyGem(本地或 relay) → 交叉相关 → 接线 AvatarPanel）；对齐脚本的 numpy 依赖改为：算力面出一个 /align 接口（或执行面检测无 Python 时走云端）
3. [ ] skills/ 快照进仓库 + stages prompt 改引用仓库路径（模型无关化的落地步）
4. [ ] Dashboard Phase A 改版（PRODUCT-SPEC：statusText.ts → Works → WorkDetail → New 向导 → Onboarding）

**P0.5（结构升级）**
5. [ ] stages.js → stages/ 目录 + graph.js 调整矩阵 + POST /jobs/:id/rerun
6. [ ] cloud.js + Zeabur /api/relay/（等 §七材料）
7. [ ] 素材库页 + 形象/音色管理（PRODUCT-SPEC P1-5）

**P1**
8. [ ] 多 job 并发调度完善 + 用量/费用透出（token usage 落 job_events）
9. [ ] 主题画廊缩略图批量渲染
10. [ ] 端到端验收：一台从未装过环境的电脑，仅装 Node → 登录 → 出一支带头像的片

**P2**：Playwright+ffmpeg 一键导出 mp4；Electron 壳/整合包分发（有先例）；多租户 GPU 队列公平调度。

---
### 附录 · API 端点现状
```
GET  /api/health /api/meta
POST /api/discovery/search        GET/POST/DELETE /api/sources  POST /api/discovery/run
GET  /api/articles                POST /api/articles/manual|douyin  POST /api/articles/:id/select|dismiss
GET  /api/jobs /api/jobs/:id      POST /api/jobs/:id/approve|retry|feedback  POST /api/jobs/:id/devserver/start|stop
GET/PUT /api/settings             POST /api/settings/test-llm|test-minimax
POST /api/voice/preview|clone     GET /api/heygem/health
[待建] POST /api/jobs/:id/rerun   [待建] cloud.js ↔ /api/relay/*
```
### 附录 · 本地开发
`npm install` → `npm run server`(:5401) + `npm run dashboard`(:5400)；生产 `npm run build && npm start`。
