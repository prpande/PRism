# PRismLauncher module (#676) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the four duplicated PowerShell launcher primitives into one `scripts/PRismLauncher.psm1`, imported by `run.ps1`, `scripts/serve-detached.ps1`, and `scripts/run-desktop.ps1`, fixing two latent guard bugs in the process.

**Architecture:** A single `.psm1` module exports five pure/thin functions. The two forked safe-delete guards become thin adapters over one predicate (`Test-SafeDeleteTarget`); the WMI preflight and the detached-spawn CIM core each collapse to one shared function with per-caller parameters. Behavior is preserved at every call site except two intentional guard hardenings (5.1 absolute-check + `\\?\` canonicalization).

**Tech Stack:** Windows PowerShell 5.1 **and** PowerShell 7 (dual-host); plain-assertion test harnesses (no Pester); WMI (`Win32_Process`/`Win32_ProcessStartup`) via CIM cmdlets.

**Spec:** `docs/specs/2026-07-03-676-launcher-primitives-module-design.md` (approved; `ce-doc-review` dispositions in its §9).

## Global Constraints

- **`PRismLauncher.psm1` MUST be Windows PowerShell 5.1-compatible.** No 7-only syntax: no `??`, `?.`, ternary `? :`, `&&`/`||`, `$IsWindows`, `-Parallel`, `ForEach-Object -Parallel`. It is a hard dependency of all three launchers including `run.ps1 -Reset None`.
- **Every `Import-Module` line is at the script's top level**, outside any `if ($MyInvocation.InvocationName -ne '.')` main-guard, so dot-source tests run it.
- **Absolute-path checks use the regex form, never `[IO.Path]::IsPathFullyQualified`** (throws under .NET Framework 4.x / WinPS 5.1).
- **No Pester.** New tests are plain assertion harnesses mirroring `scripts/run-desktop.Tests.ps1` (`Assert-True`/`Assert-Equal`, `$script:Failures`, non-zero exit on failure).
- **Both hosts, every harness:** validate with `pwsh -NoProfile -File <harness>` **and** `powershell.exe -NoProfile -File <harness>`.
- **Line numbers below are as of the spec baseline; locate by function name if they have shifted.**
- **Commit trailers** (every commit):
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01CtpMbBYEVQ8DtpCEibqqKT
  ```

## File Structure

- **Create** `scripts/PRismLauncher.psm1` — the shared module (5 exported functions), built up across Tasks 1–4.
- **Create** `scripts/PRismLauncher.Tests.ps1` — plain-assertion harness for the module's pure functions.
- **Modify** `run.ps1` — add the import; `Assert-SafeResetTarget` → throw-adapter; drop local `Write-Utf8NoBom`.
- **Modify** `scripts/run-desktop.ps1` — add the import; `Test-CleanTargetSafe` → bool-adapter; drop `Test-OnWindows`; `Assert-Platform` → call `Assert-WindowsWmi`; inline no-BOM writes → `Write-Utf8NoBom`; spawn → `Invoke-Win32ProcessCreate`. (`Get-PowerShellHostPath` stays.)
- **Modify** `scripts/serve-detached.ps1` — add the import; drop local `Write-Utf8NoBom`; `Assert-Platform` → call `Assert-WindowsWmi`; `Start-DetachedWrapper` → call `Invoke-Win32ProcessCreate`.
- **Modify** `scripts/run-desktop.Tests.ps1` — move the `Test-OnWindows` cases out (to the new harness); keep the 9 `Test-CleanTargetSafe` adapter cases and the `Get-PowerShellHostPath` cases.
- **Modify** `.ai/docs/development-process.md` — add `PRismLauncher.Tests.ps1` to pre-push step 7.

**Note (spec refinement):** `Test-SafeDeleteTarget` returns `{ Safe; Reason; ResolvedPath }` — the spec §3.2 lists `{ Safe; Reason }`; `ResolvedPath` is added so `run.ps1`'s adapter can reproduce its existing per-reason messages (which embed the resolved path) without re-resolving. Additive, no behavior change.

---

### Task 1: Module scaffold + `Test-SafeDeleteTarget` + guard adapters + all three imports

**Files:**
- Create: `scripts/PRismLauncher.psm1`
- Create: `scripts/PRismLauncher.Tests.ps1`
- Modify: `run.ps1` (add import after the param block; replace `Assert-SafeResetTarget` L83–139)
- Modify: `scripts/run-desktop.ps1` (add top-level import; replace `Test-CleanTargetSafe` L157–183)
- Modify: `scripts/serve-detached.ps1` (add top-level import after `$ErrorActionPreference` L48)

**Interfaces:**
- Produces: `Test-SafeDeleteTarget -Path <string> [-RequireLeafName <string>] [-AdditionalProtectedRoots <string[]>] [-CheckoutBackstop]` → `[pscustomobject]@{ Safe = <bool>; Reason = <string>; ResolvedPath = <string> }`. `Reason ∈ { '', 'Empty', 'NotAbsolute', 'WrongLeaf', 'ProtectedRoot', 'TooShallow', 'LooksLikeCheckout' }`.
- Produces: `run.ps1:Assert-SafeResetTarget -DataDir <string>` (throws on unsafe), `run-desktop.ps1:Test-CleanTargetSafe -Path <string>` → `[bool]`.

- [ ] **Step 1: Create the module with the guard predicate + export**

Create `scripts/PRismLauncher.psm1`:

```powershell
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
    # path that .NET Framework 4.x and .NET 7 normalize identically. (#676 §1.2)
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

Export-ModuleMember -Function Test-SafeDeleteTarget
```

- [ ] **Step 2: Write the failing test harness**

Create `scripts/PRismLauncher.Tests.ps1`:

```powershell
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

Write-Host "Test-SafeDeleteTarget -- device-path canonicalization (#676 §1.2)" -ForegroundColor Cyan
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
```

- [ ] **Step 3: Run the harness under both hosts, verify PASS**

Run: `pwsh -NoProfile -File scripts/PRismLauncher.Tests.ps1`
Then: `powershell.exe -NoProfile -File scripts/PRismLauncher.Tests.ps1`
Expected: both print "All tests passed", exit 0. (The `\\?\` and 5.1 cases are the ones that would fail against the pre-fix guard logic.)

- [ ] **Step 4: Add the module import to all three scripts**

In `run.ps1`, immediately after the `param( … )` block's closing `)` (before the first comment/function), add:

```powershell
Import-Module (Join-Path $PSScriptRoot 'scripts/PRismLauncher.psm1') -Force
```

In `scripts/serve-detached.ps1`, immediately after `$ErrorActionPreference = 'Stop'` (L48), add:

```powershell
Import-Module (Join-Path $PSScriptRoot 'PRismLauncher.psm1') -Force
```

In `scripts/run-desktop.ps1`, at top level after its `param(...)` block / `$ErrorActionPreference` line and BEFORE the first `function` (and outside the L364 main-guard), add:

```powershell
Import-Module (Join-Path $PSScriptRoot 'PRismLauncher.psm1') -Force
```

- [ ] **Step 5: Replace `run.ps1:Assert-SafeResetTarget` with a throw-adapter**

Replace the whole `function Assert-SafeResetTarget { … }` body (L83–139) with:

```powershell
function Assert-SafeResetTarget {
    # Throw-adapter over the shared guard (PRismLauncher.psm1:Test-SafeDeleteTarget, #676).
    # run.ps1's target is user-supplied, so: no leaf lock; deny the repo root + %TEMP% root on
    # top of the base {UserProfile, %LOCALAPPDATA%} set; and run the checkout backstop.
    param([string]$DataDir)
    $r = Test-SafeDeleteTarget -Path $DataDir -CheckoutBackstop `
        -AdditionalProtectedRoots @($PSScriptRoot, [System.IO.Path]::GetTempPath())
    if ($r.Safe) { return }
    switch ($r.Reason) {
        'Empty'       { throw "-Reset requires a non-empty -DataDir." }
        'NotAbsolute' { throw "Refusing -Reset on a non-absolute -DataDir ('$DataDir'): pass a fully-qualified path (e.g. `$env:TEMP\PRism-wt-0) so the target is unambiguous. Relative paths resolve against the current directory, not the repo." }
        'ProtectedRoot'     { throw "Refusing -Reset on '$($r.ResolvedPath)': it is a protected location (repo root, user profile, %LOCALAPPDATA%, or %TEMP% root). Point -DataDir at a dedicated PRism store." }
        'TooShallow'        { throw "Refusing -Reset on '$($r.ResolvedPath)': path is too shallow (must be at least two levels below a drive root). Point -DataDir at a dedicated PRism store." }
        'LooksLikeCheckout' { throw "Refusing -Reset on '$($r.ResolvedPath)': it looks like a source checkout (contains .git, package.json, or a .sln), not a PRism data store." }
        default             { throw "Refusing -Reset on '$($r.ResolvedPath)': failed the safe-delete guard ($($r.Reason))." }
    }
}
```

- [ ] **Step 6: Replace `run-desktop.ps1:Test-CleanTargetSafe` with a bool-adapter**

Replace the whole `function Test-CleanTargetSafe { … }` body (L157–183) with:

```powershell
function Test-CleanTargetSafe {
    # Bool-adapter over the shared guard (PRismLauncher.psm1:Test-SafeDeleteTarget, #676).
    # run-desktop's target is the COMPUTED %LOCALAPPDATA%\PRism, so lock the leaf to 'PRism';
    # no repo/temp additions and no checkout backstop (a computed path can be neither).
    param([string]$Path)
    return (Test-SafeDeleteTarget -Path $Path -RequireLeafName 'PRism').Safe
}
```

- [ ] **Step 7: Run all affected harnesses under both hosts**

Run (both hosts each):
- `pwsh -NoProfile -File scripts/PRismLauncher.Tests.ps1`
- `pwsh -NoProfile -File scripts/run-desktop.Tests.ps1`  (the 9 `Test-CleanTargetSafe` cases now exercise the adapter → predicate)
- `pwsh -NoProfile -File scripts/run.Tests.ps1`  (still green; it is AST param-block extraction and never executes `run.ps1`'s body, so the new import is invisible to it — confirm it stays green)
Repeat the three with `powershell.exe`.
Expected: all "All tests passed", exit 0.

- [ ] **Step 8: Sanity-load the scripts (no execution)**

Dot-sourcing runs a script's top-level import + function defs while the main-guard skips `Invoke-Main`. Confirm each loads cleanly:
- `run-desktop.ps1` under **both hosts** (it is 5.1-safe): `pwsh -NoProfile -Command "& { \$ErrorActionPreference='Stop'; . '$PWD/scripts/run-desktop.ps1' }"`, then the same with `powershell.exe`.
- `serve-detached.ps1` under **pwsh only** — it is `#requires -Version 7`, so dot-sourcing under `powershell.exe` 5.1 aborts on the `#requires` (by design, not a regression): `pwsh -NoProfile -Command "& { \$ErrorActionPreference='Stop'; . '$PWD/scripts/serve-detached.ps1' }"`.
- `run.ps1` has no dot-source main-guard; confirm the module imports instead, under **both hosts**: `pwsh -NoProfile -Command "Import-Module '$PWD/scripts/PRismLauncher.psm1' -Force; 'ok'"`.

