@echo off
rem Start the local control panel and open it in the browser.
rem Node lookup order: AA_NODE env var -> node.path file -> runtime\node.exe -> PATH
setlocal
cd /d "%~dp0"
title browser-autoanswer panel

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
if not exist "node_modules\playwright-core" (
  echo [x] dependencies missing. Run setup.cmd first.
  pause
  exit /b 1
)
"%NODE_EXE%" "app\server.js" --open --config config.json %*
echo.
echo Panel stopped. Press any key to close this window.
pause >nul
exit /b 0

:nonode
echo [x] node.exe not found.
echo     Install Node.js 18+, drop a portable node.exe into "runtime\",
echo     or put the full path to node.exe into a file named "node.path".
pause
exit /b 1
