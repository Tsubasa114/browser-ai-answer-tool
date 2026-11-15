@echo off
rem CLI entry point. Windows helper only; elsewhere run: node src/main.js
setlocal
cd /d "%~dp0"

set "NODE_EXE=node"
if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"

where node >nul 2>nul
if errorlevel 1 if not exist "%~dp0runtime\node.exe" (
  echo [x] node.exe not found. Run setup.cmd first, or install Node.js 18+.
  exit /b 1
)
if not exist "node_modules\playwright-core" (
  echo [x] dependencies missing. Run setup.cmd first.
  exit /b 1
)

"%NODE_EXE%" "%~dp0src\main.js" %*
