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
  echo [LocalCoder] Missing default GGUF model in the models directory.
  echo Copy the complete LocalCoder folder, including the model.
  pause
  exit /b 1
)

powershell.exe -NoProfile -Command "try { Invoke-RestMethod -TimeoutSec 2 -Uri 'http://127.0.0.1:11436/api/status' | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 goto start_server

echo [LocalCoder] AI server is already running. The model loads automatically.
echo You can open VS Code and use the LocalCoder panel.
echo Run stop-localcoder.bat when you want to stop the service.
pause
exit /b 0

:start_server
echo [LocalCoder] Starting offline AI server...
echo [LocalCoder] Keep this window open. Press Ctrl+C to stop.
echo [LocalCoder] You can also run stop-localcoder.bat from another window.
echo.
node server\index.js
echo.
echo [LocalCoder] Server stopped.
pause

