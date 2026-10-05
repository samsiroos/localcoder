@echo off
setlocal
cd /d "%~dp0"

echo [LocalCoder] Stopping the model and local API...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'SilentlyContinue';" ^
  "try { Invoke-RestMethod -Method Post -TimeoutSec 5 -Uri 'http://127.0.0.1:11436/api/model/unload' | Out-Null } catch {};" ^
  "Start-Sleep -Seconds 1;" ^
  "$pids = Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -in 11435,11436 } | Select-Object -ExpandProperty OwningProcess -Unique;" ^
  "foreach ($processId in $pids) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }"

powershell.exe -NoProfile -Command "Start-Sleep -Seconds 1"
powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -in 11435,11436 }) { exit 1 }"
if errorlevel 1 (
  echo [LocalCoder] Could not stop every LocalCoder process.
  pause
  exit /b 1
)

echo [LocalCoder] AI server stopped successfully.
pause

