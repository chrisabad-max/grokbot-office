# Build lively\dist\grokbot-wallpaper.zip: a Lively web wallpaper whose index.html only redirects to the LIVE page
# <server>/face/ on the local Bot HQ server (nothing is copied, edits in web\ and assets\ show after a reload).
# Not a "webpage link" wallpaper: Lively gives LivelyProperties.json (bot color, feed) only to local web wallpapers,
# and it keeps sending them to the page after the redirect.
# The view key from data\view-key.txt goes into index.html, so the zip is git-ignored: never share it.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

if (-not (Test-Server)) { & (Join-Path $PSScriptRoot 'server.ps1') -Wait }

# The key is made by the server on its first start with auth; if another server (e.g. --no-auth) holds the port, make it the same way.
$keyFile = Join-Path $Data 'view-key.txt'
if (-not (Test-Path $keyFile)) {
  $auth = ([Uri](Join-Path $Root 'server\auth.js')).AbsoluteUri
  & node --input-type=module -e "import { loadViewKey } from '$auth'; loadViewKey({ dataDir: process.argv[1] });" $Data
}
$key = (Get-Content $keyFile -Raw).Trim()
$url = "$Base/face/?key=$key"

$dist = Join-Path $PSScriptRoot 'dist'
$zip = Join-Path $dist 'grokbot-wallpaper.zip'
$pkg = Join-Path $env:TEMP ('gbw-pkg-' + [guid]::NewGuid().ToString('N'))   # fresh staging folder, only the zip stays
New-Item -ItemType Directory -Force $dist, $pkg | Out-Null

$redirect = "<!doctype html><meta charset=`"utf-8`"><title>Grok Bot</title><style>html{background:#000}</style>" +
  "<script>location.replace($($url | ConvertTo-Json));</script>"
[IO.File]::WriteAllText((Join-Path $pkg 'index.html'), $redirect, (New-Object Text.UTF8Encoding $false))
Copy-Item (Join-Path $PSScriptRoot 'LivelyInfo.json') $pkg
# Settings Lively shows under "Customise" and sends to the page as livelyPropertyListener(name, value).
Copy-Item (Join-Path $PSScriptRoot 'LivelyProperties.json') $pkg
# Library tile and preview: the Grok Bot logo mark.
Copy-Item (Join-Path $Root 'assets\brand\logo-mark.png') (Join-Path $pkg 'thumbnail.png')

$tmpZip = "$pkg.zip"
Compress-Archive -Path (Join-Path $pkg '*') -DestinationPath $tmpZip -Force
Remove-Item -Recurse -Force $pkg -ErrorAction SilentlyContinue
# A just-written zip can be held for a moment (antivirus, indexer): retry the swap a few times.
for ($i = 1; ; $i++) {
  try { Move-Item $tmpZip $zip -Force -ErrorAction Stop; break }
  catch { if ($i -ge 10) { throw }; Start-Sleep -Seconds 1 }
}
Write-Host "Done: $zip"
Write-Host 'The zip holds your view key: do not post or share it.'
