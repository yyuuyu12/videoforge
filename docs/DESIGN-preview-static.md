# 设计文档：预览静态化（去 per-job dev server）

状态：**已实施，过渡观察期**（2026-07-14）。产品预览默认已切至静态托管；`previewMode: "dev"` 保留为两周回退开关。

---

## 1. 背景与问题

当前每个作品的预览和渲染都依赖一个**独立的 Vite dev server**（`server/src/devServers.js`）：

```
作品预览请求 → devServers.startDevServer(jobId)
             → spawn `npm run dev --port 53XX --strictPort`（每作品一个端口，5300-5399）
             → 工作台 iframe / render.js 无头浏览器 指向 http://127.0.0.1:53XX
```

实测量化成本（2026-07-14，11 个作品）：

| 项 | 实测值 | 说明 |
|---|---|---|
| 每作品 node_modules | **83 MB** | react + vite + typescript，内容完全相同 |
| 11 作品合计浪费 | **~900 MB** | 且每新作品 scaffold 都要 npm install 一次（分钟级、依赖网络） |
| 常驻端口占用 | 每预览一个端口 | 5300-5399 段，服务重启后要"再领养" |
| dev server 进程 | 每作品一个 node 进程 | 内存 ~100MB/个，孤儿进程问题曾实际发生过 |
| `vite build` 一次 | **1.7s（含 npx 启动；vite 本体 478ms）** | job-14（10 章规模）实测 |

结构性问题：dev server 是**开发者工作流**，不是产品行为。它让"给别人用"不可行（体积、端口、进程管理、npm install 依赖网络），也让渲染器依赖 Vite 的按需编译（首屏抖动、需要 warm-up 等待）。

## 2. 目标架构

```
之前：
  工作台 iframe ──→ http://127.0.0.1:53XX  ←─ per-job Vite dev server（进程+端口+node_modules）
  render.js    ──→ 同上

之后：
  工作台 iframe ──→ http://127.0.0.1:5401/preview/13/   ←─ Express 静态托管（零新进程、零新端口）
  render.js    ──→ 同上
                     │
                     ├─ workspaces/job-13/presentation/dist/      ← vite build 产物（仅 JS/CSS/HTML，~200KB）
                     └─ workspaces/job-13/presentation/public/    ← 音频/数字人媒体直接回退托管（不复制）

  构建时机：懒构建 + 脏检查——请求预览/渲染时对比 src+public 指纹与 dist 标记，
           不一致才 rebuild（1.7s），一致直接served。
  依赖来源：workspaces/ 上层放一份共享 node_modules（Node 向上解析机制），
           scaffold 不再 per-job npm install。
```

## 3. 关键设计决策

### 3.1 共享依赖：hoisted node_modules（不用 junction）

在 `workspaces/` 放一份 `package.json`（依赖与 scaffold 模板完全一致、版本钉死）+ 一次 `npm install`。Node/Vite/TypeScript 的模块解析都是**向上逐级查找**的，`workspaces/job-N/presentation/` 里的代码自然解析到 `workspaces/node_modules/`。

- 新作品 scaffold：不再 npm install（省 1-3 分钟/作品 + 83MB/作品）。
- 旧作品：自带 node_modules 的继续用自己的（解析优先命中近层），零迁移成本。
- 不引入 junction/symlink（无断链风险，Windows 友好）。

### 3.2 dist 不复制媒体：`copyPublicDir: false` + 静态路由链

实测直接 build 会把 `public/` 的 156MB 音频/视频复制进 dist。方案：

- 模板 `vite.config.ts` 增加 `build: { copyPublicDir: false }`、`base: "./"`（实测通过）。
- Express 路由链：`/preview/:id/*` 先查 `presentation/dist/`，未命中回退 `presentation/public/`。
- 结果：dist 只有 JS/CSS/HTML（~200KB），媒体零复制、零冗余。

### 3.3 懒构建 + 脏检查（不在每次编辑后立刻构建）

`buildPresentation(job)`：对 `src/` + `public/`（仅结构与 mtime）算指纹，与 `dist/.build-fingerprint` 对比；不一致 → `npx vite build`（cwd=presentation），写回指纹。触发点：

- GET `/preview/:id/*` 首次命中（用户点"加载预览"）
- render 阶段开始前
- 章节验收门就位前（把 build 变成验收前置——**构建失败在人工验收之前暴露**，而不是导出时）

### 3.4 渲染器与录制入口切换

`render.js` 与工作台"播放整片"链接改指 `/preview/:id/?auto=1`。渲染器少一个依赖（不再 startDevServer），生产构建消除 dev 模式按需编译的首屏抖动（现有代码里的 1.5s warm-up 可以缩短）。

