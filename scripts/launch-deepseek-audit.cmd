@echo off
setlocal
rem API Key, Base URL, and model mappings are configured in the Desktop Providers UI.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-deepseek-audit.ps1"
set "launchExitCode=%errorlevel%"
if not "%launchExitCode%"=="0" pause
exit /b %launchExitCode%
