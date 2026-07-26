@echo off
setlocal
rem Build the Windows x64 desktop installer and unpacked application.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop\scripts\build-windows-x64.ps1" %*
if errorlevel 1 pause
