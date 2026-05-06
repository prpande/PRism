#!/usr/bin/env pwsh
# Build the frontend into PRism.Web/wwwroot, then launch PRism.Web.
# Pass-through args go to `dotnet run` (e.g. `./run.ps1 --no-browser`).
#
# -Reset selects an optional pre-launch local-state cleanup. Modes:
#   None  (default) — no cleanup; identical to running without the flag.
#   Token           — delete <dataDir>\PRism.tokens.cache. Forces Setup on next launch.
#   Auth            — set state.json.lastConfiguredGithubHost to a sentinel host
#                     (https://prism-reset-stub.invalid) so the next launch
#                     surfaces the host-change-resolution modal. Token cache
#                     is untouched.
#   Full            — wipe the entire <dataDir>. True first-launch reset.
#                     Caveat: on macOS / Linux the OS keychain entry survives;
#                     see the spec § 7 for the manual cleanup commands.
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

switch ($Reset) {
    'Token' {
        $tokenPath = Join-Path $dataDir 'PRism.tokens.cache'
        $previousPath = "$tokenPath.previous"
        Write-Host "  removing $tokenPath" -ForegroundColor DarkGray
        Remove-Item -LiteralPath $tokenPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $previousPath -Force -ErrorAction SilentlyContinue
    }
    'Auth' { throw "Reset(Auth) not implemented yet — see Task 3." }
    'Full' { throw "Reset(Full) not implemented yet — see Task 4." }
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
