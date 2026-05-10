#!/usr/bin/env pwsh
# Hook wrapper invoked from .github/hooks/build-vsix.json (Copilot CLI agentStop).
#
# Responsibilities:
#   1. Refresh PATH from the registry so npm/node/pwsh-launched subprocesses
#      can find global tools regardless of how the parent process was started.
#   2. Decide whether to bump package.json's version, and bump it.
#        - "major" if commits since the last version change include a
#          Conventional-Commits breaking marker (BREAKING CHANGE, "feat!:",
#          etc.) or an explicit "[major]" tag in a commit message.
#        - "minor" otherwise, when there are real changes since the last bump.
#        - skipped entirely if there are no relevant changes (so the version
#          doesn't tick up on idle turns) or if the version was already
#          bumped this round (uncommitted package.json version change).
#   3. Invoke scripts/build-vsix.ps1 to package the .vsix.

$ErrorActionPreference = 'Stop'

$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = "$machinePath;$userPath"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
Set-Location $repoRoot

function Get-LastVersionBumpSha {
    # Last commit whose diff touched a "version": line in package.json.
    $sha = & git log -1 --format='%H' -G '"version":' -- package.json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $sha) { return $null }
    return $sha.Trim()
}

function Test-AlreadyBumped {
    # True if the working tree already has an uncommitted change to the
    # "version" field of package.json (so this turn's hook bumped it earlier
    # or the user/agent bumped it manually).
    $diff = & git diff -U0 -- package.json 2>$null
    if (-not $diff) { return $false }
    return ($diff -match '(?m)^\+\s*"version"\s*:')
}

function Get-ChangeSignal {
    param([string]$SinceSha)

    # Commit subjects + bodies since the last version bump (excluding the
    # bump commit itself).
    $commitMessages = @()
    if ($SinceSha) {
        $commitMessages = & git log "$SinceSha..HEAD" --format='%B%n--END--' 2>$null
    }

    # Working-tree changes, excluding generated artifacts and package.json
    # itself (its diff is inspected separately by Test-AlreadyBumped).
    $workingChanges = & git status --porcelain 2>$null | Where-Object {
        $line = $_.Trim()
        if (-not $line) { return $false }
        $path = ($line -split '\s+', 2)[1]
        if (-not $path) { return $false }
        if ($path -like '*.vsix') { return $false }
        if ($path -eq 'package.json') { return $false }
        return $true
    }

    return [PSCustomObject]@{
        HasChanges      = ($commitMessages.Count -gt 0) -or ($workingChanges.Count -gt 0)
        CommitMessages  = $commitMessages
    }
}

function Resolve-BumpKind {
    param([string[]]$CommitMessages)

    $breakingPattern = '(BREAKING[ _-]?CHANGE|^[a-z]+(\([^)]+\))?!:|\[major\])'
    foreach ($msg in $CommitMessages) {
        if ($null -eq $msg) { continue }
        if ($msg -match $breakingPattern) { return 'major' }
    }
    return 'minor'
}

function Invoke-VersionBump {
    param(
        [Parameter(Mandatory)][string]$PackageJsonPath,
        [Parameter(Mandatory)][ValidateSet('major', 'minor')][string]$Kind
    )

    # Surgical bump that only rewrites the "version" line so the rest of
    # package.json's formatting (inline arrays, indentation, key order) is
    # preserved. `npm version` reformats the whole file, which we don't want.
    $content = Get-Content $PackageJsonPath -Raw
    $pattern = '(?m)^(?<prefix>\s*"version"\s*:\s*")(?<v>\d+)\.(?<m>\d+)\.(?<p>\d+)(?<suffix>"\s*,?\s*)$'
    $match = [regex]::Match($content, $pattern)
    if (-not $match.Success) {
        throw "Could not locate version line in $PackageJsonPath."
    }

    $major = [int]$match.Groups['v'].Value
    $minor = [int]$match.Groups['m'].Value
    if ($Kind -eq 'major') {
        $major += 1; $minor = 0
    } else {
        $minor += 1
    }
    $newVersion = "$major.$minor.0"
    $replacement = "$($match.Groups['prefix'].Value)$newVersion$($match.Groups['suffix'].Value)"
    $newContent = $content.Substring(0, $match.Index) + $replacement + $content.Substring($match.Index + $match.Length)

    # Preserve original line endings (Set-Content -NoNewline keeps the trailing
    # newline state of the original file as-is).
    Set-Content -Path $PackageJsonPath -Value $newContent -NoNewline -Encoding UTF8
    return $newVersion
}

# ── Decide & apply version bump ─────────────────────────────────────────
$lastBumpSha = Get-LastVersionBumpSha
$signal = Get-ChangeSignal -SinceSha $lastBumpSha

if (Test-AlreadyBumped) {
    Write-Host "==> Version already bumped this round; skipping bump." -ForegroundColor Yellow
}
elseif (-not $signal.HasChanges) {
    Write-Host "==> No changes since last version bump; skipping bump." -ForegroundColor Yellow
}
else {
    $bump = Resolve-BumpKind -CommitMessages $signal.CommitMessages
    Write-Host "==> Bumping version ($bump)" -ForegroundColor Cyan
    $newVersion = Invoke-VersionBump -PackageJsonPath (Join-Path $repoRoot 'package.json') -Kind $bump
    Write-Host "==> New version: $newVersion" -ForegroundColor Green
}

# ── Build .vsix ─────────────────────────────────────────────────────────
& (Join-Path $repoRoot 'scripts\build-vsix.ps1')
exit $LASTEXITCODE
