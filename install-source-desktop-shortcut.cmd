@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop\scripts\source-desktop-shortcut.ps1"
if errorlevel 1 pause
