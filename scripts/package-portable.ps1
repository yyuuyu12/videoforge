# VideoForge 便携包打包脚本（PRODUCT-PLAN §六 B6）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\package-portable.ps1 [-OutDir <目录>]
# 产出：解压即用的目录（node.exe 随包；数据自动落 %APPDATA%\VideoForge）。
# 使用机器需要：Windows 10+、系统 Chrome 或 Edge、ffmpeg/ffprobe 在 PATH（导出成片用）。
param(
  [string]$OutDir = "$PSScriptRoot\..\output\VideoForge-portable"
)
$ErrorActionPreference = "Stop"
$Root = Resolve-Path "$PSScriptRoot\.."
$OutDir = [System.IO.Path]::GetFullPath($OutDir)

Write-Host "== VideoForge 便携包 → $OutDir"
if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force $OutDir | Out-Null

# 1. 应用代码（只读部分）
Write-Host "[1/5] 复制应用代码"
Copy-Item "$Root\server" "$OutDir\server" -Recurse -Exclude "node_modules"
if (Test-Path "$OutDir\server\node_modules") { Remove-Item -Recurse -Force "$OutDir\server\node_modules" }
Copy-Item "$Root\dashboard\dist" "$OutDir\dashboard\dist" -Recurse
Copy-Item "$Root\skills" "$OutDir\skills" -Recurse
New-Item -ItemType Directory -Force "$OutDir\workspaces" | Out-Null
Copy-Item "$Root\workspaces\package.json" "$OutDir\workspaces\"
Copy-Item "$Root\workspaces\package-lock.json" "$OutDir\workspaces\"
Copy-Item "$Root\package.json" "$OutDir\"

# 2. 服务端运行时依赖（干净安装，剔除 dev 依赖）
Write-Host "[2/5] 安装服务端运行时依赖（npm --omit=dev）"
Push-Location "$OutDir\server"
npm install --omit=dev --no-audit --no-fund --loglevel=error | Out-Null
Pop-Location

# 3. 共享演示依赖（随包携带，用户侧零网络）
Write-Host "[3/5] 安装共享演示依赖"
Push-Location "$OutDir\workspaces"
npm install --no-audit --no-fund --loglevel=error | Out-Null
Pop-Location

# 4. Node 运行时
Write-Host "[4/5] 复制 Node 运行时"
Copy-Item (Get-Command node).Source "$OutDir\node.exe"

# 5. 启动脚本与说明
Write-Host "[5/5] 写入启动脚本"
@'
@echo off
cd /d %~dp0
where ffmpeg >nul 2>nul || echo [提示] 未检测到 ffmpeg —— 预览不受影响，但导出成片前请安装 ffmpeg 并加入 PATH
echo VideoForge 正在启动（首次启动会复制约 80MB 依赖到数据目录，请稍候）...
start "" http://127.0.0.1:5401
.\node.exe server\src\index.js
'@ | Out-File -Encoding ascii "$OutDir\启动VideoForge.bat"

@'
# VideoForge 便携版

## 使用
1. 双击「启动VideoForge.bat」，浏览器自动打开 http://127.0.0.1:5401
2. 首页按提示到「设置」页填两个 Key 并点测试：
   - 模型服务 API Key（OpenAI 兼容网关）
   - MiniMax API Key（配音；克隆自己的声音可在设置页向导完成，费用走你的 MiniMax 账号）
3. 「新建作品」贴一篇文章，跟着流水线走到导出即可下载 MP4。

## 环境要求
- Windows 10 及以上
- 系统已安装 Chrome 或 Edge（成片渲染用）
- ffmpeg / ffprobe 在 PATH（导出成片用；仅预览可不装）

## 数据位置
你的作品、密钥、数据库都存在 %APPDATA%\VideoForge，删除本目录不会丢数据。
'@ | Out-File -Encoding utf8 "$OutDir\README-便携版.md"

$size = "{0:N0} MB" -f ((Get-ChildItem $OutDir -Recurse | Measure-Object Length -Sum).Sum / 1MB)
Write-Host "== 完成：$OutDir（$size）"
