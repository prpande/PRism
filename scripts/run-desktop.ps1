#!/usr/bin/env pwsh
#requires -Version 7
<#
.SYNOPSIS
    Clone-and-run the PRism desktop (Electron) app on Windows, detached.
.DESCRIPTION
    One command for testers: preflight (Node + .NET SDK >= 10 with remediation),
    build the SPA, publish a framework-dependent win-x64 sidecar into
    desktop/.dev-sidecar/, build the Electron TS, then launch `electron .` DETACHED
    via the serve-detached.ps1 WMI wrapper pattern so the calling terminal is freed.
    Closing the window tears down the sidecar (Electron owns it). See
    docs/specs/2026-06-11-desktop-launchers-design.md.
.PARAMETER SkipBuild
    Skip the build/publish steps and launch against the current desktop/.dev-sidecar/
    output. For fast re-launches once a build is current.
.EXAMPLE
    scripts\run-desktop.ps1
.EXAMPLE
    scripts\run-desktop.ps1 -SkipBuild
#>
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Pure, dot-sourceable helpers below. The main-guard at the bottom keeps them
# importable into run-desktop.Tests.ps1 without executing the launch.
# ---------------------------------------------------------------------------

function Get-DotnetSdkMajors {
    # Parse `dotnet --list-sdks` lines (e.g. "10.0.100 [C:\Program Files\dotnet\sdk]")
    # into a sorted-unique list of integer major versions. Non-matching lines are
    # ignored; empty input yields an empty array.
    param([string[]]$ListSdksOutput)
    $majors = foreach ($line in $ListSdksOutput) {
        if ($line -match '^\s*(\d+)\.\d+\.\d+') { [int]$Matches[1] }
    }
    return @($majors | Sort-Object -Unique)
}

function Test-HasDotnetSdkAtLeast {
    # True if any installed SDK major version is >= $MinMajor.
    param([string[]]$ListSdksOutput, [int]$MinMajor)
    return (@(Get-DotnetSdkMajors -ListSdksOutput $ListSdksOutput | Where-Object { $_ -ge $MinMajor })).Count -gt 0
}

function Get-NodeRemediation {
    return @'
Node.js / npm was not found on PATH.
  Windows: winget install OpenJS.NodeJS.LTS
  (or download from https://nodejs.org/ — CI builds on Node 24, the recommended version)
After installing, open a new terminal so PATH refreshes, then re-run this script.
'@
}

function Get-DotnetRemediation {
    param([string[]]$FoundSdks = @())
    $found = if ($FoundSdks.Count -gt 0) { "Found SDK(s): $($FoundSdks -join ', ')." } else { "No .NET SDK found." }
    return @"
A .NET 10 SDK is required to publish the PRism sidecar (the solution targets net10.0).
  $found
  Windows: winget install Microsoft.DotNet.SDK.10
  (or download the .NET 10 SDK from https://dotnet.microsoft.com/download/dotnet/10.0)
After installing, open a new terminal so PATH refreshes, then re-run this script.
"@
}

function Get-HostRid {
    # This Windows launcher only runs on Windows; the macOS RID (osx-arm64/osx-x64)
    # is handled by run-desktop.sh. win-x64 is the sole target here.
    return 'win-x64'
}

function Get-SidecarApphostPath {
    # The framework-dependent publish produces an apphost named after the assembly
    # (PRism.Web -> PRism.Web.exe). NOT the CI-renamed PRism-<rid> packaging artifact.
    param([string]$PublishDir)
    return (Join-Path $PublishDir 'PRism.Web.exe')
}

function New-DesktopLauncherWrapper {
    # Build the disposable wrapper .ps1 launched via WMI. A Win32_Process.Create
    # command line carries NEITHER env vars NOR redirection operators, so the wrapper
    # owns both: it sets PRISM_SIDECAR_BINARY, cd's to desktop/, and runs `electron .`
    # with its own *>> redirection. Single-quote every interpolated path (doubling
    # embedded quotes) so a space/quote in a path cannot break the script. Same
    # technique as scripts/serve-detached.ps1:Write-WrapperScript.
    param(
        [string]$ElectronExe,
        [string]$DesktopDir,
        [string]$SidecarBinary,
        [string]$Log,
        [string]$StartedUtc
    )
    $qLog      = "'" + ($Log -replace "'", "''") + "'"
    $qSidecar  = "'" + ($SidecarBinary -replace "'", "''") + "'"
    $qDesktop  = "'" + ($DesktopDir -replace "'", "''") + "'"
    $qElectron = "'" + ($ElectronExe -replace "'", "''") + "'"
    return @"
# run-desktop.wrapper.ps1 -- AUTHORED AT RUNTIME, disposable, overwritten each launch.
# Owns its own env + redirection so the WMI command line carries none.
`$ErrorActionPreference = 'Stop'
`$log = $qLog
`$env:PRISM_SIDECAR_BINARY = $qSidecar
"=== run-desktop launch @ $StartedUtc ===" *>> `$log
Set-Location $qDesktop
& $qElectron . *>> `$log
"@
}

function Get-LauncherPidfilePath {
    param([string]$DataDir)
    return (Join-Path $DataDir 'run-desktop.pid')
}

function Write-LauncherPidfile {
    param([string]$PidfilePath, [int]$ProcessId)
    [System.IO.File]::WriteAllText($PidfilePath, "$ProcessId", [System.Text.UTF8Encoding]::new($false))
}

function Test-LauncherAlreadyRunning {
    # True only if the pidfile names a LIVE process whose name is in $ExpectedNames.
    # The recycle guard (name check) mirrors serve-detached.ps1:Stop-ProcessIfMatches:
    # a 32-bit PID recycles fast, so a stale pidfile PID may now be an unrelated app.
    # The wrapper pwsh stays alive as electron's parent, so 'pwsh' is the live owner;
    # 'electron' is included for the macOS-style direct case / defensiveness.
    param([string]$PidfilePath, [string[]]$ExpectedNames = @('pwsh', 'electron'))
    if (-not (Test-Path -LiteralPath $PidfilePath)) { return $false }
    $raw = Get-Content -LiteralPath $PidfilePath -Raw -ErrorAction SilentlyContinue
    if (-not ($raw -match '^\s*(\d+)\s*$')) { return $false }
    $procId = [int]$Matches[1]
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    return $ExpectedNames -contains $p.Name
}

function Invoke-Main {
    param([switch]$SkipBuild)
    throw "Invoke-Main not yet implemented"
}

# --- main (skipped when dot-sourced for isolated testing) ---
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-Main -SkipBuild:$SkipBuild
}
