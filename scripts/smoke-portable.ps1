# VideoForge 便携包冒烟测试（发版前跑一次，~30 秒）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\smoke-portable.ps1 [-PkgDir <包目录>]
# 做什么：验证包内媒体工具 → 临时数据目录冷启动 → 验证 health / 阶段数 / 依赖自动复制 → 清理退出。
# 不装任何东西、不碰正式数据（%APPDATA%\VideoForge）、测完自动恢复主服务。
param(
  [string]$PkgDir = "$PSScriptRoot\..\output\VideoForge-portable"
)
$ErrorActionPreference = "Stop"
$PkgDir = [System.IO.Path]::GetFullPath($PkgDir)
$requiredFiles = @("node.exe", "ffmpeg.exe", "ffprobe.exe")
$missingFiles = $requiredFiles | Where-Object { -not (Test-Path (Join-Path $PkgDir $_)) }
if ($missingFiles) { throw "包不存在或不完整，缺少：$($missingFiles -join ', ')（先跑 package-portable.ps1）" }

# 主服务占着 5401 时先停（测完自动恢复）
$main = Get-NetTCPConnection -LocalPort 5401 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$mainWasRunning = $false
$mainNodePath = (Get-Command node).Source
if ($main) { $mainWasRunning = $true; Stop-Process -Id $main.OwningProcess -Force -Confirm:$false; Start-Sleep 1 }

$testData = Join-Path $env:TEMP ("videoforge-smoke-" + (Get-Date -Format "HHmmss"))
$originalPath = $env:PATH
$originalDataDir = $env:VIDEOFORGE_DATA_DIR
$env:PATH = "$PkgDir;$originalPath"
$env:VIDEOFORGE_DATA_DIR = $testData
$p = $null
$pass = $true
try {
  & "$PkgDir\ffmpeg.exe" -version *> $null
  if ($LASTEXITCODE -ne 0) { throw "包内 ffmpeg 无法执行" }
  & "$PkgDir\ffprobe.exe" -version *> $null
  if ($LASTEXITCODE -ne 0) { throw "包内 ffprobe 无法执行" }

  $p = Start-Process -FilePath "$PkgDir\node.exe" -ArgumentList "server\src\index.js" -WorkingDirectory $PkgDir -WindowStyle Hidden -PassThru
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $h = Invoke-RestMethod http://127.0.0.1:5401/api/health -TimeoutSec 2
      if ($h.ok) { $ready = $true; break }
    } catch {}
  }
  if (-not $ready) { throw "便携包服务未在 15 秒内启动" }

  $h = Invoke-RestMethod http://127.0.0.1:5401/api/health -TimeoutSec 5
  if (-not $h.ok) { $pass = $false }
  $stages = (Invoke-RestMethod http://127.0.0.1:5401/api/meta).stages.Count
  $deps = Test-Path "$testData\workspaces\node_modules\vite"
  Write-Host "health=$($h.ok) 阶段=$stages 依赖复制=$deps 包内媒体工具=True"
  if ($stages -lt 17 -or -not $deps) { $pass = $false }
} catch {
  $pass = $false
  Write-Host "冒烟失败：$($_.Exception.Message)"
} finally {
  if ($p) { Stop-Process -Id $p.Id -Force -Confirm:$false -ErrorAction SilentlyContinue }
  $env:PATH = $originalPath
  if ($null -eq $originalDataDir) { Remove-Item Env:\VIDEOFORGE_DATA_DIR -ErrorAction SilentlyContinue }
  else { $env:VIDEOFORGE_DATA_DIR = $originalDataDir }
  Remove-Item -Recurse -Force $testData -ErrorAction SilentlyContinue
  if ($mainWasRunning) {
    Start-Process -FilePath $mainNodePath -ArgumentList "server/src/index.js" -WorkingDirectory "$PSScriptRoot\.." -WindowStyle Hidden -RedirectStandardOutput "$PSScriptRoot\..\logs\server-out.log" -RedirectStandardError "$PSScriptRoot\..\logs\server-err.log"
    $mainReady = $false
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 500
      try {
        $mainHealth = Invoke-RestMethod http://127.0.0.1:5401/api/health -TimeoutSec 2
        if ($mainHealth.ok) { $mainReady = $true; break }
      } catch {}
    }
    if (-not $mainReady) { Write-Host "警告：主服务未能自动恢复，请手动运行 npm start"; $pass = $false }
  }
}
if ($pass) { Write-Host "== 冒烟通过 ✅" } else { Write-Host "== 冒烟失败 ❌"; exit 1 }
