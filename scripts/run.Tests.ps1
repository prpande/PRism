#!/usr/bin/env pwsh
# Assertion harness for run.ps1's PARAMETER BINDING (issue #274). No Pester (repo
# convention; mirrors scripts/run-desktop.Tests.ps1). Run: pwsh -File scripts/run.Tests.ps1
#
# Why not dot-source run.ps1 like run-desktop.Tests.ps1 does? run.ps1's binding IS the
# thing under test, but its param() block is followed immediately by the npm/dotnet
# build+launch body -- invoking it to observe binding would run the whole build. So we
# extract run.ps1's REAL param block (plus any block-level attributes such as
# [CmdletBinding(PositionalBinding=$false)]) via the PowerShell AST, graft it onto a
# tiny body that just echoes the bound values as JSON, and invoke THAT probe the way a
# user does -- `& <script> <args>` in-session (here: a child PowerShell host). This
# exercises the actual contract declared in run.ps1, not a hand-copied duplicate that
# could drift.
#
# The bug (#274): with implicit positional binding, `./run.ps1 -Reset None --no-browser`
# bound `--no-browser` to [int]$Port and threw "Cannot convert ... to Int32"; a bare
# `--no-browser` bound to $Reset and failed its ValidateSet. The fix disables positional
# binding so unmatched --tokens flow to $DotnetArgs (ValueFromRemainingArguments).
$ErrorActionPreference = 'Stop'

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

Write-Host "run.ps1 parameter-binding tests (#274)" -ForegroundColor Cyan

# --- Extract run.ps1's param block (with block-level attributes) via the AST ---
# $pb.Extent.Text covers `param( ... )` INCLUDING per-parameter attributes, but NOT
# block-level attributes like [CmdletBinding()] -- those live in $pb.Attributes with
# their own (earlier) offsets. Slice the raw file from the earliest of {attribute
# starts, param-block start} through the param-block end so the extracted region is a
# verbatim, faithful copy in both the pre-fix (no CmdletBinding) and post-fix states.
$runPs1 = Join-Path (Split-Path -Parent $PSScriptRoot) 'run.ps1'
Assert-True (Test-Path -LiteralPath $runPs1) "run.ps1 found at repo root ($runPs1)"
$raw = Get-Content -LiteralPath $runPs1 -Raw
$ast = [System.Management.Automation.Language.Parser]::ParseFile($runPs1, [ref]$null, [ref]$null)
$pb = $ast.ParamBlock
if ($null -eq $pb) { throw "run.ps1 has no param() block -- cannot test binding." }
$starts = @($pb.Attributes | ForEach-Object { $_.Extent.StartOffset }) + @($pb.Extent.StartOffset)
$start = ($starts | Measure-Object -Minimum).Minimum
$paramRegion = $raw.Substring($start, $pb.Extent.EndOffset - $start)

# --- Build a probe script: extracted param region + a body echoing the bound values ---
$probeBody = @'

[ordered]@{
    Reset      = $Reset
    Port       = $Port
    DataDir    = $DataDir
    BuildOnly  = [bool]$BuildOnly
    SkipBuild  = [bool]$SkipBuild
    DotnetArgs = @($DotnetArgs)
} | ConvertTo-Json -Compress
'@
$probePath = Join-Path ([System.IO.Path]::GetTempPath()) ("run-ps1-binding-probe-" + [guid]::NewGuid().ToString('N') + ".ps1")
[System.IO.File]::WriteAllText($probePath, $paramRegion + [Environment]::NewLine + $probeBody, [System.Text.UTF8Encoding]::new($false))

# Spawn the SAME host that launched us (pwsh or powershell), so binding matches the
# host run.ps1 actually runs under. -Command "& '<probe>' <args>" reproduces the exact
# in-session invocation path (`./run.ps1 <args>`) -- NOT `pwsh -File`, whose arg parser
# handles `--tokens` differently and would not reproduce the bug.
$hostExe = (Get-Process -Id $PID).Path

