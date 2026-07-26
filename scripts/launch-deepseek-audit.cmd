@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-deepseek-audit.ps1"
if errorlevel 1 pause