### 3.5 devServers.js 的去向

降级为**方法论开发工具**：调 skill 模板/手工调章节动画时仍可手动 `npm run dev`（保留 HMR 体验），但产品主路径（预览/渲染/验收）不再依赖它。过渡期保留"回退到 dev server"的开关，稳定两周后删除自动路径。

## 4. 实施结果（2026-07-14）

已完成模板双真源同步、共享依赖、`server/src/preview.js` 指纹构建、`/preview/:id/` 静态路由、工作台/渲染器/封面截图切换，并以 Job #5 与 Job #14 验证。下表保留为交付清单；第 6 项处于两周观察期。

| # | 步骤 | 验收标准 |
|---|---|---|
| 0 | 模板改造：`base:"./"` + `copyPublicDir:false`（skills 源码库 + vendored 快照同步） | 新 scaffold 的作品可直接 build |
| 1 | `workspaces/package.json` + 共享 install；scaffold 移除 per-job npm install | 新作品零 install 可 build |
| 2 | `server/src/preview.js`：buildPresentation + 指纹脏检查 | 重复请求不重复构建；改动后自动重建 |
| 3 | routes：`/preview/:id/*` 静态链（dist → public 回退，SPA fallback 到 index.html） | 浏览器直开可播、音频/头像可加载 |
| 4 | Workbench previewUrl / 播放链接 / render.js 切换到 `/preview/:id/` | 工作台预览、录制链接、服务端渲染三处全通 |
| 5 | 回归：老作品（job-5）+ 新作品各渲染一支成片对比 | 音画与 dev-server 版一致 |
| 6 | 观察两周 → 删 devServers 自动路径，端口段 5300-5399 归还 | check-services 更新 |

## 5. 优势

1. **给别人用成为可能**：新作品不再需要 npm install（无网络依赖、无分钟级等待），磁盘从 83MB/作品 → ~200KB/作品，无端口占用、无进程管理。
2. **渲染更稳**：生产构建产物是确定的，消除 dev 模式按需编译带来的首帧抖动与 warm-up。
3. **提前抓错**：build 成为章节验收的前置检查，agent 产出的构建级错误（动态 import 路径、大小写、rollup 约束）在人工验收前暴露，而不是导出时。
4. **服务重启零波及**：静态文件天然无状态，不再有"dev server 领养"逻辑和孤儿进程风险（此前实际踩过）。
5. **回收 ~900MB 磁盘**（现存 11 作品）+ 每作品持续节省。

## 6. 弊端（如实）与缓解

| 弊端 | 影响程度 | 缓解 |
|---|---|---|
| **失去 HMR 即时热更**：手工调章节动画/样式时没有秒级反馈 | 中——只影响方法论开发场景，不影响产品用户 | devServers 保留为手动开发工具（`npm run dev` 照常可用） |
| **构建延迟进入交互路径**：每次改动后首个预览请求多 ~1.7s | 低——实测 1.7s，且脏检查保证只在真变更后构建 | 章节 agent 完成时预构建（用户点开时已就绪） |
| **构建失败成为新故障面**：dev 能跑的代码 build 未必过 | 低-中——本质是把问题提前暴露，但增加一处失败处理 | build 失败写 job_events + 界面明确提示；agent 契约已含 tsc 检查，覆盖大部分 |
| **共享依赖版本耦合**：所有新作品绑定同一运行时版本 | 低——模板依赖本就钉版本；升级运行时只影响"重建旧作品"场景 | 版本升级视为迁移事件走 PROJECT-MEMORY 记录；旧作品优先用自带 node_modules |
| **子路径部署的资产路径**：`base:"./"` 依赖相对路径约定 | 低——实测通过；演示是单屏应用无路由 | 回归清单加"直开 /preview/:id/ 深链" |
| **磁盘上多一份 dist** | 忽略——~200KB/作品（媒体不复制） | — |

## 7. 不做什么（Non-goals）

- **不做运行时播放器重构**（把章节做成数据、由统一 player 壳加载）：那是更彻底的"零构建"方案，但推翻现有"章节即 React 组件"的方法论（动画自由度来源），代价与收益不成比例。本方案保留方法论不变。
- 不改变 workspace 文件真相源、不动流水线阶段语义（build 是阶段内步骤，不是新阶段）。

## 8. 回滚方案

`/preview/:id/*` 路由与 devServers 并存开关（config.previewMode: "static" | "dev"）。任何环节出问题切回 "dev" 即恢复原行为；模板的 `base:"./"` 与 `copyPublicDir` 对 dev 模式无影响。
