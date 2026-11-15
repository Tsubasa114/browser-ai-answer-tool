@echo off
rem Start the local control panel and open it in the browser.
setlocal
cd /d "%~dp0"
title browser-autoanswer panel

set "NODE_EXE=node"
if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"

where node >nul 2>nul
if errorlevel 1 if not exist "%~dp0runtime\node.exe" (
  echo [x] node.exe not found. Run setup.cmd first, or install Node.js 18+.
  pause
  exit /b 1
)
if not exist "node_modules\playwright-core" (
  echo [x] dependencies missing. Run setup.cmd first.
  pause
  exit /b 1
)

"%NODE_EXE%" "app\server.js" --open --config config.json %*
echo.
echo Panel stopped. Press any key to close this window.
pause >nul
