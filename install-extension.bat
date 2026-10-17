@echo off
setlocal
cd /d "%~dp0"

where code.cmd >nul 2>nul
if errorlevel 1 (
  echo [LocalCoder] The VS Code command-line tool was not found.
  echo In VS Code, enable the 'code' command or install the VSIX manually.
  pause
  exit /b 1
)

if not exist "vscode-extension\localcoder-0.14.6.vsix" (
  echo [LocalCoder] Missing vscode-extension\localcoder-0.14.6.vsix
  echo Run npm run package:extension from the LocalCoder folder first.
  pause
  exit /b 1
)

call code.cmd --install-extension "%~dp0vscode-extension\localcoder-0.14.6.vsix" --force
if errorlevel 1 (
  echo [LocalCoder] Extension installation failed.
  pause
  exit /b 1
)

echo.
echo [LocalCoder] Extension installed successfully.
echo Restart VS Code, open a project folder, and select LocalCoder from the Activity Bar.
pause
