#!/usr/bin/env pwsh
# Dot-source assertion harness for run-desktop.ps1's pure functions. No Pester
# (the repo has none; only Pester 3.4.0 ships). No #requires: the script under test
# targets Windows PowerShell 5.1, so the harness must run there too — exercise it under
# both hosts: powershell.exe -File scripts/run-desktop.Tests.ps1 (5.1) and
# pwsh -File scripts/run-desktop.Tests.ps1 (7+).
$ErrorActionPreference = 'Stop'

# Dot-source the script under test. When dot-sourced, $MyInvocation.InvocationName is
# '.', so the script's main-guard (-ne '.') is false and Invoke-Main does NOT run.
# Note: dot-sourcing also runs run-desktop.ps1's param([switch]$SkipBuild) block in
# THIS scope, resetting $SkipBuild to $false — harmless here (the harness never reads
# it), but don't rely on a $SkipBuild value surviving the dot-source.
. (Join-Path $PSScriptRoot 'run-desktop.ps1')

$script:Failures = 0
function Assert-True {
    param([bool]$Cond, [string]$Msg)
    if ($Cond) { Write-Host "  PASS: $Msg" -ForegroundColor Green }
    else { Write-Host "  FAIL: $Msg" -ForegroundColor Red; $script:Failures++ }
}
function Assert-Equal {
    param($Expected, $Actual, [string]$Msg)
    Assert-True ($Expected -eq $Actual) "$Msg (expected '$Expected', got '$Actual')"
}
function Assert-Match {
    param([string]$Text, [string]$Pattern, [string]$Msg)
    Assert-True ($Text -match $Pattern) "$Msg (pattern '$Pattern' not found)"
}

Write-Host "run-desktop.ps1 unit tests" -ForegroundColor Cyan

# === test blocks are appended here by later tasks ===

Write-Host "Get-DotnetSdkMajors / Test-HasDotnetSdkAtLeast" -ForegroundColor Cyan
$sample = @(
    '8.0.404 [C:\Program Files\dotnet\sdk]',
    '10.0.100 [C:\Program Files\dotnet\sdk]'
)
$majors = Get-DotnetSdkMajors -ListSdksOutput $sample
Assert-True ($majors -contains 8)  "parses major 8"
Assert-True ($majors -contains 10) "parses major 10"
Assert-Equal 0 (Get-DotnetSdkMajors -ListSdksOutput @()).Count "empty input -> no majors"
Assert-True  (Test-HasDotnetSdkAtLeast -ListSdksOutput $sample -MinMajor 10) "has >= 10 when 10.0.100 present"
Assert-True  (-not (Test-HasDotnetSdkAtLeast -ListSdksOutput @('8.0.404 [x]') -MinMajor 10)) "no >= 10 when only 8.x"
Assert-True  (-not (Test-HasDotnetSdkAtLeast -ListSdksOutput @('garbage line') -MinMajor 10)) "non-version line ignored"

Write-Host "remediation messages" -ForegroundColor Cyan
$nodeMsg = Get-NodeRemediation
Assert-Match $nodeMsg 'winget install OpenJS\.NodeJS\.LTS' "node remediation names winget package"
Assert-Match $nodeMsg 'Node 24' "node remediation names recommended version"
$dnMsg = Get-DotnetRemediation
Assert-Match $dnMsg 'Microsoft\.DotNet\.SDK\.10' "dotnet remediation names SDK 10 winget package"
Assert-Match $dnMsg '\.NET 10' "dotnet remediation names .NET 10"

# Test-OnWindows moved to PRismLauncher.Tests.ps1 (the function now lives in the shared
# module, imported by run-desktop.ps1); its cases are exercised there. (#676)

Write-Host "Get-PowerShellHostPath (current-host spawn, no PS7 needed)" -ForegroundColor Cyan
# A resolvable host path is returned verbatim (the current pwsh/powershell that launched us).
$hostExe = Get-PowerShellHostPath
Assert-True  ([bool]$hostExe)                            "returns a non-empty host path"
Assert-True  (Test-Path -LiteralPath $hostExe)           "returned host path exists on disk"
# An injected, existing path is honored (proves it spawns the SAME host, not hardcoded pwsh).
$injected = (Get-Process -Id $PID).Path
Assert-Equal $injected (Get-PowerShellHostPath -CurrentHostPath $injected) "honors an existing injected host path"
# An unresolvable host path falls back to powershell.exe (always present on Windows) so a
# 5.1 tester never needs PowerShell 7 installed.
Assert-Match (Get-PowerShellHostPath -CurrentHostPath 'Z:\does\not\exist\nope.exe') 'powershell(\.exe)?$' "falls back to powershell.exe when host path unresolvable"

