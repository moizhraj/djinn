#!/usr/bin/env pwsh
# Hook wrapper: refreshes PATH from the registry (so npm/node/pwsh-launched
# subprocesses can find global tools regardless of how the parent process was
# started) and then invokes the project's build-vsix script.

$ErrorActionPreference = 'Stop'

$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = "$machinePath;$userPath"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..' '..')
& (Join-Path $repoRoot 'scripts\build-vsix.ps1')
exit $LASTEXITCODE
