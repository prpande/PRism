#!/usr/bin/env pwsh
#requires -Version 7
# Dot-source assertion harness for run-desktop.ps1's pure functions. No Pester
# (the repo has none; only Pester 3.4.0 ships). Run: pwsh -File scripts/run-desktop.Tests.ps1
$ErrorActionPreference = 'Stop'

# Dot-source the script under test. When dot-sourced, $MyInvocation.InvocationName is
# '.', so the script's main-guard (-ne '.') is false and Invoke-Main does NOT run.
# Note: dot-sourcing also runs run-desktop.ps1's param([switch]$SkipBuild) block in
# THIS scope, resetting $SkipBuild to $false — harmless here (the harness never reads
# it), but don't rely on a $SkipBuild value surviving the dot-source.
. (Join-Path $PSScriptRoot 'run-desktop.ps1')

$script:Failures = 0
function Assert-True {
    param([bool]$Cond, [string]$Msg)
    if ($Cond) { Write-Host "  PASS: $Msg" -ForegroundColor Green }
    else { Write-Host "  FAIL: $Msg" -ForegroundColor Red; $script:Failures++ }
}
function Assert-Equal {
    param($Expected, $Actual, [string]$Msg)
    Assert-True ($Expected -eq $Actual) "$Msg (expected '$Expected', got '$Actual')"
}
function Assert-Match {
    param([string]$Text, [string]$Pattern, [string]$Msg)
    Assert-True ($Text -match $Pattern) "$Msg (pattern '$Pattern' not found)"
}

Write-Host "run-desktop.ps1 unit tests" -ForegroundColor Cyan

# === test blocks are appended here by later tasks ===

# --- footer: exit non-zero on any failure ---
if ($script:Failures -gt 0) {
    Write-Host "$script:Failures test(s) failed" -ForegroundColor Red
    exit 1
}
Write-Host "All tests passed" -ForegroundColor Green