Expected: each returns to the prompt / prints `ok` with no error.

- [ ] **Step 9: Commit**

```bash
git add scripts/PRismLauncher.psm1 scripts/PRismLauncher.Tests.ps1 run.ps1 scripts/run-desktop.ps1 scripts/serve-detached.ps1
git commit
```
Message: `fix(#676): unify the safe-delete guard into PRismLauncher.psm1 (5.1 + \\?\ fixes)` plus the trailers. (Use `fix` — this commit fixes the two latent guard bugs. Do not write "Fixes #676"; the issue stays open until Task 5.)

---

### Task 2: `Write-Utf8NoBom`

**Files:**
- Modify: `scripts/PRismLauncher.psm1` (add function + export)
- Modify: `scripts/PRismLauncher.Tests.ps1` (add cases)
- Modify: `run.ps1` (remove local `Write-Utf8NoBom` L148)
- Modify: `scripts/serve-detached.ps1` (remove local `Write-Utf8NoBom` L175–179)
- Modify: `scripts/run-desktop.ps1` (replace the two inline writes at L136 and L331)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Write-Utf8NoBom -Path <string> -Text <string>` (writes UTF-8 without BOM).

- [ ] **Step 1: Add the failing test**

In `scripts/PRismLauncher.Tests.ps1`, before the final `if ($script:Failures …)` footer, add:

```powershell
Write-Host "Write-Utf8NoBom" -ForegroundColor Cyan
$wf = Join-Path $temp ("PRism-utf8-" + [guid]::NewGuid().ToString('N') + ".txt")
try {
    Write-Utf8NoBom -Path $wf -Text 'hello'
    $bytes = [System.IO.File]::ReadAllBytes($wf)
    Assert-Equal 5 $bytes.Length "no BOM: 'hello' writes exactly 5 bytes"
    Assert-Equal 'h' ([char]$bytes[0]) "first byte is 'h', not a BOM"
    Assert-Equal 'hello' ([System.IO.File]::ReadAllText($wf)) "round-trips content"
} finally { Remove-Item -LiteralPath $wf -Force -ErrorAction SilentlyContinue }
```

- [ ] **Step 2: Run, verify FAIL**

Run: `pwsh -NoProfile -File scripts/PRismLauncher.Tests.ps1`
Expected: FAIL — "Write-Utf8NoBom is not recognized".

- [ ] **Step 3: Add the function to the module**

In `scripts/PRismLauncher.psm1`, above the `Export-ModuleMember` line, add:

```powershell
function Write-Utf8NoBom {
    # UTF-8, no BOM. Byte-consistent across run.ps1 / serve-detached / run-desktop (#676).
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}
```

Extend the export line:

```powershell
Export-ModuleMember -Function Test-SafeDeleteTarget, Write-Utf8NoBom
```

- [ ] **Step 4: Run, verify PASS (both hosts)**

Run: `pwsh -NoProfile -File scripts/PRismLauncher.Tests.ps1` then `powershell.exe -NoProfile -File scripts/PRismLauncher.Tests.ps1`
Expected: "All tests passed".

- [ ] **Step 5: Remove the two named copies + replace the two inline writes**

In `run.ps1`, delete the local `function Write-Utf8NoBom { … }` (L148 block). Its call sites (`Write-Utf8NoBom -Path $statePath …`) now resolve to the module function — no call-site change.

In `scripts/serve-detached.ps1`, delete the local `function Write-Utf8NoBom { … }` (L175–179). Call sites (`Write-Pidfile`, `Limit-LogSize`, `Write-WrapperScript`) are unchanged.

In `scripts/run-desktop.ps1`, replace the inline write inside `Write-LauncherPidfile` (L136):

```powershell
    Write-Utf8NoBom -Path $PidfilePath -Text "$ProcessId"
