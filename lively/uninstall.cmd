@echo off
rem Remove the server autostart and the Grok Bot wallpaper from Lively. See README.md.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
pause
