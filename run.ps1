#!/usr/bin/env pwsh
# Build the frontend into PRism.Web/wwwroot, then launch PRism.Web.
# Pass-through args go to `dotnet run` (e.g. `./run.ps1 --no-browser`).

$ErrorActionPreference = 'Stop'

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

    dotnet run --project PRism.Web @args
} finally {
    Pop-Location
}
