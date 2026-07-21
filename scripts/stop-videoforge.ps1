$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PidFile = Join-Path $Root "logs\videoforge-server.pid"

if (-not (Test-Path $PidFile)) {
  Write-Host "VideoForge is not running (no PID file)."
  exit 0
}

$serverPid = [int](Get-Content $PidFile | Select-Object -First 1)
try {
  & taskkill.exe /PID $serverPid /T /F | Out-Null
  Write-Host "VideoForge stopped (PID $serverPid)."
} catch {
  Write-Host "VideoForge process $serverPid was already stopped."
}
Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
