@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\kill-cc-haha.ps1"
set "KILL_EXIT_CODE=%ERRORLEVEL%"
if not "%KILL_EXIT_CODE%"=="0" pause
exit /b %KILL_EXIT_CODE%
