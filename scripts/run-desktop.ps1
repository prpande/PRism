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

function Invoke-Main {
    param([switch]$SkipBuild)
    throw "Invoke-Main not yet implemented"
}

# --- main (skipped when dot-sourced for isolated testing) ---
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-Main -SkipBuild:$SkipBuild
}
