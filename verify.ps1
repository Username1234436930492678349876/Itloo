$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Running Qur'an Word Sync Maker v6.8 checks..." -ForegroundColor Cyan

if (Get-Command node -ErrorAction SilentlyContinue) {
  node --check src\main.js
  node --check src\quran.js
  node --check src\sync.js
  node tests\sync.test.mjs
  node tests\quran.test.mjs
  node tests\static.test.mjs
} else {
  Write-Host "Node is not installed; skipping optional frontend source tests." -ForegroundColor Yellow
}

$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
  $pythonCmd = Get-Command python -ErrorAction SilentlyContinue
  if (-not $pythonCmd) { throw "Python was not found. Run setup-ai.ps1 first." }
  $python = $pythonCmd.Source
}

& $python -m py_compile backend\app.py backend\alignment.py backend\audio_utils.py backend\model_runtime.py backend\phonetics.py backend\render.py
& $python tests\backend_test.py

Write-Host "All available checks passed." -ForegroundColor Green
