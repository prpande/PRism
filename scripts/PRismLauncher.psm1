#requires -Version 5.1
# Shared launcher primitives for run.ps1, scripts/serve-detached.ps1, and
# scripts/run-desktop.ps1 (issue #676). MUST stay Windows PowerShell 5.1-compatible:
# no 7-only syntax (??, ?., ternary, &&/||, $IsWindows, -Parallel). This module is a
# hard dependency of all three launchers, including run.ps1 -Reset None.

function Test-SafeDeleteTarget {
    # THE recursive-delete safety guard (was forked into run.ps1:Assert-SafeResetTarget and
    # run-desktop.ps1:Test-CleanTargetSafe). Pure predicate; callers adapt it (throw vs bool).
    # Each check is an INDEPENDENT boolean over a $resolved computed once, evaluated in a fixed
    # order that only decides which Reason surfaces first -- never whether Safe is $true. Do not
    # turn this into a short-circuit pipeline whose earlier step changes a later step's meaning.
    [CmdletBinding()]
    param(
        [string]$Path,
        [string]$RequireLeafName,
        [string[]]$AdditionalProtectedRoots,
        [switch]$CheckoutBackstop
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return [pscustomobject]@{ Safe = $false; Reason = 'Empty'; ResolvedPath = '' }
    }
    # Canonicalize away a \\?\ (extended-length) OR \\.\ (device-namespace) prefix -- incl. their
    # UNC forms -- BEFORE the absolute check and resolve. GetFullPath preserves such prefixes, so a
    # device form would string-miss the denylist below (a \\.\%LOCALAPPDATA% wipe); and stripping
    # first also stops a bare-drive remainder (\\?\C: -> C:) from laundering past the absolute gate
    # into GetFullPath('C:') (the process current directory). Strip, THEN resolve a plain absolute
    # path that .NET Framework 4.x and .NET 7 normalize identically. (#676 sec 1.2)
    $canon = $Path
    if ($canon -match '^\\\\[.?]\\UNC\\') {
        $canon = '\\' + $canon.Substring(8)   # \\?\UNC\server\share -> \\server\share
    } elseif ($canon -match '^\\\\[.?]\\') {
        $canon = $canon.Substring(4)           # \\?\C:\x or \\.\C:\x -> C:\x
    }
    # 5.1-safe absolute check on the CANONICALIZED path: drive-rooted (C:\ / C:/) or UNC (\\ / //).
    # NOT IsPathFullyQualified -- that .NET Core API throws under .NET Framework 4.x (WinPS 5.1). A
    # bare-drive remainder like 'C:' (from '\\?\C:') is rejected here rather than resolving to CWD.
    if ($canon -notmatch '^[A-Za-z]:[\\/]' -and $canon -notmatch '^[\\/][\\/]') {
        return [pscustomobject]@{ Safe = $false; Reason = 'NotAbsolute'; ResolvedPath = '' }
    }
    $resolved = [System.IO.Path]::GetFullPath($canon)

    if ($RequireLeafName -and ((Split-Path $resolved -Leaf) -ne $RequireLeafName)) {
        return [pscustomobject]@{ Safe = $false; Reason = 'WrongLeaf'; ResolvedPath = $resolved }
    }

    $trimmed = $resolved.TrimEnd('\', '/')
    $protected = @(
        [Environment]::GetFolderPath('UserProfile'),
        [Environment]::GetFolderPath('LocalApplicationData')
    )
    if ($AdditionalProtectedRoots) { $protected += $AdditionalProtectedRoots }
    $protected = @($protected | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\', '/') })
    foreach ($bad in $protected) {
        if ($trimmed.Equals($bad, [System.StringComparison]::OrdinalIgnoreCase)) {
            return [pscustomobject]@{ Safe = $false; Reason = 'ProtectedRoot'; ResolvedPath = $resolved }
        }
    }

    # Reject anything shallower than <drive>\a\b (>= 2 segments below the root). Filter empty
    # segments (doubled separators); GetFullPath already collapses those, so this is belt-and-suspenders.
    $root = [System.IO.Path]::GetPathRoot($resolved)
    $rel = $resolved.Substring($root.Length)
    $segments = @($rel -split '[\\/]' | Where-Object { $_ })
    if ($segments.Count -lt 2) {
        return [pscustomobject]@{ Safe = $false; Reason = 'TooShallow'; ResolvedPath = $resolved }
    }

    if ($CheckoutBackstop -and (Test-Path -LiteralPath $resolved -PathType Container)) {
        $isCheckout =
            (Test-Path -LiteralPath (Join-Path $resolved '.git')) -or
            (Test-Path -LiteralPath (Join-Path $resolved 'package.json')) -or
            [bool](Get-ChildItem -LiteralPath $resolved -Filter '*.sln' -File -Force -ErrorAction SilentlyContinue)
        if ($isCheckout) {
            return [pscustomobject]@{ Safe = $false; Reason = 'LooksLikeCheckout'; ResolvedPath = $resolved }
        }
    }

    return [pscustomobject]@{ Safe = $true; Reason = ''; ResolvedPath = $resolved }
}

function Write-Utf8NoBom {
    # UTF-8, no BOM. Byte-consistent across run.ps1 / serve-detached / run-desktop (#676).
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Test-OnWindows {
    # True on Windows across BOTH Windows PowerShell 5.1 and PowerShell 7+. $IsWindows is a 6+
    # automatic var (undefined under 5.1); $env:OS == 'Windows_NT' on every Windows host regardless
    # of edition, and is unset on macOS/Linux. Injectable for testing. (#676)
    param([string]$OsEnv = $env:OS)
    return $OsEnv -eq 'Windows_NT'
}

function Assert-WindowsWmi {
    # Windows + WMI preflight shared by serve-detached and run-desktop (#676). Fail fast (before a
    # multi-minute build) with a caller-specific message. Both remediations are per-caller because
    # both genuinely differ (foreground run.ps1 vs run-desktop.sh; harness-job note vs not).
    param(
        [Parameter(Mandatory)][string]$NotWindowsMessage,
        [Parameter(Mandatory)][string]$WmiUnreachableMessage
    )
    if (-not (Test-OnWindows)) { throw $NotWindowsMessage }
    try {
        $null = Get-CimClass -ClassName Win32_Process -ErrorAction Stop
    } catch {
        throw "$WmiUnreachableMessage Underlying error: $($_.Exception.Message)"
    }
}

function Invoke-Win32ProcessCreate {
    # The genuinely-shared detached-spawn core (#676): Win32_Process.Create + ReturnValue check.
    # Callers build their OWN CommandLine and (optionally) StartupInfo -- serve-detached uses a
    # bare pwsh and no startup info; run-desktop uses a full-path host and a ShowWindow=0 startup
    # instance. ReturnValue==0 only means the OS CREATED the process, not that it ran.
    param(
        [Parameter(Mandatory)][string]$CommandLine,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        $StartupInfo,
        [string]$FailureSuffix = ''
    )
    $arguments = @{ CommandLine = $CommandLine; CurrentDirectory = $WorkingDirectory }
    if ($StartupInfo) { $arguments['ProcessStartupInformation'] = $StartupInfo }
    $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $arguments
    if ($res.ReturnValue -ne 0) {
        # Base string matches both callers' current message verbatim; -FailureSuffix carries the
        # per-caller tail (serve-detached appends " The server was not launched."; run-desktop none).
        throw ("WMI Win32_Process.Create refused to spawn the wrapper (ReturnValue=$($res.ReturnValue))." + $FailureSuffix)
    }
    return [int]$res.ProcessId
}

Export-ModuleMember -Function Test-SafeDeleteTarget, Write-Utf8NoBom, Test-OnWindows, Assert-WindowsWmi, Invoke-Win32ProcessCreate
