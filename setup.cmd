@echo off
rem Install dependencies. Windows helper only.
rem Node lookup order: AA_NODE env var -> node.path file -> runtime\node.exe -> PATH
setlocal
cd /d "%~dp0"

if exist "node_modules\playwright-core\package.json" (
  echo [ok] dependencies already installed
  exit /b 0
)

set "NODE_EXE="
if defined AA_NODE set "NODE_EXE=%AA_NODE%"
if defined NODE_EXE goto have_node
if exist "%~dp0node.path" set /p NODE_EXE=<"%~dp0node.path"
if defined NODE_EXE goto have_node
if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"
if defined NODE_EXE goto have_node
where node >nul 2>nul
if errorlevel 1 goto nonode
set "NODE_EXE=node"

:have_node
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
echo.
echo     Pick one:
echo       1. Install Node.js 18+  https://nodejs.org/
echo       2. Put a portable node.exe in the "runtime" folder
echo       3. Create a file named "node.path" here containing the full path
echo          to node.exe (one line), or set the AA_NODE environment variable
exit /b 1

:nonpm
echo [x] npm not found in PATH. Install Node.js (it ships with npm) and retry.
exit /b 1
