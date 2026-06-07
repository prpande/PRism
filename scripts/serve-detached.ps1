#!/usr/bin/env pwsh
#requires -Version 7
<#
.SYNOPSIS
    Launch the PRism dev server as a long-lived DETACHED process and return a
    structured handle once it is answering HTTP. The agent-facing companion to
    run.ps1 (which is foreground, for a human watching the console).

.DESCRIPTION
    Windows-only. Detaches via WMI (Win32_Process.Create) so the server survives
    the calling tool returning, runs a wrapper that owns its own log redirection,
    delegates build + launch to run.ps1, and health-gates on /api/health with a
    canonical-dataDir match before emitting { Pid; Url; Log; DataDir; Version }.

    See docs/specs/2026-06-07-agent-detached-launcher-design.md. Tracking: #266.

.EXAMPLE
    scripts\serve-detached.ps1 -Port 5200 -DataDir $env:TEMP\PRism-wt-0
.EXAMPLE
    scripts\serve-detached.ps1 -Stop -DataDir $env:TEMP\PRism-wt-0
#>
param(
    # Same validation/default as run.ps1. Parallel agents use 5200 + N.
    [ValidateRange(1, 65535)]
    [int]$Port = 5180,

    # Same default as run.ps1. Canonicalized on entry; namespaces the pidfile/log/wrapper.
    [string]$DataDir = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PRism'),

    # Launch mode only: skip the foreground run.ps1 -BuildOnly step (build known current).
    [switch]$SkipBuild,

    # Teardown mode: read <DataDir> pidfile and tree-kill. Mutually exclusive with launch-only params.
    [switch]$Stop,

    # Launch mode only: on an occupied port NOT held by our own healthy server, kill the occupant.
    [switch]$Force,

    # Health-gate budget. Exposed (not hidden) because cold-start time varies widely.
    [ValidateRange(5, 600)]
    [int]$TimeoutSec = 90,

    # Pass-through app args (e.g. --no-browser), forwarded verbatim through run.ps1 to dotnet run.
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$DotnetArgs
)

$ErrorActionPreference = 'Stop'

function Assert-Platform {
    # Windows-only by design (spec section 2): the harness-reaping problem and its
    # WMI fix are Windows-specific, and Get-NetTCPConnection / taskkill / Win32_Process
    # do not exist on POSIX. Fail fast with a clear pointer rather than deep inside
    # the launch with a cryptic cmdlet-not-found.
    if (-not $IsWindows) {
        throw "serve-detached.ps1 is Windows-only (see spec section 2 'Out of scope: macOS / Linux'). On POSIX, setsid/nohup already survive; use run.ps1 directly."
    }
    # A locked-down sandbox / container may lack WMI. Probe cheaply so the failure
    # is interpretable rather than surfacing as a launch-time Invoke-CimMethod error.
    try {
        $null = Get-CimClass -ClassName Win32_Process -ErrorAction Stop
    } catch {
        throw "WMI (Win32_Process) is not reachable in this environment, so the detached launch cannot spawn outside the harness job object. Run run.ps1 in the foreground instead. Underlying error: $($_.Exception.Message)"
    }
}

function Get-CanonicalDataDir {
    # Resolve -DataDir to ONE long-path absolute string and use that exact string
    # everywhere (run.ps1 --dataDir -> /api/health body, the health compare, the
    # pidfile, and transitively LockfileManager's lock path). Get-Item .FullName
    # expands 8.3 short names (%TEMP% often expands to PRATY~1\...) AND normalizes
    # casing; [IO.Path]::GetFullPath does NEITHER, which would make the health
    # compare miss a healthy server and let two launches key different lock paths
    # onto one store (spec section 4.6). Create the directory first so .FullName resolves.
    param([string]$DataDir)

    if ([string]::IsNullOrWhiteSpace($DataDir)) {
        throw "-DataDir must be a non-empty path."
    }
    $abs = [System.IO.Path]::GetFullPath($DataDir)   # collapse . / .. / separators
    if (-not (Test-Path -LiteralPath $abs -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $abs | Out-Null
    }
    # .FullName on an existing dir is the long-path, case-normalized form.
    return (Get-Item -LiteralPath $abs).FullName.TrimEnd('\', '/')
}

function Get-ServeDetachedPaths {
    # All per-store artifacts namespaced under the canonical DataDir so parallel
    # agents (distinct stores) never collide and -Stop -DataDir <d> is unambiguous.
    param([string]$CanonicalDataDir)
    return [pscustomobject]@{
        DataDir = $CanonicalDataDir
        Pidfile = Join-Path $CanonicalDataDir 'serve-detached.pid'
        Log     = Join-Path $CanonicalDataDir 'serve-detached.log'
        Wrapper = Join-Path $CanonicalDataDir 'serve-detached.wrapper.ps1'
    }
}

# --- main (skipped when the script is dot-sourced for isolated testing) ---
if ($MyInvocation.InvocationName -ne '.') {
    Assert-Platform
    # Mode dispatch + mutual-exclusion are wired in Task 12.
    throw "serve-detached.ps1 main body not yet implemented."
}
