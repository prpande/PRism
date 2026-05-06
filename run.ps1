#!/usr/bin/env pwsh
# Build the frontend into PRism.Web/wwwroot, then launch PRism.Web.
# Pass-through args go to `dotnet run` (e.g. `./run.ps1 --no-browser`).
#
# -Reset selects an optional pre-launch local-state cleanup. Modes:
#   None  (default) -- no cleanup; identical to running without the flag.
#   Token           -- delete <dataDir>\PRism.tokens.cache. Forces Setup on next launch.
#   Auth            -- set state.json.lastConfiguredGithubHost to a sentinel host
#                     (https://prism-reset-stub.invalid) so the next launch
#                     surfaces the host-change-resolution modal. Token cache
#                     is untouched.
#   Full            -- wipe the entire <dataDir>. True first-launch reset.
#                     Caveat: on macOS / Linux the OS keychain entry survives;
#                     see the spec section 7 for the manual cleanup commands.
# See docs/superpowers/specs/2026-05-06-run-script-reset-design.md for rationale.
#
# Cross-platform note: on macOS / Linux the PAT lives in the OS keychain
# (Keychain / libsecret), not the cache file. -Reset Token deletes the file
# but does NOT clear the keychain entry on those platforms. The deferred
# in-app "Replace token" feature (S6) reuses TokenStore.ClearAsync, which
# is keychain-aware on every platform.
param(
    [ValidateSet('None', 'Token', 'Auth', 'Full')]
    [string]$Reset = 'None',

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$DotnetArgs
)

$ErrorActionPreference = 'Stop'

$dataDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PRism'

if ($Reset -ne 'None') {
    Write-Host "Reset($Reset): preparing to clean local state at $dataDir" -ForegroundColor Yellow
}

$ResetSentinelHost = 'https://prism-reset-stub.invalid'

function Write-Utf8NoBom {
    # Cross-version replacement for `Set-Content -Encoding utf8NoBOM` (PS 7+ only).
    # [System.Text.UTF8Encoding]::new($false) -> no BOM. Works in PS 5.1 (.NET
    # Framework 4.x) and PS 7+ (.NET 5+) identically.
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Remove-TokenCacheFiles {
    param([string]$DataDir)
    $tokenPath = Join-Path $DataDir 'PRism.tokens.cache'
    $previousPath = "$tokenPath.previous"
    Write-Host "  removing $tokenPath" -ForegroundColor DarkGray
    Remove-Item -LiteralPath $tokenPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $previousPath -Force -ErrorAction SilentlyContinue
}

function Set-LastConfiguredGithubHostToSentinel {
    param([string]$DataDir, [string]$Sentinel)
    $statePath = Join-Path $DataDir 'state.json'

    if (-not (Test-Path -LiteralPath $statePath)) {
        # No state.json yet -> write a fresh v1 default shape with the sentinel
        # host. Mirrors AppState.Empty in PRism.Core/State/AppState.cs.
        Write-Host "  state.json missing -- writing v1 default with sentinel host" -ForegroundColor DarkGray
        New-Item -ItemType Directory -Force $DataDir | Out-Null
        $fresh = [ordered]@{
            version = 1
            reviewSessions = @{}
            aiState = [ordered]@{ repoCloneMap = @{}; workspaceMtimeAtLastEnumeration = $null }
            lastConfiguredGithubHost = $Sentinel
        }
        Write-Utf8NoBom -Path $statePath -Text ($fresh | ConvertTo-Json -Depth 10)
        return
    }

    Write-Host "  setting state.json.lastConfiguredGithubHost = $Sentinel" -ForegroundColor DarkGray

    $raw = Get-Content -LiteralPath $statePath -Raw
    try {
        $obj = $raw | ConvertFrom-Json
    } catch {
        throw "state.json at $statePath is not valid JSON; refusing to overwrite. Repair the file by hand or use '-Reset Full' to wipe local state. Original parse error: $($_.Exception.Message)"
    }

    # Mutate the field. ConvertFrom-Json yields a PSCustomObject; if the
    # property is missing, Add-Member adds it. If present, the assignment
    # overwrites.
    if ($obj.PSObject.Properties.Name -contains 'lastConfiguredGithubHost') {
        $obj.lastConfiguredGithubHost = $Sentinel
    } else {
        $obj | Add-Member -NotePropertyName 'lastConfiguredGithubHost' -NotePropertyValue $Sentinel
    }

    Write-Utf8NoBom -Path $statePath -Text ($obj | ConvertTo-Json -Depth 10)
}

switch ($Reset) {
    'Token' {
        Remove-TokenCacheFiles -DataDir $dataDir
    }
    'Auth' {
        Set-LastConfiguredGithubHostToSentinel -DataDir $dataDir -Sentinel $ResetSentinelHost
    }
    'Full' {
        if (Test-Path -LiteralPath $dataDir) {
            Write-Host "  removing recursively: $dataDir" -ForegroundColor DarkGray
            Remove-Item -LiteralPath $dataDir -Recurse -Force
        } else {
            Write-Host "  $dataDir not present - skip" -ForegroundColor DarkGray
        }
    }
}

Push-Location $PSScriptRoot
try {
    Push-Location frontend
    try {
        # `npm ci` is deterministic (refuses to run if package.json and
        # package-lock.json drift), unlike `npm install`. Always-run also
        # avoids leaving a stale node_modules behind a lockfile change.
        npm ci
        npm run build
    } finally {
        Pop-Location
    }

    dotnet run --project PRism.Web @DotnetArgs
} finally {
    Pop-Location
}
