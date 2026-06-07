#!/usr/bin/env pwsh
# Build the frontend into PRism.Web/wwwroot, then launch PRism.Web.
# Pass-through args go to the app (e.g. `./run.ps1 --no-browser`).
#
# -Port (default 5180) and -DataDir (default %LocalApplicationData%\PRism) let
# multiple agents/worktrees run the app side by side without colliding on the
# port or the data store. See .ai/docs/parallel-agent-testing.md. The launch uses
# --no-launch-profile so launchSettings.json's applicationUrl (pinned to 5180) no
# longer overrides -Port; ASPNETCORE_ENVIRONMENT is restored to Development (when
# unset) so static-web-assets serving still works -- Production via `dotnet run`
# would serve an empty SPA bundle.
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

    # Valid TCP port range. An out-of-range value (0, negative, >65535) fails
    # here at parameter binding with a clear message, instead of later inside
    # `dotnet run --urls ...` with an opaque bind error.
    [ValidateRange(1, 65535)]
    [int]$Port = 5180,

    [string]$DataDir = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PRism'),

    # Build (frontend + backend), then return WITHOUT launching. Used by
    # scripts/serve-detached.ps1 to run the build synchronously in the foreground
    # so npm/dotnet failures surface to the caller before anything detaches.
    [switch]$BuildOnly,

    # Launch WITHOUT building (assumes a current build). Used by the detached
    # wrapper, which has already had its build done in the foreground.
    [switch]$SkipBuild,

    # MUST stay last: ValueFromRemainingArguments only binds trailing app args
    # (e.g. --no-browser) correctly when it is the final parameter. (Note: a bare
    # leading `--no-browser` with no explicit -Reset still binds positionally to
    # $Reset, so callers passing pass-through args must name -Reset -- the detached
    # wrapper passes `-Reset None` for exactly this reason.)
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$DotnetArgs
)

$ErrorActionPreference = 'Stop'

if ($BuildOnly -and $SkipBuild) {
    throw "-BuildOnly and -SkipBuild are mutually exclusive: -BuildOnly builds without launching, -SkipBuild launches without building."
}

# $DataDir is the data store (default %LocalApplicationData%\PRism). Every -Reset
# helper and the launch line below operate on it. (PowerShell variable names are
# case-insensitive, so any stray $dataDir reference would resolve to this param --
# we use $DataDir throughout to avoid confusion.)

