# One-click install of the Grok Bot wallpaper for Lively, no admin rights (install.cmd runs this):
#  1. a Startup-folder shortcut starts the Bot HQ server hidden at every Windows login (server.ps1);
#  2. starts the server now and builds lively\dist\grokbot-wallpaper.zip (build.ps1);
#  3. Lively from its own installer: the wallpaper goes into Lively's library and is set on the main screen;
#     otherwise (or the Microsoft Store version) the folder with the zip opens, to drag it into Lively.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js 24 or newer is required (https://nodejs.org). Install it and run install.cmd again.' -ForegroundColor Yellow
  exit 1
}

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($ShortcutPath)
$lnk.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $PSScriptRoot 'server.ps1')`""
$lnk.WorkingDirectory = $Root
$lnk.WindowStyle = 7   # minimized: no window flashes at login
$lnk.Description = 'Bot HQ server for the Grok Bot wallpaper (Lively)'
$lnk.Save()
Write-Host "The server starts at Windows sign-in: $ShortcutPath"

& (Join-Path $PSScriptRoot 'server.ps1') -Wait
if ($LASTEXITCODE) { Write-Host "The server did not start, see $Data\autostart.log" -ForegroundColor Red; exit 1 }
Write-Host "Server is running: $Base"

& (Join-Path $PSScriptRoot 'build.ps1')
$zip = Join-Path $PSScriptRoot 'dist\grokbot-wallpaper.zip'

$lively = Find-Lively
if ($lively) {
  $dest = Join-Path (Get-LivelyWallpaperDir) $LibraryFolderName
  Expand-Archive -Path $zip -DestinationPath $dest -Force
  if (-not (Get-Process Lively -ErrorAction SilentlyContinue)) { Start-Process $lively; Start-Sleep -Seconds 8 }
  Start-Process $lively -ArgumentList 'setwp', '--file', "`"$dest`"" -Wait
  Write-Host 'Done: the Grok Bot wallpaper is on in Lively (main screen).' -ForegroundColor Green
} else {
  Start-Process explorer.exe "/select,`"$zip`""
  Write-Host 'Last step: drag grokbot-wallpaper.zip into the Lively window (or Add Wallpaper -> choose this file).' -ForegroundColor Green
}
