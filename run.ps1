#!/usr/bin/env pwsh
# Build the frontend into PRism.Web/wwwroot, then launch PRism.Web.
# Pass-through args go to `dotnet run` (e.g. `./run.ps1 --no-browser`).
#
# -Reset selects an optional pre-launch local-state cleanup. Modes:
#   None  (default) -- no cleanup; identical to running without the flag.
#   Token           -- delete <dataDir>\PRism.tokens.cache. Forces Setup on next launch.
#   Auth            -- set state.json.last-configured-github-host to a sentinel
#                     host (https://prism-reset-stub.invalid) so the next launch
#                     surfaces the host-change-resolution modal. Token cache is
#                     untouched. Note: keys on disk are kebab-case to match the
#                     host's KebabCaseJsonNamingPolicy (the C# record property
#                     is AppState.LastConfiguredGithubHost).
#   Full            -- wipe the entire <dataDir>. True first-launch reset.
#                     Caveat: on macOS / Linux the OS keychain entry survives;
#                     see the spec section 7 for the manual cleanup commands.
# See docs/specs/2026-05-06-run-script-reset-design.md for rationale.
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

    # PRism.Core/Json/JsonSerializerOptionsFactory.cs configures the storage
    # serializer with KebabCaseJsonNamingPolicy and PropertyNameCaseInsensitive=false,
    # so JSON property names on disk are kebab-case (e.g. last-configured-github-host).
    # Camel- or Pascal-cased keys would silently fail to bind in the host's
    # JsonSerializer.Deserialize<AppState>(...) path, leaving LastConfiguredGithubHost
    # as null and defeating the whole point of -Reset Auth.
    $hostKey = 'last-configured-github-host'

    if (-not (Test-Path -LiteralPath $statePath)) {
        # No state.json yet -> write a fresh v1 default shape with the sentinel
        # host. Mirrors AppState.Default in PRism.Core/State/AppState.cs.
        Write-Host "  state.json missing -- writing v1 default with sentinel host" -ForegroundColor DarkGray
        New-Item -ItemType Directory -Force $DataDir | Out-Null
        $fresh = [ordered]@{
            'version' = 1
            'review-sessions' = @{}
            'ai-state' = [ordered]@{
                'repo-clone-map' = @{}
                'workspace-mtime-at-last-enumeration' = $null
            }
            $hostKey = $Sentinel
        }
        Write-Utf8NoBom -Path $statePath -Text ($fresh | ConvertTo-Json -Depth 10)
        return
    }

    Write-Host "  setting state.json.$hostKey = $Sentinel" -ForegroundColor DarkGray

    $raw = Get-Content -LiteralPath $statePath -Raw
    try {
        $obj = $raw | ConvertFrom-Json
    } catch {
        throw "state.json at $statePath is not valid JSON; refusing to overwrite. Repair the file by hand or use '-Reset Full' to wipe local state. Original parse error: $($_.Exception.Message)"
    }

    # Empty/whitespace state.json: ConvertFrom-Json returns $null without
    # throwing, so the catch above does NOT fire. Treat null or non-object
    # results as "not valid JSON" and emit the same clean diagnostic.
    if ($null -eq $obj -or $obj -isnot [System.Management.Automation.PSCustomObject]) {
        throw "state.json at $statePath is not a valid JSON object (empty file or non-object root); refusing to overwrite. Repair the file by hand or use '-Reset Full' to wipe local state."
    }

    # Mutate the kebab-case field. ConvertFrom-Json yields a PSCustomObject;
    # if the property is missing (older state.json from a prior schema, or a
    # hand-edited file), Add-Member adds it. The $obj.$hostKey form below
    # uses dynamic member access — PowerShell expands the variable and
    # accepts hyphens in the resolved name (literal dotted access like
    # $obj.last-configured-github-host would parse as subtraction).
    if ($obj.PSObject.Properties.Name -contains $hostKey) {
        $obj.$hostKey = $Sentinel
    } else {
        $obj | Add-Member -NotePropertyName $hostKey -NotePropertyValue $Sentinel
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
