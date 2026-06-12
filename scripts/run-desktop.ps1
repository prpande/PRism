#!/usr/bin/env pwsh
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

    Runs under the built-in Windows PowerShell (5.1) as well as PowerShell 7+ —
    no `#requires -Version 7`, no `$IsWindows` (a 6+ automatic var), and the
    detached wrapper is spawned via the SAME host that launched this script, so
    PowerShell 7 is not needed at all. A tester can paste `scripts\run-desktop.ps1`
    straight into a default Windows PowerShell prompt.
.PARAMETER SkipBuild
    Skip the build/publish steps and launch against the current desktop/.dev-sidecar/
    output. For fast re-launches once a build is current.
.PARAMETER Clean
    Wipe PRism's local state BEFORE launching, for a true first-run experience: deletes
    the entire data dir (%LOCALAPPDATA%\PRism) — drafts, view state, logs, AND the
    DPAPI-encrypted token cache, so the next launch starts at Setup. Refused while the app
    is running (close it first). A defense-in-depth guard rejects any non-PRism / shallow /
    protected delete target. Combinable with -SkipBuild.
.EXAMPLE
    scripts\run-desktop.ps1
.EXAMPLE
    scripts\run-desktop.ps1 -SkipBuild
.EXAMPLE
    scripts\run-desktop.ps1 -Clean            # fresh state, then build + launch
.EXAMPLE
    scripts\run-desktop.ps1 -Clean -SkipBuild # fresh state, then launch current build
#>
param(
    [switch]$SkipBuild,
    [switch]$Clean
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
    # The wrapper host stays alive as electron's parent, so that host is the live owner:
    # 'pwsh' when launched from PowerShell 7, 'powershell' when launched from the built-in
    # Windows PowerShell 5.1 (see Get-PowerShellHostPath). 'electron' covers the
    # macOS-style direct case / defensiveness.
    param([string]$PidfilePath, [string[]]$ExpectedNames = @('pwsh', 'powershell', 'electron'))
    if (-not (Test-Path -LiteralPath $PidfilePath)) { return $false }
    $raw = Get-Content -LiteralPath $PidfilePath -Raw -ErrorAction SilentlyContinue
    if (-not ($raw -match '^\s*(\d+)\s*$')) { return $false }
    $procId = [int]$Matches[1]
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    return $ExpectedNames -contains $p.Name
}

function Test-CleanTargetSafe {
    # Defense-in-depth guard for -Clean's recursive delete. The data dir is COMPUTED (not
    # user-supplied), but Remove-Item -Recurse is catastrophic if the path is ever empty,
    # relative, a protected root, or too shallow (e.g. GetFolderPath returning '' would make
    # the target a bare relative 'PRism'). Mirrors run.ps1:Assert-SafeResetTarget, trimmed to
    # the computed-path case. Returns $true ONLY when the path is safe to recursively delete:
    # absolute, leaf == 'PRism', not a protected root, and >=2 segments below the drive root.
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    # Absolute-path check that also works on .NET Framework 4.x (Windows PowerShell 5.1),
    # which lacks Path.IsPathFullyQualified (a .NET Core API — calling it throws under 5.1).
    # Require a drive root (C:\) or a UNC root (\\…); a bare or drive-relative path is rejected.
    if ($Path -notmatch '^[A-Za-z]:[\\/]' -and $Path -notmatch '^[\\/][\\/]') { return $false }
    $resolved = [System.IO.Path]::GetFullPath($Path)
    if ((Split-Path $resolved -Leaf) -ne 'PRism') { return $false }
    $trimmed = $resolved.TrimEnd('\', '/')
    $protected = @(
        [Environment]::GetFolderPath('UserProfile'),
        [Environment]::GetFolderPath('LocalApplicationData')
    ) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\', '/') }
    if ($protected -contains $trimmed) { return $false }
    $root = [System.IO.Path]::GetPathRoot($resolved)
    $rel = $resolved.Substring($root.Length)
    $segments = @($rel -split '[\\/]' | Where-Object { $_ })
    if ($segments.Count -lt 2) { return $false }
    return $true
}

function Test-OnWindows {
    # True when running on Windows, across BOTH Windows PowerShell 5.1 and PowerShell 7+.
    # `$IsWindows` is a 6+ automatic variable — under 5.1 it is undefined ($null), so the
    # old `-not $IsWindows` guard threw the macOS message ON Windows. `$env:OS` is
    # 'Windows_NT' on every Windows host regardless of PowerShell edition, and unset on
    # macOS/Linux, so it is the edition-agnostic signal. Injectable for testing.
    param([string]$OsEnv = $env:OS)
    return $OsEnv -eq 'Windows_NT'
}

function Get-PowerShellHostPath {
    # Full path to the PowerShell host that should run the detached wrapper. Prefer the
    # host running THIS launcher (Get-Process .Path), so a tester on Windows PowerShell
    # 5.1 spawns powershell.exe and a pwsh user spawns pwsh.exe — the wrapper itself is
    # edition-agnostic (only sets an env var, cd's, and runs electron with *>>), so either
    # host works and PowerShell 7 is NOT required. Falls back to powershell.exe (always
    # present on Windows) if the current host path can't be resolved. Injectable for tests.
    param([string]$CurrentHostPath = (Get-Process -Id $PID -ErrorAction SilentlyContinue).Path)
    if ($CurrentHostPath -and (Test-Path -LiteralPath $CurrentHostPath)) { return $CurrentHostPath }
    $fallback = Get-Command 'powershell.exe' -ErrorAction SilentlyContinue
    if ($fallback) { return $fallback.Source }
    return 'powershell.exe'
}

function Assert-Platform {
    if (-not (Test-OnWindows)) {
        throw "run-desktop.ps1 is the Windows launcher. On macOS run scripts/run-desktop.sh instead."
    }
    # The detached launch spawns via WMI (Win32_Process.Create). A locked-down sandbox
    # or container may lack WMI; probe cheaply and fail HERE (before the multi-minute
    # build) with a clear message rather than deep inside the launch with a cryptic
    # Invoke-CimMethod error. Mirrors scripts/serve-detached.ps1:Assert-Platform.
    try {
        $null = Get-CimClass -ClassName Win32_Process -ErrorAction Stop
    } catch {
        throw "WMI (Win32_Process) is not reachable in this environment, so the detached launch cannot spawn. Underlying error: $($_.Exception.Message)"
    }
}

function Assert-CommandPresent {
    param([string]$Name, [string]$Remediation)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Write-Host $Remediation -ForegroundColor Yellow
        throw "Preflight failed: '$Name' not found on PATH."
    }
}