function Invoke-Binding {
    # Returns { Ok; Result } where Result is the parsed JSON object (or $null on a
    # binding failure). On success the probe writes ONE compact JSON line to stdout; a
    # parameter-binding throw writes an error (no JSON) and exits non-zero. Success is
    # keyed on a parseable JSON object appearing on stdout -- NOT on exit code.
    #
    # $ErrorActionPreference is forced to Continue around the child call: Windows
    # PowerShell 5.1 promotes a native command's stderr to a TERMINATING error under
    # 'Stop' (which `2>$null` does not suppress), which would abort the harness on the
    # negative cases (invalid -Reset / out-of-range -Port) -- the very host where PS
    # binding historically diverges, so it must run there. pwsh 7 is unaffected either way.
    param([string]$ArgLine)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $hostExe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
            -Command "& '$probePath' $ArgLine" 2>$null
    } finally {
        $ErrorActionPreference = $prev
    }
    $jsonLine = @($out | Where-Object { $_ -is [string] -and $_.TrimStart().StartsWith('{') }) |
        Select-Object -First 1
    $result = if ($jsonLine) { try { $jsonLine | ConvertFrom-Json } catch { $null } } else { $null }
    return [pscustomobject]@{ Ok = [bool]$result; Result = $result }
}

try {
    # === Case 1: the issue's exact repro. RED on main (throws on -Port), GREEN on fix. ===
    Write-Host "Case 1: -Reset None --no-browser (the issue repro)" -ForegroundColor Cyan
    $c1 = Invoke-Binding '-Reset None --no-browser'
    Assert-True $c1.Ok "binds without throwing"
    if ($c1.Ok) {
        Assert-Equal 'None' $c1.Result.Reset "  -Reset stays None"
        Assert-Equal 5180 $c1.Result.Port "  -Port keeps its default (not clobbered by --no-browser)"
        Assert-True (@($c1.Result.DotnetArgs) -contains '--no-browser') "  --no-browser flows into `$DotnetArgs"
    }

    # === Case 2: bare pass-through, no named -Reset. RED on main (ValidateSet on Reset). ===
    Write-Host "Case 2: --no-browser (no named -Reset)" -ForegroundColor Cyan
    $c2 = Invoke-Binding '--no-browser'
    Assert-True $c2.Ok "binds without throwing"
    if ($c2.Ok) {
        Assert-Equal 'None' $c2.Result.Reset "  -Reset defaults to None"
        Assert-True (@($c2.Result.DotnetArgs) -contains '--no-browser') "  --no-browser flows into `$DotnetArgs"
    }

    # === Case 3: named -Port/-DataDir + trailing pass-through still bind (guards over-correction). ===
    Write-Host "Case 3: -Reset None -Port 5200 -DataDir C:\tmp\x --no-browser --foo bar" -ForegroundColor Cyan
    $c3 = Invoke-Binding '-Reset None -Port 5200 -DataDir C:\tmp\x --no-browser --foo bar'
    Assert-True $c3.Ok "binds without throwing"
    if ($c3.Ok) {
        Assert-Equal 5200 $c3.Result.Port "  named -Port binds"
        Assert-Equal 'C:\tmp\x' $c3.Result.DataDir "  named -DataDir binds"
        Assert-True (@($c3.Result.DotnetArgs) -contains '--no-browser') "  --no-browser in `$DotnetArgs"
        Assert-True (@($c3.Result.DotnetArgs) -contains '--foo') "  --foo in `$DotnetArgs"
        Assert-True (@($c3.Result.DotnetArgs) -contains 'bar') "  bar in `$DotnetArgs"
    }

    # === Case 4: switches still bind alongside pass-through. ===
    Write-Host "Case 4: -Reset None -BuildOnly --no-browser" -ForegroundColor Cyan
    $c4 = Invoke-Binding '-Reset None -BuildOnly --no-browser'
    Assert-True $c4.Ok "binds without throwing"
    if ($c4.Ok) {
        Assert-Equal $true $c4.Result.BuildOnly "  -BuildOnly switch is set"
        Assert-True (@($c4.Result.DotnetArgs) -contains '--no-browser') "  --no-browser in `$DotnetArgs"
    }

    # === Case 5: invalid -Reset is STILL rejected (fix must not weaken validation). ===
    Write-Host "Case 5: -Reset Bogus (must still fail ValidateSet)" -ForegroundColor Cyan
    $c5 = Invoke-Binding '-Reset Bogus'
    Assert-True (-not $c5.Ok) "invalid -Reset value is rejected"

    # === Case 6: out-of-range -Port is STILL rejected (ValidateRange intact). ===
    Write-Host "Case 6: -Port 70000 (must still fail ValidateRange)" -ForegroundColor Cyan
    $c6 = Invoke-Binding '-Port 70000'
    Assert-True (-not $c6.Ok) "out-of-range -Port is rejected"
} finally {
    Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
}

# --- footer: exit non-zero on any failure ---
if ($script:Failures -gt 0) {
    Write-Host "$script:Failures test(s) failed" -ForegroundColor Red
    exit 1
}
Write-Host "All tests passed" -ForegroundColor Green