Write-Host "Test-CleanTargetSafe (-Clean recursive-delete guard)" -ForegroundColor Cyan
$lad = [Environment]::GetFolderPath('LocalApplicationData')
Assert-True  (Test-CleanTargetSafe -Path (Join-Path $lad 'PRism')) "real %LOCALAPPDATA%\PRism is a safe target"
Assert-True  (Test-CleanTargetSafe -Path 'C:\Users\me\AppData\Local\PRism') "deep PRism path is safe"
Assert-True  (-not (Test-CleanTargetSafe -Path ''))            "empty path -> unsafe"
Assert-True  (-not (Test-CleanTargetSafe -Path '   '))         "whitespace path -> unsafe"
Assert-True  (-not (Test-CleanTargetSafe -Path 'PRism'))       "relative path -> unsafe"
Assert-True  (-not (Test-CleanTargetSafe -Path 'C:\Users\me\AppData\Local\Foo')) "non-PRism leaf -> unsafe"
Assert-True  (-not (Test-CleanTargetSafe -Path 'C:\PRism'))    "too-shallow (one level below root) -> unsafe"
Assert-True  (-not (Test-CleanTargetSafe -Path $lad))          "%LOCALAPPDATA% itself -> unsafe (protected + non-PRism leaf)"
Assert-True  (-not (Test-CleanTargetSafe -Path ([Environment]::GetFolderPath('UserProfile')))) "user profile -> unsafe"

Write-Host "Get-HostRid / Get-SidecarApphostPath" -ForegroundColor Cyan
Assert-Equal 'win-x64' (Get-HostRid) "Windows RID is win-x64"
$apphost = Get-SidecarApphostPath -PublishDir 'C:\repo\desktop\.dev-sidecar'
Assert-Equal 'C:\repo\desktop\.dev-sidecar\PRism.Web.exe' $apphost "apphost is PRism.Web.exe under publish dir"

Write-Host "New-DesktopLauncherWrapper" -ForegroundColor Cyan
$wrapper = New-DesktopLauncherWrapper `
    -ElectronExe 'C:\repo\desktop\node_modules\.bin\electron.cmd' `
    -DesktopDir  'C:\repo\desktop' `
    -SidecarBinary 'C:\repo\desktop\.dev-sidecar\PRism.Web.exe' `
    -Log 'C:\data\run-desktop.log' `
    -StartedUtc '2026-06-11T00:00:00Z'
Assert-Match $wrapper "\`$env:PRISM_SIDECAR_BINARY = 'C:\\repo\\desktop\\\.dev-sidecar\\PRism\.Web\.exe'" "wrapper sets PRISM_SIDECAR_BINARY"
Assert-Match $wrapper "Set-Location 'C:\\repo\\desktop'" "wrapper cd's to desktop dir"
Assert-Match $wrapper "\*>> \`$log" "wrapper redirects electron output to log"
Assert-Match $wrapper "electron\.cmd' \." "wrapper invokes electron with ."
# Embedded single-quote in a path must be doubled (PowerShell literal escaping):
$q = New-DesktopLauncherWrapper -ElectronExe "e" -DesktopDir "d'x" -SidecarBinary "s" -Log "l" -StartedUtc "t"
Assert-Match $q "Set-Location 'd''x'" "single-quote in path is doubled"

Write-Host "pidfile guard" -ForegroundColor Cyan
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("rd-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
    $pf = Get-LauncherPidfilePath -DataDir $tmp
    Assert-Equal (Join-Path $tmp 'run-desktop.pid') $pf "pidfile path under data dir"
    Assert-True (-not (Test-LauncherAlreadyRunning -PidfilePath $pf)) "absent pidfile -> not running"
    # A pidfile naming THIS process (pwsh) with pwsh in the expected set -> running.
    Write-LauncherPidfile -PidfilePath $pf -ProcessId $PID
    $thisName = (Get-Process -Id $PID).Name
    Assert-True (Test-LauncherAlreadyRunning -PidfilePath $pf -ExpectedNames @($thisName)) "live PID with matching name -> running"
    # The DEFAULT expected set must recognize the live PowerShell host (pwsh OR powershell),
    # so the single-instance short-circuit keeps working when launched from 5.1.
    Assert-True (Test-LauncherAlreadyRunning -PidfilePath $pf) "default expected set recognizes the live host"
    # A bogus/dead PID -> not running.
    Write-LauncherPidfile -PidfilePath $pf -ProcessId 999999
    Assert-True (-not (Test-LauncherAlreadyRunning -PidfilePath $pf)) "dead PID -> not running"
    # A live PID whose name is NOT in the expected set (recycle guard) -> not running.
    Write-LauncherPidfile -PidfilePath $pf -ProcessId $PID
    Assert-True (-not (Test-LauncherAlreadyRunning -PidfilePath $pf -ExpectedNames @('definitely-not-this'))) "name mismatch -> not running (recycle guard)"
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# --- footer: exit non-zero on any failure ---
if ($script:Failures -gt 0) {
    Write-Host "$script:Failures test(s) failed" -ForegroundColor Red
    exit 1
}
Write-Host "All tests passed" -ForegroundColor Green
