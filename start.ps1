$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$expectedVersion = "7.2.0"
$port = 8765
$baseUrl = "http://127.0.0.1:$port"

# If an older Qur'an Sync instance is still holding the usual port, stop only
# that known local instance instead of silently opening the wrong frontend.
try {
  $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 2
  if ($health.ok -eq $true) {
    $runningVersion = [string]$health.version
    if ($runningVersion -eq $expectedVersion) {
      Write-Host "Qur'an Word Sync Maker v$expectedVersion is already running." -ForegroundColor Green
      Start-Process $baseUrl
      exit 0
    }
    Write-Host "An older Qur'an Sync instance (v$runningVersion) is using port $port. Closing it so v$expectedVersion can start..." -ForegroundColor Yellow
    try {
      $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
      foreach ($listener in $listeners) {
        $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
        if ($proc -and ($proc.ProcessName -match 'python|pythonw')) {
          Stop-Process -Id $proc.Id -Force
        }
      }
      Start-Sleep -Milliseconds 700
    } catch {
      Write-Host "Could not automatically close the older instance. Close its terminal window, then run start.bat again." -ForegroundColor Red
      Read-Host "Press Enter to exit"
      exit 1
    }
  }
} catch {
  # Nothing compatible is listening; continue normally. If another unrelated
  # service owns the port, uvicorn will report that clearly below.
}

$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
  Write-Host "AI backend is not set up yet. Running setup-ai.ps1..." -ForegroundColor Yellow
  & "$PSScriptRoot\setup-ai.ps1"
}

Write-Host "Starting Qur'an Word Sync Maker v$expectedVersion at $baseUrl" -ForegroundColor Cyan
Start-Job -ScriptBlock { param($url); Start-Sleep -Seconds 2; Start-Process $url } -ArgumentList $baseUrl | Out-Null
& $python -m uvicorn backend.app:app --host 127.0.0.1 --port $port
