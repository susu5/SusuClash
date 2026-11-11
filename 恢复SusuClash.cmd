@echo off
setlocal
set "SUSU_RECOVERY_SCRIPT=%~dp0src\recovery-assistant.ps1"
powershell.exe -NoProfile -NonInteractive -Command "Start-Process -FilePath powershell.exe -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + [char]34 + $env:SUSU_RECOVERY_SCRIPT + [char]34) -WindowStyle Hidden"
