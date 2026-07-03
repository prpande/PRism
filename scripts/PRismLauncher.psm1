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

Export-ModuleMember -Function Test-SafeDeleteTarget, Write-Utf8NoBom
