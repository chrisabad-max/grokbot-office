# Shared helpers for the Lively scripts in this folder (dot-sourced, not run on its own).
$Root = Split-Path $PSScriptRoot -Parent
$Data = Join-Path $Root 'data'
$Port = if ($env:BOTHQ_PORT) { [int]$env:BOTHQ_PORT } else { 8787 }
$Base = "http://127.0.0.1:$Port"
$ShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Grok Bot Wallpaper server.lnk'
$LibraryFolderName = 'grokbot-live'   # our folder inside Lively's library (install.ps1 puts the wallpaper there)

function Test-Server {
  try { (Invoke-WebRequest -UseBasicParsing "$Base/healthz" -TimeoutSec 2).StatusCode -eq 200 } catch { $false }
}

# Lively installed with its own installer (per user or for all users): Lively.exe, else $null.
# The Microsoft Store version keeps its files sandboxed: for it the zip is dragged into Lively by hand.
function Find-Lively {
  $keys = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
          'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  $dirs = @(Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Lively Wallpaper*' -and $_.InstallLocation } |
            ForEach-Object { $_.InstallLocation })
  $dirs += (Join-Path $env:LOCALAPPDATA 'Programs\Lively Wallpaper'), (Join-Path $env:ProgramFiles 'Lively Wallpaper')
  foreach ($d in $dirs) { $exe = Join-Path $d 'Lively.exe'; if (Test-Path $exe) { return $exe } }
  return $null
}

# Lively's library folder for installed wallpapers (Settings.json may move it).
function Get-LivelyWallpaperDir {
  $appData = Join-Path $env:LOCALAPPDATA 'Lively Wallpaper'
  $lib = Join-Path $appData 'Library'
  try {
    $s = Get-Content (Join-Path $appData 'Settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($s.WallpaperDir) { $lib = $s.WallpaperDir }
  } catch { }
  return (Join-Path $lib 'wallpapers')
}
