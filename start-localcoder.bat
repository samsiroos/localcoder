@echo off
setlocal
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [LocalCoder] Node.js 20 or newer is required.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)

if not exist "tools\llama.cpp\llama-server.exe" (
  echo [LocalCoder] Missing tools\llama.cpp\llama-server.exe
  echo Copy the complete LocalCoder folder, including the tools directory.
  pause
  exit /b 1
)

if not exist "models\qwen2.5-coder-1.5b-instruct-q4_k_m.gguf" (
  echo [LocalCoder] Default model is missing. Downloading Qwen2.5-Coder 1.5B...
  if not exist "models" mkdir "models"
  curl.exe --fail --location --retry 3 --output "models\qwen2.5-coder-1.5b-instruct-q4_k_m.gguf.tmp" "https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf"
  if errorlevel 1 (
    echo [LocalCoder] Model download failed. Check your internet connection and run this file again.
    if exist "models\qwen2.5-coder-1.5b-instruct-q4_k_m.gguf.tmp" del "models\qwen2.5-coder-1.5b-instruct-q4_k_m.gguf.tmp"
    pause
    exit /b 1
  )
  move /y "models\qwen2.5-coder-1.5b-instruct-q4_k_m.gguf.tmp" "models\qwen2.5-coder-1.5b-instruct-q4_k_m.gguf" >nul
  if errorlevel 1 (
    echo [LocalCoder] Could not install the downloaded model in the models directory.
    pause
    exit /b 1
  )
  echo [LocalCoder] Model downloaded successfully.
)

powershell.exe -NoProfile -Command "try { Invoke-RestMethod -TimeoutSec 2 -Uri 'http://127.0.0.1:11436/api/status' | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 goto configure_server

echo [LocalCoder] Loading Qwen2.5-Coder 1.5B...
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $base='http://127.0.0.1:11436'; try { Invoke-RestMethod -Method Post -TimeoutSec 10 -Uri ($base + '/api/model/unload') | Out-Null; $deadline=(Get-Date).AddSeconds(30); do { Start-Sleep -Seconds 2; $status=Invoke-RestMethod -TimeoutSec 5 -Uri ($base + '/api/status') } while ($status.ready -and (Get-Date) -lt $deadline); if ($status.ready) { throw 'The currently loaded model did not stop.' }; Invoke-RestMethod -Method Post -TimeoutSec 10 -ContentType 'application/json' -Uri ($base + '/api/model/load') -Body (@{ modelPath='models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf' } | ConvertTo-Json -Compress) | Out-Null; $deadline=(Get-Date).AddMinutes(2); do { Start-Sleep -Seconds 2; $status=Invoke-RestMethod -TimeoutSec 5 -Uri ($base + '/api/status'); if ($status.ready -and $status.config.modelPath -eq 'models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf') { Write-Output '[LocalCoder] Qwen2.5-Coder 1.5B is loaded and ready.'; exit 0 } } while ((Get-Date) -lt $deadline); throw 'Qwen2.5-Coder 1.5B did not become ready within 2 minutes.' } catch { Write-Error $_; exit 1 }"
if errorlevel 1 (
  echo [LocalCoder] Could not load the required Qwen2.5-Coder model.
  pause
  exit /b 1
)
echo You can open VS Code and use the LocalCoder panel.
echo Run stop-localcoder.bat when you want to stop the service.
pause
exit /b 0

:configure_server
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $configPath=Join-Path (Get-Location) '.localcoder\config.json'; New-Item -ItemType Directory -Force -Path (Split-Path $configPath) | Out-Null; if (Test-Path $configPath) { $config=Get-Content -Raw $configPath | ConvertFrom-Json } else { $config=[pscustomobject]@{} }; $config | Add-Member -NotePropertyName modelPath -NotePropertyValue 'models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf' -Force; $config | Add-Member -NotePropertyName autoLoadModel -NotePropertyValue $true -Force; [System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))"
if errorlevel 1 (
  echo [LocalCoder] Could not configure the required Qwen2.5-Coder model.
  pause
  exit /b 1
)

:start_server
echo [LocalCoder] Starting offline AI server with Qwen2.5-Coder 1.5B...
echo [LocalCoder] Keep this window open. Press Ctrl+C to stop.
echo [LocalCoder] You can also run stop-localcoder.bat from another window.
echo.
node server\index.js
echo.
echo [LocalCoder] Server stopped.
pause
