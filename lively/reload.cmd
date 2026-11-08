@echo off
rem Reload the running Lively wallpapers so they pick up edited files (Lively from its own installer).
powershell -NoProfile -ExecutionPolicy Bypass -Command ". '%~dp0common.ps1'; $l = Find-Lively; if ($l) { Start-Process $l -ArgumentList 'setwp','--file','reload' -Wait } else { Write-Host 'Lively.exe not found: reload from the Lively window (see README.md).'; exit 1 }"
