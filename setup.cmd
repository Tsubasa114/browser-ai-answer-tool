@echo off
rem Install dependencies for the portable/node setup. Windows helper only.
setlocal
cd /d "%~dp0"

if exist "node_modules\playwright-core\package.json" (
  echo [ok] dependencies already installed
  exit /b 0
)

set "NODE_EXE=node"
if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"

where node >nul 2>nul
if errorlevel 1 if not exist "%~dp0runtime\node.exe" goto nonode

echo [*] using node: %NODE_EXE%
where npm >nul 2>nul
if errorlevel 1 goto nonpm

call npm install --no-audit --no-fund
if errorlevel 1 goto failed
if exist "node_modules\playwright-core\package.json" (
  echo [ok] dependencies installed
  exit /b 0
)

:failed
echo [x] install failed - check your network, then run: npm install
exit /b 1

:nonode
echo [x] node.exe not found.
echo     Install Node.js 18+ from https://nodejs.org/ or drop a portable
echo     node.exe into the "runtime" folder next to this script.
exit /b 1

:nonpm
echo [x] npm not found in PATH. Install Node.js (it ships with npm) and retry.
exit /b 1
