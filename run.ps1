#!/usr/bin/env pwsh
# Build the frontend into PRism.Web/wwwroot, then launch PRism.Web.
# Pass-through args go to `dotnet run` (e.g. `./run.ps1 --no-browser`).

$ErrorActionPreference = 'Stop'

Push-Location $PSScriptRoot
try {
    Push-Location frontend
    try {
        if (-not (Test-Path node_modules)) {
            npm install
        }
        npm run build
    } finally {
        Pop-Location
    }

    dotnet run --project PRism.Web @args
} finally {
    Pop-Location
}
