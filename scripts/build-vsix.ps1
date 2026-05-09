#!/usr/bin/env pwsh
# Build a .vsix package for the ADO Todo Sync extension.
# Usage: pwsh scripts/build-vsix.ps1 [-Install]

param(
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "==> Installing dependencies" -ForegroundColor Cyan
npm install

Write-Host "==> Compiling TypeScript" -ForegroundColor Cyan
npm run compile

# vsce refuses to package without a README.md.
if (-not (Test-Path "$root/README.md")) {
    Write-Host "==> Creating placeholder README.md" -ForegroundColor Yellow
    @"
# ADO Todo Sync

Capture todos in your repo and sync them to Azure DevOps. Delegate work to
Claude Code, GitHub Copilot, or ADO Copilot agents and track progress and
effort metrics in VS Code.
"@ | Set-Content -Path "$root/README.md" -Encoding UTF8
}

Write-Host "==> Packaging .vsix" -ForegroundColor Cyan
Get-ChildItem -Path $root -Filter '*.vsix' | Remove-Item -Force

$vsceCmd = Join-Path $root 'node_modules/.bin/vsce.cmd'
$vsceArgs = @('package')
if (-not (Test-Path "$root/LICENSE")) { $vsceArgs += '--skip-license' }

& $vsceCmd @vsceArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error "vsce package failed (exit $LASTEXITCODE)."
    exit $LASTEXITCODE
}

$vsix = Get-ChildItem -Path $root -Filter '*.vsix' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $vsix) {
    Write-Error "No .vsix produced."
    exit 1
}
Write-Host "==> Built: $($vsix.Name)" -ForegroundColor Green

if ($Install) {
    Write-Host "==> Installing into VS Code" -ForegroundColor Cyan
    & code --install-extension $vsix.FullName --force
}
