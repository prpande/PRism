#!/usr/bin/env pwsh
# Plain assertion harness for PRismLauncher.psm1 (issue #676). No Pester (repo convention;
# mirrors scripts/run-desktop.Tests.ps1). Run under BOTH hosts:
#   pwsh -NoProfile -File scripts/PRismLauncher.Tests.ps1
#   powershell.exe -NoProfile -File scripts/PRismLauncher.Tests.ps1
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'PRismLauncher.psm1') -Force

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

$lad  = [Environment]::GetFolderPath('LocalApplicationData')
$prof = [Environment]::GetFolderPath('UserProfile')
$temp = [System.IO.Path]::GetTempPath()
$repo = 'C:\some\repo\root'
$deep = Join-Path $temp 'PRism-wt-0'   # a real, deep temp store (allowed)

Write-Host "Test-SafeDeleteTarget -- run.ps1 mode (backstop + repo/temp denial, any leaf)" -ForegroundColor Cyan
$run = { param($p) Test-SafeDeleteTarget -Path $p -CheckoutBackstop -AdditionalProtectedRoots @($repo, $temp) }
Assert-True  (& $run $deep).Safe                                    "deep PRism-wt-0 temp store is safe"
Assert-Equal 'Empty'         (& $run '').Reason                     "empty -> Empty"
Assert-Equal 'NotAbsolute'   (& $run 'PRism').Reason                "relative -> NotAbsolute"
Assert-Equal 'NotAbsolute'   (& $run 'C:PRism').Reason              "drive-relative C:PRism -> NotAbsolute"
Assert-Equal 'ProtectedRoot' (& $run $prof).Reason                  "user profile -> ProtectedRoot"
Assert-Equal 'ProtectedRoot' (& $run $lad).Reason                   "%LOCALAPPDATA% root -> ProtectedRoot"
Assert-Equal 'ProtectedRoot' (& $run $repo).Reason                  "repo root (additional) -> ProtectedRoot"
Assert-Equal 'ProtectedRoot' (& $run $temp).Reason                  "%TEMP% root (additional) -> ProtectedRoot"
Assert-Equal 'TooShallow'    (& $run 'C:\PRism').Reason             "one level below root -> TooShallow"

Write-Host "Test-SafeDeleteTarget -- 5.1 regression (must NOT throw on a valid absolute path)" -ForegroundColor Cyan
# On main, run.ps1's guard calls IsPathFullyQualified here and throws under WinPS 5.1.
Assert-True  (& $run (Join-Path $lad 'PRism')).Safe                 "valid absolute path resolves without throwing (5.1-safe)"

Write-Host "Test-SafeDeleteTarget -- device-path canonicalization (#676 sec 1.2)" -ForegroundColor Cyan
Assert-Equal 'ProtectedRoot' (& $run ("\\?\" + $prof)).Reason       "\\?\<profile> canonicalized and rejected"
Assert-Equal 'ProtectedRoot' (& $run ("\\?\" + $lad)).Reason        "\\?\<localappdata> canonicalized and rejected"
Assert-Equal 'ProtectedRoot' (& $run ("\\.\" + $prof)).Reason       "\\.\<profile> (device ns) canonicalized and rejected"
Assert-Equal 'ProtectedRoot' (& $run ("\\.\" + $lad)).Reason        "\\.\<localappdata> (device ns) canonicalized and rejected"
Assert-Equal 'NotAbsolute'   (& $run '\\?\C:').Reason               "\\?\C: bare drive -> NotAbsolute, not the CWD"
Assert-Equal 'NotAbsolute'   (& $run '\\.\C:').Reason               "\\.\C: bare drive -> NotAbsolute"
Assert-Equal 'NotAbsolute'   (& $run '\??\C:\Users\x').Reason       "\??\ (NT object ns) -> NotAbsolute (rejected, not laundered)"

Write-Host "Test-SafeDeleteTarget -- run-desktop mode (-RequireLeafName 'PRism')" -ForegroundColor Cyan
Assert-True  (Test-SafeDeleteTarget -Path (Join-Path $lad 'PRism') -RequireLeafName 'PRism').Safe "LAD\PRism is safe"
Assert-Equal 'WrongLeaf' (Test-SafeDeleteTarget -Path (Join-Path $lad 'Foo') -RequireLeafName 'PRism').Reason "non-PRism leaf -> WrongLeaf"

Write-Host "Test-SafeDeleteTarget -- CheckoutBackstop" -ForegroundColor Cyan
$fake = Join-Path $temp ("PRism-t1-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path (Join-Path $fake '.git') | Out-Null
try {
    Assert-Equal 'LooksLikeCheckout' (Test-SafeDeleteTarget -Path $fake -CheckoutBackstop).Reason "dir with .git -> LooksLikeCheckout"
    Assert-True  (Test-SafeDeleteTarget -Path $fake).Safe "same dir is Safe WITHOUT -CheckoutBackstop (opt-in)"
} finally { Remove-Item -LiteralPath $fake -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host "Test-SafeDeleteTarget -- order-invariance (independent-AND invariant)" -ForegroundColor Cyan
# Use a path that is Safe base-only and made unsafe by EXACTLY ONE lever (protected-root), then
# verify adding orthogonal switches never flips it back to Safe or masks the reason. (A profile
# path would short-circuit at WrongLeaf under -RequireLeafName and never exercise the invariant --
# that is the false-passing trap.) Assert the specific Reason, not just -not .Safe.
$lever = Join-Path $temp 'PRism-order-inv'   # deep, non-existent (so no backstop I/O), leaf 'PRism-order-inv'
Assert-True  (Test-SafeDeleteTarget -Path $lever).Safe                                                                             "lever path is Safe base-only"
Assert-Equal 'ProtectedRoot' (Test-SafeDeleteTarget -Path $lever -AdditionalProtectedRoots @($lever)).Reason                      "single lever -> ProtectedRoot"
Assert-Equal 'ProtectedRoot' (Test-SafeDeleteTarget -Path $lever -AdditionalProtectedRoots @($lever) -CheckoutBackstop).Reason    "+CheckoutBackstop does not mask ProtectedRoot"
Assert-Equal 'ProtectedRoot' (Test-SafeDeleteTarget -Path $lever -AdditionalProtectedRoots @($lever) -RequireLeafName 'PRism-order-inv').Reason "+matching -RequireLeafName does not flip Safe"

if ($script:Failures -gt 0) {
    Write-Host "$script:Failures test(s) failed" -ForegroundColor Red
    exit 1
}
Write-Host "All tests passed" -ForegroundColor Green
