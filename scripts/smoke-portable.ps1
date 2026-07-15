# VideoForge 便携包冒烟测试（发版前跑一次，~30 秒）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\smoke-portable.ps1 [-PkgDir <包目录>]
# 做什么：临时数据目录冷启动包内程序 → 验证 health / 阶段数 / 依赖自动复制 → 清理退出。
# 不装任何东西、不碰正式数据（%APPDATA%\VideoForge）、测完自动恢复主服务。
param(
  [string]$PkgDir = "$PSScriptRoot\..\output\VideoForge-portable"
)
$ErrorActionPreference = "Stop"
$PkgDir = [System.IO.Path]::GetFullPath($PkgDir)
if (-not (Test-Path "$PkgDir\node.exe")) { throw "包不存在或不完整：$PkgDir（先跑 package-portable.ps1）" }

# 主服务占着 5401 时先停（测完自动恢复）
$main = Get-NetTCPConnection -LocalPort 5401 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$mainWasRunning = $false
if ($main) { $mainWasRunning = $true; Stop-Process -Id $main.OwningProcess -Force -Confirm:$false; Start-Sleep 1 }

$testData = Join-Path $env:TEMP ("videoforge-smoke-" + (Get-Date -Format "HHmmss"))
$env:VIDEOFORGE_DATA_DIR = $testData
$p = Start-Process -FilePath "$PkgDir\node.exe" -ArgumentList "server\src\index.js" -WorkingDirectory $PkgDir -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 12
$pass = $true
try {
  $h = Invoke-RestMethod http://127.0.0.1:5401/api/health -TimeoutSec 5
  if (-not $h.ok) { $pass = $false }
  $stages = (Invoke-RestMethod http://127.0.0.1:5401/api/meta).stages.Count
  $deps = Test-Path "$testData\workspaces\node_modules\vite"
  Write-Host "health=$($h.ok) 阶段=$stages 依赖复制=$deps"
  if ($stages -lt 17 -or -not $deps) { $pass = $false }
} catch { $pass = $false; Write-Host "请求失败：$($_.Exception.Message)" }
Stop-Process -Id $p.Id -Force -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item Env:\VIDEOFORGE_DATA_DIR -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $testData -ErrorAction SilentlyContinue
if ($mainWasRunning) {
  Start-Process -FilePath "node" -ArgumentList "server/src/index.js" -WorkingDirectory "$PSScriptRoot\.." -WindowStyle Hidden -RedirectStandardOutput "$PSScriptRoot\..\logs\server-out.log" -RedirectStandardError "$PSScriptRoot\..\logs\server-err.log"
  Start-Sleep 2
}
if ($pass) { Write-Host "== 冒烟通过 ✅" } else { Write-Host "== 冒烟失败 ❌"; exit 1 }