```

and the inline wrapper write (L331):

```powershell
    Write-Utf8NoBom -Path $wrapperPath -Text $wrapper
```

- [ ] **Step 6: Run the three harnesses + script-load sanity (both hosts)**

Run `scripts/PRismLauncher.Tests.ps1`, `scripts/run-desktop.Tests.ps1`, `scripts/run.Tests.ps1` under both hosts, plus the Step-8 (Task 1) dot-source sanity for `run-desktop.ps1` and `serve-detached.ps1`. Expected: all green, all load.

- [ ] **Step 7: Commit**

```bash
git add scripts/PRismLauncher.psm1 scripts/PRismLauncher.Tests.ps1 run.ps1 scripts/serve-detached.ps1 scripts/run-desktop.ps1
git commit
```
Message: `refactor(#676): share Write-Utf8NoBom via PRismLauncher.psm1` + trailers.

---

### Task 3: `Test-OnWindows` + `Assert-WindowsWmi`

**Files:**
- Modify: `scripts/PRismLauncher.psm1` (add both functions + export)
- Modify: `scripts/PRismLauncher.Tests.ps1` (add `Test-OnWindows` cases)
- Modify: `scripts/run-desktop.ps1` (remove `Test-OnWindows` L185–193; `Assert-Platform` L209–222 → call `Assert-WindowsWmi`)
- Modify: `scripts/serve-detached.ps1` (`Assert-Platform` L50–65 → call `Assert-WindowsWmi`)
- Modify: `scripts/run-desktop.Tests.ps1` (delete the `Test-OnWindows` cases L56–61 — moved)

**Interfaces:**
- Produces: `Test-OnWindows [-OsEnv <string>]` → `[bool]`; `Assert-WindowsWmi -NotWindowsMessage <string> -WmiUnreachableMessage <string>` (throws on non-Windows or unreachable WMI).

- [ ] **Step 1: Add the failing test**

In `scripts/PRismLauncher.Tests.ps1`, before the footer, add (these move from `run-desktop.Tests.ps1`):

```powershell
Write-Host "Test-OnWindows (5.1-safe platform check)" -ForegroundColor Cyan
Assert-True  (Test-OnWindows -OsEnv 'Windows_NT')    "Windows_NT -> on Windows (5.1 and 7)"
Assert-True  (-not (Test-OnWindows -OsEnv ''))       "empty OS env -> not Windows"
Assert-True  (-not (Test-OnWindows -OsEnv 'Darwin')) "non-Windows OS env -> not Windows"
Assert-True  (Test-OnWindows)                        "live host is detected as Windows"

Write-Host "Assert-WindowsWmi (message passthrough)" -ForegroundColor Cyan
$notWin = 'NOT-WINDOWS-MARKER'
try { Assert-WindowsWmi -NotWindowsMessage $notWin -WmiUnreachableMessage 'x' -ErrorAction Stop; Assert-True $true "reachable on a live Windows+WMI host" }
catch { Assert-True $false "unexpected throw on a live Windows+WMI host: $($_.Exception.Message)" }
```

(The not-Windows throw path can't be exercised on a live Windows host without faking `$env:OS`; `Test-OnWindows -OsEnv` covers the platform logic directly, and the message-passthrough is verified by reading the two converted call sites in Steps 4–5.)

- [ ] **Step 2: Run, verify FAIL**

Run: `pwsh -NoProfile -File scripts/PRismLauncher.Tests.ps1`
Expected: FAIL — "Test-OnWindows is not recognized".

- [ ] **Step 3: Add both functions to the module**

In `scripts/PRismLauncher.psm1`, above `Export-ModuleMember`, add:

```powershell
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
```

Extend the export line:

```powershell
Export-ModuleMember -Function Test-SafeDeleteTarget, Write-Utf8NoBom, Test-OnWindows, Assert-WindowsWmi
```

- [ ] **Step 4: Convert `serve-detached.ps1:Assert-Platform`**

Replace the `function Assert-Platform { … }` body (L50–65) with (preserves both original strings exactly; the function appends " Underlying error: …"):

```powershell
function Assert-Platform {
    # Windows-only by design (spec section 2); WMI-detached spawn requires Win32_Process.
    Assert-WindowsWmi `
        -NotWindowsMessage "serve-detached.ps1 is Windows-only (see spec section 2 'Out of scope: macOS / Linux'). On POSIX, setsid/nohup already survive; use run.ps1 directly." `
        -WmiUnreachableMessage "WMI (Win32_Process) is not reachable in this environment, so the detached launch cannot spawn outside the harness job object. Run run.ps1 in the foreground instead."
}
```

- [ ] **Step 5: Convert `run-desktop.ps1:Assert-Platform` and delete its `Test-OnWindows`**

Delete the `function Test-OnWindows { … }` block (L185–193) from `run-desktop.ps1` (it now comes from the module). Replace the `function Assert-Platform { … }` body (L209–222) with:

```powershell
function Assert-Platform {
    Assert-WindowsWmi `
        -NotWindowsMessage "run-desktop.ps1 is the Windows launcher. On macOS run scripts/run-desktop.sh instead." `
        -WmiUnreachableMessage "WMI (Win32_Process) is not reachable in this environment, so the detached launch cannot spawn."
}
```

- [ ] **Step 6: Delete the moved `Test-OnWindows` cases from `run-desktop.Tests.ps1`**

Remove the `Write-Host "Test-OnWindows …"` block and its four `Assert-*` lines (L56–61). Leave the `Get-PowerShellHostPath` and `Test-CleanTargetSafe` blocks in place.

- [ ] **Step 7: Run all harnesses + script-load sanity (both hosts)**

`scripts/PRismLauncher.Tests.ps1`, `scripts/run-desktop.Tests.ps1`, `scripts/run.Tests.ps1` under both hosts + the dot-source sanity for `run-desktop.ps1` / `serve-detached.ps1`. Expected: all green, all load. (This is the commit that would have broken `serve-detached` if its import weren't already added in Task 1 — confirm it loads.)

- [ ] **Step 8: Commit**

```bash
git add scripts/PRismLauncher.psm1 scripts/PRismLauncher.Tests.ps1 scripts/serve-detached.ps1 scripts/run-desktop.ps1 scripts/run-desktop.Tests.ps1
git commit
```
Message: `refactor(#676): share Test-OnWindows + Assert-WindowsWmi via PRismLauncher.psm1` + trailers.

---

### Task 4: `Invoke-Win32ProcessCreate`

**Files:**
- Modify: `scripts/PRismLauncher.psm1` (add function + export)
- Modify: `scripts/serve-detached.ps1` (`Start-DetachedWrapper` L254–269 → build command line, call the shared function)
- Modify: `scripts/run-desktop.ps1` (inline spawn L341–356 → build command line + startup info, call the shared function)

**Interfaces:**
- Produces: `Invoke-Win32ProcessCreate -CommandLine <string> -WorkingDirectory <string> [-StartupInfo <CimInstance>] [-FailureSuffix <string>]` → `[int]` process id (throws on non-zero `ReturnValue`, appending `-FailureSuffix` to the message).

- [ ] **Step 1: Add the function to the module + export**

In `scripts/PRismLauncher.psm1`, above `Export-ModuleMember`, add:

```powershell
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
```

Extend the export line:

```powershell
Export-ModuleMember -Function Test-SafeDeleteTarget, Write-Utf8NoBom, Test-OnWindows, Assert-WindowsWmi, Invoke-Win32ProcessCreate
```

- [ ] **Step 2: Convert `serve-detached.ps1:Start-DetachedWrapper`**

Replace the `function Start-DetachedWrapper { … }` body (L254–269) with (bare `pwsh` host preserved; no startup info → visible window unchanged):

```powershell
function Start-DetachedWrapper {
    # Spawn the wrapper detached via WMI so it lands OUTSIDE the harness job object (spec cause 2).
    # The CommandLine carries NO redirection -- the wrapper owns that. Bare pwsh (this script is
    # #requires -Version 7). No ShowWindow: serve-detached keeps its current window behavior (#676).
    param([string]$WrapperPath, [string]$RepoRoot)
    $cmd = "pwsh -NoProfile -ExecutionPolicy Bypass -File `"$WrapperPath`""
    return Invoke-Win32ProcessCreate -CommandLine $cmd -WorkingDirectory $RepoRoot `
        -FailureSuffix ' The server was not launched.'
}
```

- [ ] **Step 3: Convert the inline spawn in `run-desktop.ps1`**

Replace the spawn block (L341–356, from `$hostExe = Get-PowerShellHostPath` through the `Write-LauncherPidfile` call) with (full-path host + `ShowWindow=[uint16]0` preserved; `Get-PowerShellHostPath` still local to this script):

```powershell
    $hostExe = Get-PowerShellHostPath
    $cmd = "`"$hostExe`" -NoProfile -ExecutionPolicy Bypass -File `"$wrapperPath`""
    # Hide the wrapper host's console window (WmiPrvSE spawns give a fresh visible terminal;
    # CREATE_NO_WINDOW is rejected by the provider with ReturnValue=21, so ShowWindow is the lever).
    $startupInfo = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly `
        -Property @{ ShowWindow = [uint16]0 }
    $procId = Invoke-Win32ProcessCreate -CommandLine $cmd -WorkingDirectory $desktopDir -StartupInfo $startupInfo
    Write-LauncherPidfile -PidfilePath $pidfile -ProcessId $procId
```

- [ ] **Step 4: Run harnesses + script-load sanity (both hosts)**

`scripts/PRismLauncher.Tests.ps1`, `scripts/run-desktop.Tests.ps1`, `scripts/run.Tests.ps1` under both hosts + dot-source sanity. Expected: all green, all load. (`Invoke-Win32ProcessCreate` itself is intentionally not unit-tested — see the live spawn smoke in Step 5.)

- [ ] **Step 5: Live spawn smoke (`serve-detached`)**

Run (foreground, from the worktree root), on a private port/store:
```
pwsh -NoProfile -File scripts/serve-detached.ps1 -Port 5290 -DataDir $env:TEMP\PRism-676-smoke
```
Expected: emits a `{ Pid; Url; Log; DataDir; Version }` handle once `/api/health` answers (i.e. the real `Invoke-Win32ProcessCreate` spawned the wrapper). Then tear down:
```
pwsh -NoProfile -File scripts/serve-detached.ps1 -Stop -DataDir $env:TEMP\PRism-676-smoke
```
Expected: reports stopped. (If a build is needed first, drop `-SkipBuild`; the default builds.)

- [ ] **Step 6: Commit**

```bash
git add scripts/PRismLauncher.psm1 scripts/serve-detached.ps1 scripts/run-desktop.ps1
git commit
```
Message: `refactor(#676): share the Win32_Process.Create spawn core via PRismLauncher.psm1` + trailers.

---

### Task 5: Docs + close-out

**Files:**
- Modify: `.ai/docs/development-process.md` (pre-push step 7)
- Modify: `scripts/serve-detached.ps1`, `scripts/run-desktop.ps1` (refresh the stale "Mirrors …" comments)

**Interfaces:** none.

- [ ] **Step 1: Add the new harness to pre-push step 7**

In `.ai/docs/development-process.md`, in the step-7 block, add `PRismLauncher.Tests.ps1` alongside the existing two, under both hosts. Change:

```text
pwsh -File scripts/run.Tests.ps1
pwsh -File scripts/run-desktop.Tests.ps1
powershell.exe -File scripts/run.Tests.ps1   # Windows PowerShell 5.1 (Windows only)
```

to:

```text
pwsh -File scripts/PRismLauncher.Tests.ps1
pwsh -File scripts/run.Tests.ps1
pwsh -File scripts/run-desktop.Tests.ps1
powershell.exe -File scripts/PRismLauncher.Tests.ps1   # Windows PowerShell 5.1 (Windows only)
powershell.exe -File scripts/run.Tests.ps1             # Windows PowerShell 5.1 (Windows only)
```

Update the step-7 prose to mention `PRismLauncher.Tests.ps1` covers the shared launcher module.

- [ ] **Step 2: Refresh the stale cross-reference comments**

In `scripts/run-desktop.ps1` (the `New-DesktopLauncherWrapper` comment "Same technique as scripts/serve-detached.ps1:Write-WrapperScript" and the `Assert-Platform`/guard comments that said "Mirrors …") and `scripts/serve-detached.ps1`, update any comment that described a now-shared primitive as a "mirror"/"same technique as" copy to instead point at `PRismLauncher.psm1`. (Wrapper-*authoring* stays per-script — only the extracted primitives moved.)

- [ ] **Step 3: Full pre-push checklist (both hosts) + confirm no cross-tier impact**

Run the five PS-harness lines from Step 1 (both hosts). This change is PowerShell + docs only — no frontend/backend build inputs changed — so steps 1–6 of the pre-push checklist are N/A, but run them if any doubt. Expected: all harnesses green on both hosts.

- [ ] **Step 4: Commit**

```bash
git add .ai/docs/development-process.md scripts/run-desktop.ps1 scripts/serve-detached.ps1
git commit
```
Message: `docs(#676): document PRismLauncher.psm1 + refresh mirrored-primitive comments` + trailers.

---

## Self-Review

**1. Spec coverage:**
- §3.2.1 guard predicate (+ `\\?\` §1.2, 5.1 §1.1, permissive-default, independent-AND) → Task 1 Steps 1–3; adapters → Steps 5–6.
- §3.2.2 `Write-Utf8NoBom` → Task 2. §3.2.3 `Test-OnWindows` + §3.2.4 `Assert-WindowsWmi` (both messages) → Task 3. §3.2.5 `Invoke-Win32ProcessCreate` (bare pwsh / full-path host / `[uint16]0`) → Task 4.
- §3.1 imports (all three, top-level, commit 1) → Task 1 Step 4. §4 commit order → Tasks 1–5 map 1:1 to the spec's 5 commits. §5 test strategy (5.1, `\\?\`, order-invariance; spawn not unit-tested; `run.Tests.ps1` AST-based) → Tasks 1–4 tests + Task 4 Step 5 smoke. §6 validation (both hosts mandatory, `\\?\` reset refusal, serve-detached smoke, run-desktop manual) → Task 4 Step 5 + per-task both-host runs. §8 follow-ups (serve-detached ShowWindow, CI-wiring) → intentionally not implemented.
- **Gap check:** the §6 manual `run.ps1 -Reset Full` 5.1 demonstration + the `\\?\` reset-refusal smoke are validation steps, not code — they are covered by Task 1's unit tests (the same predicate) and belong in the PR `## Proof`, not a code task. No missing code task.

**2. Placeholder scan:** No TBD/TODO/"add error handling"/"similar to Task N". All code shown in full; all run commands explicit with expected output.

**3. Type consistency:** `Test-SafeDeleteTarget` returns `{ Safe; Reason; ResolvedPath }` — consumed as `.Safe` (both adapters), `.Reason` + `.ResolvedPath` (run.ps1 adapter switch), matching the produced shape. `Assert-WindowsWmi` params `-NotWindowsMessage`/`-WmiUnreachableMessage` match both call sites. `Invoke-Win32ProcessCreate -CommandLine/-WorkingDirectory/-StartupInfo` returns `[int]`, consumed by `Write-LauncherPidfile -ProcessId` (int) and `serve-detached`'s `$wrapperPid`. `Test-OnWindows -OsEnv` matches the test injection. Export list grows monotonically and includes every produced function. Consistent.

## Plan-code review (ce-doc-review) dispositions

A 4-persona pass (coherence, feasibility, security-lens, adversarial) ran against the plan's concrete code + the real scripts. Coherence and security-lens found no forcing issues; feasibility + adversarial found real bugs, all fixed here (the guard fix was **empirically re-validated on pwsh 7.5.5 and WinPS 5.1 in isolation** before locking it in):

| Finding | Reviewer | Disposition |
|---|---|---|
| `\\.\` (device namespace) bypassed the denylist → `%LOCALAPPDATA%` wipe (Safe=True on pwsh 7) — my `\\?\`-only strip missed it | adversarial (CRITICAL) | **Fixed** — strip any `^\\[.?]\\` device prefix (incl. UNC) before the absolute check; `\\.\`/`\\.\C:` tests added; validated both hosts |
| `\\?\C:` bare-drive laundered past the absolute check → `GetFullPath('C:')` = CWD → false Safe | adversarial (MED) | **Fixed** — re-run the absolute check on the *stripped* remainder; bare-drive → `NotAbsolute` |
| `Invoke-Win32ProcessCreate` throw-string silently standardized "wrapper/server"→"process" | adversarial (MED) | **Fixed** — `-FailureSuffix` param; both callers' messages byte-preserved |
| order-invariance test false-passed 2/4 cases (profile short-circuits at `WrongLeaf`) | adversarial (MED) | **Fixed** — single-lever path + `.Reason` assertions |
| Step-8 "both hosts" load-check wrong for `#requires 7` serve-detached | feasibility (LOW) | **Fixed** — serve-detached is pwsh-only for the load-check |
| §7 residual list inverted (`\??\` is rejected/safe; `\\.\` was the real gap) | adversarial | **Fixed** — spec §7 corrected |
| 8.3 short-name aliases string-miss the denylist | adversarial (advisory) | **Deferred** — needs filesystem I/O; pre-existing, fail-closed; follow-up in spec §8 |
| guard validates canonicalized path but `Remove-Item` targets raw `$DataDir` | security-lens (FYI 50) | **Deferred** — pre-existing, fail-closed under `\\?\`; follow-up in spec §8 |
