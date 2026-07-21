# VideoForge 服务启动与使用

## 1. VideoForge

生产方式：

```powershell
cd F:\Projects\videoforge
npm install
npm run build
npm start
```

推荐的手动稳定启动方式（不会注册开机自启）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-videoforge.ps1
```

脚本会检查 5401 端口、必要时构建 Dashboard、后台启动服务并等待 `/api/health` 通过；日志写入 `logs/videoforge-server.out.log` 和 `logs/videoforge-server.err.log`。停止服务：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-videoforge.ps1
```

地址：`http://localhost:5401`。生产构建由 Express 直接提供，不需要另开 Dashboard 端口。

服务端一键成片（导出环节）额外依赖：本机安装 Chrome 或 Edge（渲染器经 playwright-core 调用系统浏览器，无需下载浏览器内核）。源码开发环境要求 ffmpeg/ffprobe 在 PATH；便携包已内置两者。渲染临时帧写在 `workspaces/job-N/render-tmp/`（成功后自动清理，失败保留现场），成片在 `workspaces/job-N/output.mp4`。

开发方式：

```powershell
npm run server
npm run dashboard
```

API `5401`，Dashboard `5400`。作品预览由后台动态分配 `5300-5399`。

## 1.5 数据目录（dataRoot）

数据（`data.db`、`settings.local.json`、`workspaces/`、`logs/`）与代码分离，解析优先级：

1. 环境变量 `VIDEOFORGE_DATA_DIR`
2. `config.json` 的 `dataRoot`
3. 旧布局兼容：仓库根已有 `data.db` 则继续就地使用（本机开发零迁移）
4. 默认 `%APPDATA%\VideoForge`（打包分发形态，安装目录只读可运行）

首次使用新数据目录会自动建结构、铺共享演示依赖清单并接走旧密钥/数据库（复制不移动，旧目录可回退）。共享依赖需一次性 `npm install --prefix <dataRoot>/workspaces`（启动日志会提示）。

## 2. Whisper ASR

用于抖音无字幕长视频。当前启动脚本：

```powershell
powershell -ExecutionPolicy Bypass -File F:\Projects\XiaMuagent\local_asr_server\start_asr_logged.ps1
```

地址：`http://127.0.0.1:8765`，健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
```

首次加载 Whisper medium 需要约 1-2 分钟。9 分钟视频识别可能需要数分钟；不要把前端或反向代理超时设为 90 秒。

## 3. HeyGem

用于数字人口型。当前 Python 与服务脚本：

```powershell
$env:HEYGEM_DIR='F:\other\ZHhinengti\aigc-human\python-modules\hdModule'
& 'F:\other\ZHhinengti\aigc-human\python-modules\hdModule\venv\python.exe' `
  'F:\Projects\XiaMuagent\desktop_client\heygem_server_v2.py'
```

地址：`http://127.0.0.1:7861`。健康检查应返回 `processor_ready: true`。

## 4. 外部服务

- LLM：设置页选择本机 Claude 订阅或 OpenAI 兼容网关。
- TikHub：解析抖音视频信息和原声地址，使用 Bearer token。
- MiniMax：配音、逐字时间戳和声音克隆。

外部服务密钥只在设置页填写，不写入文档或仓库。

## 5. 使用顺序

1. 启动 VideoForge，然后在**设置页顶部「模型服务」卡点「一键启动服务」**（HeyGem/ASR/frpc 全套，模型加载约 60-90 秒，状态灯变绿即可用）。不用时点「停止服务」释放显存内存。服务**不随开机自启**（2026-07-16 用户定稿；曾注册的 XiamuLocalServices 计划任务可双击 `F:\Projects\unregister-services-autostart.bat` 注销）。手动路径仍可用（§2/§3 的启动命令）。
2. 设置页测试 LLM、MiniMax 和 HeyGem。
3. 新建页选择内容来源。
4. 抖音提取可离开页面；从历史记录查看进度和完整文案。
5. 点击“用这份文案制作视频”。
6. 审阅口播稿，选择风格和数字人占位。
7. 验收逐页画面，必要时使用右侧对话微调。
8. 检查配音字幕、数字人章节预览与完整合成预览。

## 静态预览

作品预览地址固定为 `http://127.0.0.1:5401/preview/<作品ID>/`，不再为产品预览启动独立端口或 Node 进程。首次打开或画面变更后会自动构建；构建错误会显示在预览页并记录为 `preview_build` 事件。共享依赖由 `workspaces/package.json` 锁定，根目录 `npm install` 会自动安装到 `workspaces/node_modules/`。需要排障时，可在本地 `config.json` 设定 `"previewMode": "dev"` 回退旧 Vite 预览路径。

## 6. 常见故障

- `article text too thin`：提取内容不足 200 字；长视频应检查原声时长和 ASR 完整性。
- ASR 长时间不动：确认 `8765/health`，查看 `asr_runtime_err.log`，允许最长 10 分钟。
- HeyGem 未就绪：检查 `7861/health` 的 `processor_ready`。
- 预览空白：在工作台点击“加载预览”，检查对应 `5300+` 端口。
- 服务重启：作品和抖音提取任务会从 SQLite 恢复。

## 7. 便携包打包（分发用）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\package-portable.ps1
```

产出 `output/VideoForge-portable/`（当前 full-build ffmpeg 约 870MB）：Node、ffmpeg/ffprobe、服务端运行时依赖和共享演示依赖均随包（首启自动复制演示依赖到用户数据目录，零网络）。使用机器只需 Windows 10+ 和系统 Chrome/Edge，不要求安装 Node、npm 或 ffmpeg。数据落 `%APPDATA%\VideoForge`。

## 8. 日常迭代与验证规范

四层验证，按成本递增；打包只在发版时做，日常迭代不打包、无安装卸载概念（程序=目录，数据在 %APPDATA%\VideoForge 与包无关）。

| 层级 | 时机 | 动作 | 耗时 |
|---|---|---|---|
| L1 语法 | 每次改完代码 | `node --check <改动文件>` + `npm run build` | 秒级 |
| L2 开发（日常主力） | 改功能后 | 仓库直接跑：重启 `npm start`（或 `npm run server` 自动 watch），浏览器/`curl` 验证；开发机数据就地（旧布局兼容） | 分钟级 |
| L3 发版 | 发新版给别人前 | `scripts\package-portable.ps1` → `scripts\smoke-portable.ps1`（临时数据目录冷启动三项校验，零残留，自动恢复主服务） | ~3 分钟 |
| L4 真实验收 | 每周 | 完整出一支真片（同时是稳定性证据与最强回归） | 小时级 |

多设备协同：GitHub master 为同步总线——任一设备 pull → 改 → L1/L2 → commit+push（改完即推）；接手前先 pull 并读 PROJECT-MEMORY 最新日期段。发版：打包 → 冒烟 → 压缩发人；接收方解压双击，升级换目录不丢数据。

工程注意：仓库内 PowerShell 脚本必须带 UTF-8 BOM（PS 5.1 无 BOM 读中文注释会解析错乱）。
