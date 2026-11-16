@echo off
setlocal
set "CLASH_GLASS_NODE="
if exist "%~dp0runtime\node\node.exe" set "CLASH_GLASS_NODE=%~dp0runtime\node\node.exe"
if not defined CLASH_GLASS_NODE for /f "delims=" %%I in ('where.exe node.exe 2^>nul') do if not defined CLASH_GLASS_NODE set "CLASH_GLASS_NODE=%%I"
if defined CLASH_GLASS_NODE (
  "%CLASH_GLASS_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)" >nul 2>&1
  if errorlevel 1 set "CLASH_GLASS_NODE="
)
if not defined CLASH_GLASS_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "CLASH_GLASS_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined CLASH_GLASS_NODE (
  echo Node.js 22 or newer is required.
  pause
  exit /b 1
)
set "CLASH_GLASS_SCRIPT=%~dp0src\desktop.mjs"
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; Start-Process -FilePath $env:CLASH_GLASS_NODE -ArgumentList ([string][char]34 + $env:CLASH_GLASS_SCRIPT + [char]34) -WindowStyle Hidden"
if errorlevel 1 pause
