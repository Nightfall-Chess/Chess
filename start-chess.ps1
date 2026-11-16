$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error "Node.js 22.15 or newer is required. Install Node.js, then run this script again."
  exit 1
}

$versionText = (& $node.Source --version) -replace '^v', '' -replace '-.*$', ''
try {
  $nodeVersion = [version]$versionText
} catch {
  Write-Error "Could not determine the installed Node.js version: $versionText"
  exit 1
}
if ($nodeVersion -lt [version]"22.15.0") {
  Write-Error "Node.js 22.15 or newer is required; found $nodeVersion."
  exit 1
}

Write-Host "Starting Nightfall Chess at http://127.0.0.1:4173/ (listening on all interfaces for LAN and tunnel access)"
Write-Host "Keep this window open while playing. Press Ctrl+C to stop the server."
& $node.Source (Join-Path $PSScriptRoot "server.mjs")
exit $LASTEXITCODE