function Assert-SafeResetTarget {
    # Guard the destructive -Reset modes against a -DataDir whose recursive
    # deletion would be catastrophic. -Reset Full does `Remove-Item -Recurse
    # -Force $DataDir`; with a user-supplied path this could wipe a repo or a
    # home directory. Defense in depth -- each layer is independent:
    #   1. reject empty/whitespace.
    #   2. reject RELATIVE paths. A relative value like `.` resolves against the
    #      caller's current directory (NOT the repo, NOT $PSScriptRoot), so it is
    #      ambiguous AND dangerous -- demand an absolute path for a destructive op.
    #   3. reject a denylist of exact protected roots (repo, %USERPROFILE%,
    #      %LOCALAPPDATA%, %TEMP%) and anything too shallow to be a store.
    #   4. backstop: refuse to recurse-delete anything that looks like a source
    #      checkout (contains .git / a .sln / package.json) -- this catches a
    #      dangerous target even if layers 2-3 somehow miss it.
    # Only runs for -Reset != None, so the normal launch path is untouched.
    param([string]$DataDir)

    if ([string]::IsNullOrWhiteSpace($DataDir)) {
        throw "-Reset requires a non-empty -DataDir."
    }
    if (-not [System.IO.Path]::IsPathFullyQualified($DataDir)) {
        throw "Refusing -Reset on a non-absolute -DataDir ('$DataDir'): pass a fully-qualified path (e.g. `$env:TEMP\PRism-wt-0) so the target is unambiguous. Relative paths resolve against the current directory, not the repo."
    }

    $resolved = [System.IO.Path]::GetFullPath($DataDir)
    $denied = @(
        $PSScriptRoot,                                              # repo checkout
        [Environment]::GetFolderPath('UserProfile'),               # %USERPROFILE%
        [Environment]::GetFolderPath('LocalApplicationData'),      # %LOCALAPPDATA% itself (the \PRism child is fine)
        [System.IO.Path]::GetTempPath()                            # %TEMP% itself (a \PRism-* child is fine)
    ) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\', '/') }

    foreach ($bad in $denied) {
        if ($resolved.TrimEnd('\', '/').Equals($bad, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing -Reset on '$resolved': it is a protected location (repo root, user profile, %LOCALAPPDATA%, or %TEMP% root). Point -DataDir at a dedicated PRism store."
        }
    }

    # Reject anything shallower than <drive>\a\b (>= 2 segments below the root),
    # which blocks `C:\`, `C:\Users`, and bare drive roots from a recursive wipe.
    $root = [System.IO.Path]::GetPathRoot($resolved)
    $rel = $resolved.Substring($root.Length).Trim('\', '/')
    if ([string]::IsNullOrEmpty($rel) -or ($rel -split '[\\/]').Count -lt 2) {
        throw "Refusing -Reset on '$resolved': path is too shallow (must be at least two levels below a drive root). Point -DataDir at a dedicated PRism store."
    }

    # Backstop: never recurse-delete a directory that looks like a code checkout.
    if (Test-Path -LiteralPath $resolved -PathType Container) {
        $isCheckout =
            (Test-Path -LiteralPath (Join-Path $resolved '.git')) -or
            (Test-Path -LiteralPath (Join-Path $resolved 'package.json')) -or
            [bool](Get-ChildItem -LiteralPath $resolved -Filter '*.sln' -File -Force -ErrorAction SilentlyContinue)
        if ($isCheckout) {
            throw "Refusing -Reset on '$resolved': it looks like a source checkout (contains .git, package.json, or a .sln), not a PRism data store."
        }
    }
}

if ($Reset -ne 'None') {
    Assert-SafeResetTarget -DataDir $DataDir
    Write-Host "Reset($Reset): preparing to clean local state at $DataDir" -ForegroundColor Yellow
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

    # serve-detached.log is raw, unscrubbed dotnet/Kestrel stdout (it bypasses the
    # structured FileLoggerProvider's scrubber). Clear it alongside the token cache
    # so -Reset Token also drops any secret a console line may have printed.
    $serveLog = Join-Path $DataDir 'serve-detached.log'
    Write-Host "  removing $serveLog" -ForegroundColor DarkGray
    Remove-Item -LiteralPath $serveLog -Force -ErrorAction SilentlyContinue
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
        Remove-TokenCacheFiles -DataDir $DataDir
    }
    'Auth' {
        Set-LastConfiguredGithubHostToSentinel -DataDir $DataDir -Sentinel $ResetSentinelHost
    }
    'Full' {
        if (Test-Path -LiteralPath $DataDir) {
            Write-Host "  removing recursively: $DataDir" -ForegroundColor DarkGray
            Remove-Item -LiteralPath $DataDir -Recurse -Force
        } else {
            Write-Host "  $DataDir not present - skip" -ForegroundColor DarkGray
        }
    }
}

Push-Location $PSScriptRoot
try {
    if (-not $SkipBuild) {
        Push-Location frontend
        try {
            # `npm ci` is deterministic (refuses to run if package.json and
            # package-lock.json drift), unlike `npm install`. Always-run also
            # avoids leaving a stale node_modules behind a lockfile change.
            #
            # Guard EACH native step explicitly. Under $ErrorActionPreference='Stop'
            # a native command's nonzero exit does NOT throw, and a later step's exit
            # code OVERWRITES $LASTEXITCODE -- so a caller checking $LASTEXITCODE after
            # `run.ps1 -BuildOnly` could read 0 even though `npm ci` failed, and detach
            # against a broken build (the health-gate-timeout serve-detached.ps1 exists
            # to prevent). The per-step throw makes a mid-sequence failure abort here.
            npm ci
            if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE) -- resolve package-lock.json drift, or relaunch with -SkipBuild if the build is current." }
            npm run build
            if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)." }
        } finally {
            Pop-Location
        }
        # Build the backend explicitly so C#/NuGet/restore failures on the launch
        # path surface HERE (foreground, for -BuildOnly callers) instead of inside
        # dotnet run's implicit build post-detach. Scope: PRism.Web + its project
        # refs only -- exactly what `dotnet run --project PRism.Web` compiles, so it
        # is a no-op on the launch that follows. A compile/restore error in a project
        # PRism.Web does NOT reference (e.g. a test project) surfaces in CI, not here.
        dotnet build PRism.Web --configuration Debug
        if ($LASTEXITCODE -ne 0) { throw "dotnet build PRism.Web failed (exit $LASTEXITCODE)." }
    }

    if ($BuildOnly) { return }

    # --no-launch-profile neutralizes launchSettings.json so -Port (via --urls)
    # actually takes effect -- otherwise the http profile's applicationUrl
    # (http://localhost:5180) wins and the port arg is silently ignored. The
    # profile also set ASPNETCORE_ENVIRONMENT=Development; restore it here (only
    # when unset, so callers/CI can override) because Development is what
    # auto-enables static-web-assets serving for `dotnet run` -- Production would
    # serve the SPA bundle as empty 0-byte responses. --urls is a host arg (before
    # --); --dataDir + any pass-through args (e.g. --no-browser) are app args
    # (after --). Program.cs reads --dataDir straight from argv, order-independent.
    #
    # Scope the env var to this child like the launch profile did: set it only if
    # unset, then restore the prior value in finally so a later `dotnet test` in
    # the same shell isn't silently flipped to Development.
    $prevAspNetEnv = $env:ASPNETCORE_ENVIRONMENT
    if (-not $env:ASPNETCORE_ENVIRONMENT) { $env:ASPNETCORE_ENVIRONMENT = 'Development' }
    try {
        dotnet run --project PRism.Web --no-launch-profile --urls "http://localhost:$Port" -- --dataDir $DataDir @DotnetArgs
    } finally {
        $env:ASPNETCORE_ENVIRONMENT = $prevAspNetEnv
    }
} finally {
    Pop-Location
}
