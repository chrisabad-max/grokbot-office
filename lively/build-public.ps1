# Build lively\dist\grokbot-wallpaper-windows.zip: the Lively package anyone can install (no local server, no key).
# Its index.html opens the live wallpaper on GitHub Pages and passes Lively's settings (bot color, bots channel) on.
# Everything in it comes from lively\public\; thumbnail.jpg and preview.gif there are renders of the wallpaper itself.
# The site publishes the zip at download/grokbot-wallpaper-windows.zip (landing\assemble.mjs), so it is committed.
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'public'
$files = 'index.html', 'LivelyInfo.json', 'LivelyProperties.json', 'thumbnail.jpg', 'preview.gif'
foreach ($f in $files) { if (-not (Test-Path (Join-Path $src $f))) { throw "lively\public\$f is missing" } }
# Lively refuses a package that asks for a newer Lively than the one installed: keep AppVersion at 2.2.1.0 or lower.
$info = Get-Content (Join-Path $src 'LivelyInfo.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ([version]$info.AppVersion -gt [version]'2.2.1.0') { throw "AppVersion $($info.AppVersion) is above 2.2.1.0" }

$dist = Join-Path $PSScriptRoot 'dist'
$zip = Join-Path $dist 'grokbot-wallpaper-windows.zip'
$pkg = Join-Path $env:TEMP ('gbw-public-' + [guid]::NewGuid().ToString('N'))   # fresh staging folder, only the zip stays
New-Item -ItemType Directory -Force $dist, $pkg | Out-Null
foreach ($f in $files) { Copy-Item (Join-Path $src $f) $pkg }

$tmpZip = "$pkg.zip"
Compress-Archive -Path (Join-Path $pkg '*') -DestinationPath $tmpZip -Force
Remove-Item -Recurse -Force $pkg -ErrorAction SilentlyContinue
# A just-written zip can be held for a moment (antivirus, indexer): retry the swap a few times.
for ($i = 1; ; $i++) {
  try { Move-Item $tmpZip $zip -Force -ErrorAction Stop; break }
  catch { if ($i -ge 10) { throw }; Start-Sleep -Seconds 1 }
}
Write-Host "Done: $zip ($([math]::Round((Get-Item $zip).Length / 1KB)) KB)"
