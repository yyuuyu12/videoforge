$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Logs = Join-Path $Root "logs"
$PidFile = Join-Path $Logs "videoforge-server.pid"
$OutLog = Join-Path $Logs "videoforge-server.out.log"
$ErrLog = Join-Path $Logs "videoforge-server.err.log"
$HealthUrl = "http://127.0.0.1:5401/api/health"

New-Item -ItemType Directory -Force -Path $Logs | Out-Null

$listener = Get-NetTCPConnection -LocalPort 5401 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  Write-Host "VideoForge is already running (PID $($listener.OwningProcess))."
  Write-Host "http://127.0.0.1:5401"
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js was not found in PATH. Install Node.js or open a terminal with Node.js enabled."
}

$dist = Join-Path $Root "dashboard\dist\index.html"
if (-not (Test-Path $dist)) {
  Write-Host "Dashboard build is missing. Building it now..."
  Push-Location $Root
  try { npm run build } finally { Pop-Location }
}

Remove-Item $OutLog, $ErrLog -Force -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath "node" -ArgumentList "server/src/index.js" `
  -WorkingDirectory $Root -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog `
  -WindowStyle Hidden -PassThru
Set-Content -Path $PidFile -Value $proc.Id -Encoding ascii

for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
    if ($health.ok -eq $true) {
      Write-Host "VideoForge started (PID $($proc.Id))."
      Write-Host "http://127.0.0.1:5401"
      Write-Host "Logs: $Logs"
      Start-Process $HealthUrl
      exit 0
    }
  } catch {
    if ($proc.HasExited) { break }
  }
}

Write-Host "VideoForge failed to become healthy." -ForegroundColor Red
if (Test-Path $ErrLog) { Get-Content $ErrLog -Tail 40 }
if (Test-Path $OutLog) { Get-Content $OutLog -Tail 40 }
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
exit 1