function Invoke-Preflight {
    # Node + npm presence; .NET SDK major >= 10. On any miss, print remediation and throw.
    Assert-CommandPresent -Name 'node' -Remediation (Get-NodeRemediation)
    Assert-CommandPresent -Name 'npm'  -Remediation (Get-NodeRemediation)
    Assert-CommandPresent -Name 'dotnet' -Remediation (Get-DotnetRemediation)
    $sdks = @(& dotnet --list-sdks)
    if ($LASTEXITCODE -ne 0) {
        # dotnet is on PATH but `--list-sdks` failed (e.g. a corrupt install). Print the
        # remediation block (the preflight promises copy/paste remediation on any miss)
        # before throwing — parity with run-desktop.sh, which calls dotnet_remediation here.
        Write-Host (Get-DotnetRemediation -FoundSdks @()) -ForegroundColor Yellow
        throw "Preflight failed: 'dotnet --list-sdks' exited $LASTEXITCODE. Is the .NET install healthy?"
    }
    if (-not (Test-HasDotnetSdkAtLeast -ListSdksOutput $sdks -MinMajor 10)) {
        $majors = (Get-DotnetSdkMajors -ListSdksOutput $sdks) -join ', '
        $majorsMsg = if ($majors) { $majors } else { 'none' }
        Write-Host (Get-DotnetRemediation -FoundSdks @($sdks)) -ForegroundColor Yellow
        throw "Preflight failed: no .NET SDK with major >= 10 (found majors: $majorsMsg)."
    }
}

