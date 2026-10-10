# Install envhound on Windows, into %LOCALAPPDATA%\Programs\envhound:
#   irm https://github.com/michelsalib/envhound/releases/latest/download/install.ps1 | iex
#
# ENVHOUND_INSTALL_DIR  where to put envhound (default %LOCALAPPDATA%\Programs\envhound)
# ENVHOUND_VERSION      a version such as 0.2.0 (default: the latest release)
# ENVHOUND_BASE_URL     where envhound.js and SHA256SUMS are downloaded from (mirrors, tests)
#
# envhound is one JavaScript file: it needs Node >= 20 or Bun, whichever is installed.
# Like install.sh, it never edits your profile or your Path: it prints what to run.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Fail($message) {
  [Console]::Error.WriteLine("envhound install: $message")
  exit 1
}

$repo = 'michelsalib/envhound'
$dir = if ($env:ENVHOUND_INSTALL_DIR) { $env:ENVHOUND_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\envhound' }
$version = if ($env:ENVHOUND_VERSION) { $env:ENVHOUND_VERSION -replace '^v', '' } else { 'latest' }
$base = if ($env:ENVHOUND_BASE_URL) { $env:ENVHOUND_BASE_URL }
  elseif ($version -eq 'latest') { "https://github.com/$repo/releases/latest/download" }
  else { "https://github.com/$repo/releases/download/v$version" }

# the runtime: Node >= 20 first, then Bun
$runtime = $null
if ((Get-Command node -ErrorAction SilentlyContinue) -and ((& node --version) -match '^v(\d+)\.') -and [int]$Matches[1] -ge 20) {
  $runtime = 'node'
}
if (-not $runtime -and (Get-Command bun -ErrorAction SilentlyContinue)) { $runtime = 'bun' }
if (-not $runtime) { Fail 'envhound needs Node >= 20 or Bun. Install one (https://nodejs.org, https://bun.sh), or run it with npx envhound / bunx envhound' }

function Download($url, $file) {
  if ($url -like 'file:*') { Copy-Item -LiteralPath ([Uri]$url).LocalPath -Destination $file }
  else { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file }
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("envhound-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  try { Download "$base/envhound.js" "$tmp\envhound.mjs" } catch { Fail "could not download $base/envhound.js" }
  try { Download "$base/SHA256SUMS" "$tmp\SHA256SUMS" } catch { Fail "could not download $base/SHA256SUMS" }
  $expected = Get-Content "$tmp\SHA256SUMS" | ForEach-Object {
    $sum, $name = $_ -split '\s+', 2
    if ($name -eq 'envhound.js' -or $name -eq '*envhound.js') { $sum }
  } | Select-Object -First 1
  if (-not $expected) { Fail 'SHA256SUMS has no entry for envhound.js' }
  if ((Get-FileHash -Algorithm SHA256 "$tmp\envhound.mjs").Hash -ne $expected) { Fail 'checksum mismatch for envhound.js; nothing was installed' }

  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  # copy next to the target, then rename: a running envhound is never left half-written
  $new = Join-Path $dir '.envhound.mjs.new'
  $target = Join-Path $dir 'envhound.mjs'
  [IO.File]::Copy((Join-Path $tmp 'envhound.mjs'), $new, $true)
  if ([IO.File]::Exists($target)) { [IO.File]::Replace($new, $target, [NullString]::Value) } else { [IO.File]::Move($new, $target) }
  Set-Content -Encoding ASCII -Path "$dir\envhound.cmd" -Value "@$runtime `"%~dp0envhound.mjs`" %*"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$installed = & "$dir\envhound.cmd" --version
Write-Output "installed envhound $installed in $dir (runs on $runtime)"
Write-Output 'PowerShell completion: add this line to your profile (notepad $PROFILE):'
Write-Output '  envhound completion powershell | Out-String | Invoke-Expression'

$inPath = ($env:Path -split ';' | Where-Object { $_.TrimEnd('\') -eq $dir.TrimEnd('\') }).Count -gt 0
if (-not $inPath) {
  Write-Output "$dir is not in your Path. To add it for new terminals, run:"
  Write-Output "  & `"$dir\envhound.cmd`" path add `"$dir`""
}
