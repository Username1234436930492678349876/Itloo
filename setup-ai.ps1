$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Qur'an Word Sync Maker v6.8 - setup" -ForegroundColor Cyan

function New-QwsVenv {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    Write-Host "Using the Windows Python launcher..."
    & py -3 -m venv .venv
    return
  }

  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python) {
    Write-Host "Using Python at $($python.Source)..."
    & $python.Source -m venv .venv
    return
  }

  $candidates = @()
  if ($env:LOCALAPPDATA) {
    $candidates += Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python*\python.exe" -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending |
      Select-Object -ExpandProperty FullName
  }
  if ($candidates.Count -gt 0) {
    Write-Host "Using Python at $($candidates[0])..."
    & $candidates[0] -m venv .venv
    return
  }

  throw "Python 3 was not found. Install Python 3.11+ from python.org, then run setup-ai.ps1 again."
}

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  Write-Host "Creating a private virtual environment (no administrator access needed)..."
  New-QwsVenv
}

$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
Write-Host "Updating pip..."
& $python -m pip install --upgrade pip

Write-Host "Installing the local AI/video dependencies. This can take a while..."
& $python -m pip install -r backend\requirements.txt

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host "Run start.bat next. No npm, Vite, Node server, or administrator rights are required."
Write-Host "The first AI Precise sync downloads the Arabic and Qur'an phonetic models and caches them on this PC."