function Invoke-Main {
    param([switch]$SkipBuild, [switch]$Clean)
    Assert-Platform
    $repoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $desktopDir = Join-Path $repoRoot 'desktop'
    $publishDir = Join-Path $desktopDir '.dev-sidecar'
    $dataDir    = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PRism'
    $log        = Join-Path $dataDir 'run-desktop.log'
    $pidfile    = Get-LauncherPidfilePath -DataDir $dataDir

    # Detect a live instance BEFORE any cleanup — -Clean deletes the pidfile we check, so
    # the running-test must read it first. Single-instance short-circuit also lives here so a
    # re-run while the app is up doesn't rebuild into an Electron single-instance-lock no-op.
    if (Test-LauncherAlreadyRunning -PidfilePath $pidfile) {
        if ($Clean) {
            throw "PRism desktop is running; close the window before a -Clean run. Refusing to wipe $dataDir out from under a live app."
        }
        Write-Host "PRism desktop is already running (pidfile $pidfile). Close the window first; a re-run would just refocus it. Nothing rebuilt. If it is NOT running, delete that pidfile and retry." -ForegroundColor Yellow
        return
    }

    if ($Clean) {
        # True first-run reset: wipe the whole data dir (drafts, view state, logs, and the
        # DPAPI-encrypted token cache — so the next launch starts at Setup). The Windows token
        # lives in this dir, so the recursive delete fully de-authenticates (parity with the
        # macOS launcher, which additionally clears the Keychain).
        if (-not (Test-CleanTargetSafe -Path $dataDir)) {
            throw "Refusing -Clean: '$dataDir' did not pass the safe-target guard (not an absolute PRism-leaf path, at least two levels deep, outside protected user roots)."
        }
        if (Test-Path -LiteralPath $dataDir) {
            Write-Host "Clean: removing local state at $dataDir" -ForegroundColor Yellow
            Remove-Item -LiteralPath $dataDir -Recurse -Force
        } else {
            Write-Host "Clean: $dataDir not present - nothing to remove." -ForegroundColor DarkGray
        }
    }

    New-Item -ItemType Directory -Force $dataDir | Out-Null

    Invoke-Preflight

    if (-not $SkipBuild) {
        # 1. Frontend SPA -> PRism.Web/wwwroot
        Push-Location (Join-Path $repoRoot 'frontend')
        try {
            npm ci;        if ($LASTEXITCODE -ne 0) { throw "frontend npm ci failed ($LASTEXITCODE)." }
            npm run build; if ($LASTEXITCODE -ne 0) { throw "frontend npm run build failed ($LASTEXITCODE)." }
        } finally { Pop-Location }

        # 2. Sidecar: clean publish dir, then framework-dependent win-x64 publish.
        if (Test-Path -LiteralPath $publishDir) { Remove-Item -Recurse -Force $publishDir }
        dotnet publish (Join-Path $repoRoot 'PRism.Web/PRism.Web.csproj') `
            -c Release -r (Get-HostRid) --self-contained false -o $publishDir
        if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed ($LASTEXITCODE)." }

        # 3. Electron TS -> desktop/dist/main.js
        Push-Location $desktopDir
        try {
            npm ci;        if ($LASTEXITCODE -ne 0) { throw "desktop npm ci failed ($LASTEXITCODE)." }
            npm run build; if ($LASTEXITCODE -ne 0) { throw "desktop npm run build failed ($LASTEXITCODE)." }
        } finally { Pop-Location }
    }

    # 4. Resolve the published apphost + local electron shim; both must exist.
    $sidecar  = Get-SidecarApphostPath -PublishDir $publishDir
    if (-not (Test-Path -LiteralPath $sidecar)) {
        throw "Sidecar binary not found at $sidecar. Run without -SkipBuild to build it."
    }
    $electron = Join-Path $desktopDir 'node_modules\.bin\electron.cmd'
    if (-not (Test-Path -LiteralPath $electron)) {
        throw "Electron not found at $electron. Run without -SkipBuild so 'npm ci' installs it."
    }

    # 5. Author the wrapper (owns env + redirection), spawn it detached via WMI.
    $startedUtc  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $wrapperPath = Join-Path $dataDir 'run-desktop.wrapper.ps1'
    $wrapper     = New-DesktopLauncherWrapper -ElectronExe $electron -DesktopDir $desktopDir `
        -SidecarBinary $sidecar -Log $log -StartedUtc $startedUtc
    [System.IO.File]::WriteAllText($wrapperPath, $wrapper, [System.Text.UTF8Encoding]::new($false))

    # Spawn the wrapper with the SAME PowerShell host that is running this launcher, so a
    # tester on the built-in Windows PowerShell 5.1 doesn't need PowerShell 7 installed at
    # all (the wrapper is edition-agnostic). $hostExe is a full path that may contain
    # spaces (e.g. C:\Program Files\PowerShell\7\pwsh.exe), so it is quoted.
    # $wrapperPath is LocalApplicationData\PRism\run-desktop.wrapper.ps1 — a system-derived
    # path that never contains a double-quote, so wrapping it in `"..."` here is safe (same
    # assumption serve-detached.ps1 makes for its WMI command line; the wrapper's own
    # internal paths use single-quote doubling for defense in depth).
    $hostExe = Get-PowerShellHostPath
    $cmd = "`"$hostExe`" -NoProfile -ExecutionPolicy Bypass -File `"$wrapperPath`""
    # Hide the wrapper host's console window. WMI's provider host (WmiPrvSE) has no console,
    # so a console app spawned via Win32_Process.Create gets a FRESH, visible terminal that
    # lingers for the wrapper's whole life (the host stays alive as electron's parent). The
    # wrapper needs no console — its output is redirected to the log — so SW_HIDE (ShowWindow=0)
    # suppresses the stray window. (CreateFlags=CREATE_NO_WINDOW is rejected by the WMI provider
    # with ReturnValue=21, so ShowWindow is the usable lever; verified on PS 5.1 and 7.)
    $startupInfo = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly `
        -Property @{ ShowWindow = [uint16]0 }
    $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
        -Arguments @{ CommandLine = $cmd; CurrentDirectory = $desktopDir; ProcessStartupInformation = $startupInfo }
    if ($res.ReturnValue -ne 0) {
        throw "WMI Win32_Process.Create refused to spawn the wrapper (ReturnValue=$($res.ReturnValue))."
    }
    Write-LauncherPidfile -PidfilePath $pidfile -ProcessId ([int]$res.ProcessId)

    Write-Host "PRism desktop launching (detached). The window should appear shortly." -ForegroundColor Green
    Write-Host "  If it stays blank or never appears, inspect: $log" -ForegroundColor DarkGray
    Write-Host "  Close the window to stop (the sidecar shuts down with it)." -ForegroundColor DarkGray
}

# --- main (skipped when dot-sourced for isolated testing) ---
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-Main -SkipBuild:$SkipBuild -Clean:$Clean
}
