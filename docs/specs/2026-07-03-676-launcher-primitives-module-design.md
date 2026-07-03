# #676 — Hoist duplicated PowerShell launcher primitives into one module

- **Issue:** [#676](https://github.com/prpande/PRism/issues/676) — `infra: hoist duplicated PowerShell launcher primitives into one dot-sourced module (the safe-delete guard has already forked)`
- **Labels:** `tech-debt`, `area:desktop`, `code-quality`, `priority:p3`
- **Classification:** gated (risk-surface — touches the destructive recursive-delete guard). Human spec + plan review retained; `ce-doc-review` is the machine pre-pass, not a substitute for the human gate.
- **Date:** 2026-07-03

## 1. Problem

Four launcher primitives are copy-pasted across `run.ps1`, `scripts/serve-detached.ps1`, and
`scripts/run-desktop.ps1`. The scripts' own comments document the copy ("Mirrors
run.ps1:Assert-SafeResetTarget", "Same technique as serve-detached.ps1:Write-WrapperScript",
"Mirrors serve-detached.ps1:Assert-Platform"). Duplication in a **launcher** is worse than usual:
these are the dev/release entry points, and one of the duplicated primitives is a
**recursive-delete safety guard**.

The guard has already forked into two names **and two implementations** with divergent behavior:

| | `run.ps1:Assert-SafeResetTarget` (L83) | `run-desktop.ps1:Test-CleanTargetSafe` (L157) |
|---|---|---|
| Target | **user-supplied** `-DataDir` (any store name) | **computed** `%LOCALAPPDATA%\PRism` |
| Shape | **throws**, rich per-failure message | **returns `[bool]`** |
| Absolute-path check | `[IO.Path]::IsPathFullyQualified(...)` | regex `^[A-Za-z]:[\\/]` / UNC `^[\\/][\\/]` |
| Leaf must equal `PRism` | no (must allow `PRism-wt-0`) | **yes** |
| Protected roots | repo, UserProfile, LocalAppData, Temp | UserProfile, LocalAppData |
| Checkout backstop (`.git`/`.sln`/`package.json`) | **yes** | no |
| Test coverage today | **none** | `run-desktop.Tests.ps1` L75–85 (9 cases) |

### 1.1 Latent bug this surfaces

`run.ps1`'s guard calls `[System.IO.Path]::IsPathFullyQualified`, a **.NET Core / .NET Standard 2.1
API that does not exist in .NET Framework 4.x**, i.e. it **throws under Windows PowerShell 5.1**.
`run-desktop.ps1`'s twin deliberately avoids it with the regex and documents why (L166–168).

Consequence: on a machine whose default PowerShell is Windows PowerShell 5.1, **`./run.ps1 -Reset
Full` (or `-Reset Token` / `-Reset Auth`) throws at the guard before doing anything**. It is latent
because the normal `-Reset None` launch path never calls the guard (`run.ps1` L141 gates on `-Reset
-ne 'None'`), and `run.ps1` has no guard tests. Unifying onto the 5.1-safe regex **fixes this bug**;
this is the one intentional behavior change in the whole refactor.

### 1.2 The other three primitives

- **No-BOM UTF-8 write** — `[IO.File]::WriteAllText(p, t, [Text.UTF8Encoding]::new($false))`.
  Byte-identical across four sites: named in `run.ps1` L148 and `serve-detached.ps1` L175; inline in
  `run-desktop.ps1` L136 and L331.
