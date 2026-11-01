@echo off
bun --no-env-file run "%~dp0cc-haha" %*
exit /b %errorlevel%
