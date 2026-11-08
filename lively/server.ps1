# Start the Bot HQ server for the Lively wallpaper, hidden, unless something already answers on the port.
# The Startup shortcut made by install.ps1 runs this at every Windows login. Safe to run repeatedly.
#   -Wait   wait until the server answers (exit 1 if it does not start)
# Env: BOTHQ_PORT (8787), BOTHQ_JOURNAL (default data\events.jsonl). Log: data\autostart.log
param([switch]$Wait)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

if (Test-Server) { exit 0 }
New-Item -ItemType Directory -Force $Data | Out-Null
$log = Join-Path $Data 'autostart.log'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  "$(Get-Date -Format s) node not found in PATH (Node 24+ is required)" | Out-File -Append -Encoding ascii $log
  exit 1
}
$journal = if ($env:BOTHQ_JOURNAL) { $env:BOTHQ_JOURNAL } else { Join-Path $Data 'events.jsonl' }
# --no-cache: images from assets\ are revalidated too, so a wallpaper reload shows edited files at once.
# Through cmd without -Redirect*: the server inherits none of our handles, so a caller reading our output
# (Git Bash, a pipe) is not kept waiting until the server exits. The pid file holds that cmd.exe.
$server = Join-Path $Root 'server\server.js'
$line = "`"`"$node`" `"$server`" --port $Port --host 127.0.0.1 --journal `"$journal`" --no-cache >> `"$log`" 2>&1`""
$p = Start-Process cmd.exe -ArgumentList '/d', '/c', $line -WorkingDirectory $Root -WindowStyle Hidden -PassThru
Set-Content -Path (Join-Path $Data 'autostart.pid') -Value $p.Id

if ($Wait) {
  for ($i = 0; $i -lt 50; $i++) {
    if (Test-Server) { exit 0 }
    if ($p.HasExited) { break }
    Start-Sleep -Milliseconds 200
  }
  exit 1
}