- **Windows + WMI preflight** — the `Get-CimClass Win32_Process` probe is identical
  (`serve-detached.ps1:Assert-Platform` L50, `run-desktop.ps1:Assert-Platform` L209). What differs:
  the Windows check (`serve-detached` uses `$IsWindows`; `run-desktop` uses `$env:OS -eq 'Windows_NT'`
  because it must run under 5.1) and the not-Windows remediation message ("use run.ps1" vs "use
  run-desktop.sh").
- **Detached WMI spawn** — the `Win32_Process.Create` + `ReturnValue`-check core is shared, but
  `run-desktop` (L341–356) passes a `Win32_ProcessStartup` with `ShowWindow=0` to hide the stray
  console window and resolves its host via `Get-PowerShellHostPath` (5.1-capable), whereas
  `serve-detached` (L254) sets no `ShowWindow` and hardcodes `pwsh` (it is `#requires -Version 7`).

## 2. Goals / non-goals

**Goals**
- One real implementation of each of the four primitives, in `scripts/PRismLauncher.psm1`, imported
  by all three scripts.
- **Behavior-preserving at every call site**, with the single exception of fixing the `run.ps1`
  5.1 guard bug (§1.1).
- First-ever test coverage for the `run.ps1`-mode guard, including a 5.1 regression; existing
  `run-desktop` guard/helper tests keep passing unchanged as the no-regression net.

**Non-goals**
- `scripts/run-desktop.sh` (the Bash macOS sibling) is out of scope.
- No behavior *improvements* to the individual scripts (e.g. **not** adding `ShowWindow=0` to
  `serve-detached` even though it may have a stray-window issue — that would be an unrequested
  behavior change; note it as a possible follow-up, do not do it here).
- Full `run-desktop` Electron end-to-end validation needs a published sidecar and stays **manual**
  (this is issue #369's territory); we validate everything else automatically (§6).

## 3. Design

### 3.1 Module and mechanism

New file `scripts/PRismLauncher.psm1` (the repo's first `.psm1`), ending with an explicit
`Export-ModuleMember`. Imported with `-Force` (so repeated imports in a single test session reload):

- `run.ps1` (repo root): `Import-Module (Join-Path $PSScriptRoot 'scripts/PRismLauncher.psm1') -Force`
- `scripts/serve-detached.ps1`: `Import-Module (Join-Path $PSScriptRoot 'PRismLauncher.psm1') -Force`
- `scripts/run-desktop.ps1`: `Import-Module (Join-Path $PSScriptRoot 'PRismLauncher.psm1') -Force`

Module functions are added to the session command table (not scoped like dot-source), so a script
that imports the module exposes those commands to a test that dot-sources the script — but tests
import the module **directly** rather than relying on that transitivity (§5).

### 3.2 Exported functions (6)

The four primitives plus the two support helpers they depend on (`Test-OnWindows`,
`Get-PowerShellHostPath`), which move in from `run-desktop.ps1`.

**1. `Test-SafeDeleteTarget`** — the one real guard, a pure predicate.

```
Test-SafeDeleteTarget
  -Path <string>
  [-RequireLeafName <string>]           # when set, leaf must equal it (run-desktop: 'PRism')
  [-AdditionalProtectedRoots <string[]>]# extra exact roots to deny (run.ps1: repo root, %TEMP% root)
  [-CheckoutBackstop]                   # reject a dir containing .git/package.json/*.sln (run.ps1)
  -> [pscustomobject]@{ Safe = <bool>; Reason = <string> }
```

- Base protected roots (always): `UserProfile`, `LocalApplicationData`. Callers add more via
  `-AdditionalProtectedRoots`.
- Absolute check: the **5.1-safe regex** (`^[A-Za-z]:[\\/]` or UNC `^[\\/][\\/]`), never
  `IsPathFullyQualified`.
- Shallow check: reject `< 2` segments below the drive root.
- Evaluation order: empty → not-absolute → wrong-leaf (if `-RequireLeafName`) → protected-root
  (base + additional) → too-shallow → looks-like-checkout (if `-CheckoutBackstop`).
- `Reason ∈ { 'Empty', 'NotAbsolute', 'WrongLeaf', 'ProtectedRoot', 'TooShallow',
  'LooksLikeCheckout' }`; `Safe = $true` with empty `Reason` when all pass.

This maps **exactly** onto both current contracts:
- `run.ps1` passes `-CheckoutBackstop -AdditionalProtectedRoots @($PSScriptRoot,
  [IO.Path]::GetTempPath())`, no `-RequireLeafName` → same protected set (repo + profile + LAD +
  temp), same backstop, still allows `PRism-wt-0`. Denying the *Temp root* still permits
  `$env:TEMP\PRism-wt-0` (2 segments deep), so parallel-agent testing is unaffected.
- `run-desktop` passes `-RequireLeafName 'PRism'`, no extras, no backstop → same {profile, LAD}
  protected set + leaf lock, no repo/temp/backstop checks (which it never needed on a computed path).

The **only** behavioral delta vs today is the absolute check, which fixes the 5.1 throw.

**2. `Write-Utf8NoBom -Path -Text`** — `[IO.File]::WriteAllText($Path, $Text,
[Text.UTF8Encoding]::new($false))`. Replaces all four copies.

**3. `Test-OnWindows [-OsEnv $env:OS]`** → `$OsEnv -eq 'Windows_NT'` (5.1-safe). Moved verbatim from
`run-desktop.ps1`. `serve-detached` switches from `$IsWindows` to this — behavior-identical on
Windows 7+ (and `serve-detached` is `#requires -Version 7`).

**4. `Assert-WindowsWmi -NotWindowsMessage <string>`** — `if (-not (Test-OnWindows)) { throw
$NotWindowsMessage }`, then the `Get-CimClass Win32_Process` probe with a standardized WMI-failure
throw. Each caller passes its own not-Windows message (run.ps1-foreground vs run-desktop.sh). The
WMI-failure *wording* is standardized across the two sites — an error-string-only change, not a
control-flow change.

**5. `Get-PowerShellHostPath [-CurrentHostPath ...]`** — moved verbatim from `run-desktop.ps1`
(current host path, else `powershell.exe` fallback). `serve-detached`'s spawn adopts this as the
default host; on a pwsh-7 host it resolves to the same `pwsh` executable it hardcodes today (a full
path instead of a bare name — same process).

**6. `Start-DetachedWrapper -WrapperPath -WorkingDirectory [-Hidden] [-HostExe
(Get-PowerShellHostPath)]`** → builds `"<host>" -NoProfile -ExecutionPolicy Bypass -File
"<wrapper>"`, attaches a `Win32_ProcessStartup{ ShowWindow = 0 }` **only when `-Hidden`**, calls
`Invoke-CimMethod Win32_Process.Create` with `CommandLine` + `CurrentDirectory` (+
`ProcessStartupInformation` when hidden), throws on non-zero `ReturnValue`, returns `[int]
ProcessId`.
- `serve-detached`: `Start-DetachedWrapper -WrapperPath $paths.Wrapper -WorkingDirectory $repoRoot`
  (no `-Hidden`; keeps its current visible-window behavior).
- `run-desktop`: `Start-DetachedWrapper -WrapperPath $wrapperPath -WorkingDirectory $desktopDir
  -Hidden` (keeps `ShowWindow=0`).
- Neither caller changes its pidfile handling — the function only spawns and returns the PID.

### 3.3 Call-site adapters (why the two guard names survive)

The rich per-failure throw messages in `run.ps1` are launcher-specific UX and do not belong in a
shared predicate. So each call site keeps a **thin adapter** over the one real guard:

- `run.ps1:Assert-SafeResetTarget` becomes a throw-adapter: call `Test-SafeDeleteTarget`, `switch`
  on `.Reason` to throw the existing message strings. Call site (L142) unchanged.
- `run-desktop.ps1:Test-CleanTargetSafe` becomes a bool-adapter: `return (Test-SafeDeleteTarget
  -Path $Path -RequireLeafName 'PRism').Safe`. Call site (L279) unchanged — and its existing 9 tests
  keep passing verbatim, which is the behavior-preservation proof.

One implementation, two adapters, zero call-site churn.

## 4. Commit plan

Ordered so the security-sensitive guard is isolated and reviewable on its own, per the scope
discussion on the issue:

1. **Module + guard.** Add `PRismLauncher.psm1` with `Test-SafeDeleteTarget`; convert
   `Assert-SafeResetTarget` and `Test-CleanTargetSafe` to adapters; wire the two imports. Add
   `PRismLauncher.Tests.ps1` with the guard's red→green coverage incl. the 5.1 fix; migrate the 9
   run-desktop guard cases. (This commit both unifies the guard and fixes the 5.1 bug.)
2. **`Write-Utf8NoBom`.** Move to the module; replace the two named + two inline copies; import in
   `run-desktop.ps1`. Test.
3. **`Test-OnWindows` + `Get-PowerShellHostPath` + `Assert-WindowsWmi`.** Move helpers to the module;
   convert both `Assert-Platform`s to call `Assert-WindowsWmi`; migrate their tests. Import in
   `serve-detached.ps1`.
4. **`Start-DetachedWrapper`.** Move to the module (`-Hidden`/`-WorkingDirectory`/`-HostExe`); wire
   both spawn sites. Test the arg/command-line construction and the hidden/visible `ProcessStartup`
   branch (mock `Invoke-CimMethod` — no real spawn in the unit harness).
5. **Docs.** `development-process.md` pre-push step 7 already lists the PS harnesses; add
   `PRismLauncher.Tests.ps1`. Refresh the "Mirrors …" comments that now point at the module.

Each commit keeps all three scripts loadable and all harnesses green.

## 5. Test strategy

- New `scripts/PRismLauncher.Tests.ps1` — plain assertion harness (repo convention, **no Pester**;
  mirrors `run.Tests.ps1` / `run-desktop.Tests.ps1`). Imports the module directly with
  `Import-Module … -Force`. Runs under **both** pwsh 7 and Windows PowerShell 5.1 (the guard's regex
  and the helpers are exactly where 5.1 vs 7 diverges).
- **Guard (`Test-SafeDeleteTarget`):** port the 9 run-desktop cases as the `-RequireLeafName 'PRism'`
  contract; add `run.ps1`-mode cases (`-CheckoutBackstop` + repo/temp denial, `PRism-wt-0` allowed,
  each `Reason` value); **5.1 regression** — a valid absolute path returns `Safe` under WinPS 5.1
  where main's `run.ps1` guard throws. The red proof (main's guard throwing under 5.1) is captured in
  the PR `## Proof`; the permanent green test asserts the unified predicate under both hosts.
- **Re-home** the `Test-OnWindows` / `Get-PowerShellHostPath` / guard tests from
  `run-desktop.Tests.ps1` into the new file (their functions moved). `run-desktop.Tests.ps1` keeps a
  one-line delegation smoke on `Test-CleanTargetSafe` and its script-specific tests
  (`Get-DotnetSdkMajors`, remediation).
- **`Start-DetachedWrapper`:** unit-test command-line assembly and the `-Hidden` branch by injecting
  a fake `Invoke-CimMethod` / asserting the built arguments; do **not** spawn a real detached process
  in the harness.

## 6. Validation plan

- All three harnesses (`run.Tests.ps1`, `run-desktop.Tests.ps1`, `PRismLauncher.Tests.ps1`) green
  under **pwsh 7 and `powershell.exe` 5.1**.
- `run.ps1 -Reset Full -DataDir $env:TEMP\prism-676-smoke` against a throwaway temp store proven to
  clean (not throw) under **WinPS 5.1** — the concrete 5.1-bug-fix demonstration.
- `serve-detached.ps1` headless launch + `-Stop` smoke on a private `(port, dataDir)`.
- `run-desktop.ps1` full Electron launch is **manual** (needs a published sidecar) — recorded as the
  one path not auto-validated, consistent with #369. Not a merge blocker for this refactor; the unit
  harness covers the extracted helpers.
- CI: the change is PowerShell + docs only (no C#/TS/workflow inputs), and the PS harnesses are not
  CI-wired, so CI passes trivially; correctness rests on the local both-hosts run above.

## 7. Risks & mitigations

- **Behavior drift in the extracted spawn/WMI code** (the highest-risk primitives). Mitigation:
  parameterize the divergent bits (`-Hidden`, `-HostExe`, `-NotWindowsMessage`) so each site's
  observable behavior is byte-preserved; unit-test the branch selection; keep the changes in separate
  commits.
- **`Start-DetachedWrapper` is the weakest abstraction** (three params to cover divergence). Accepted
  because the `Create` + `ReturnValue` + `ShowWindow` construction is the fiddliest copy-prone bit;
  flagged for the reviewer.
- **`Import-Module` path resolution** differs between the repo-root `run.ps1` and the `scripts/`
  scripts. Mitigation: `$PSScriptRoot`-relative import paths, verified from all three under both hosts.
- **First `.psm1` in the repo.** Mitigation: `-Force` import + direct-import tests; the existing
  dot-source test pattern is preserved for the scripts' remaining functions.

## 8. Decisions locked (owner)

- **Scope:** all four primitives in one PR (option B), with the guard isolated as commit 1.
- **Mechanism:** `.psm1` + `Import-Module` (option A).
- **Follow-up candidates (not this PR):** `serve-detached` stray-window `ShowWindow=0`; CI-wiring the
  PS harnesses (a pre-existing repo-wide gap noted on #274).
