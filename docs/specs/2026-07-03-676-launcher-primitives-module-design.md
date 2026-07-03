# #676 — Hoist duplicated PowerShell launcher primitives into one module

- **Issue:** [#676](https://github.com/prpande/PRism/issues/676) — `infra: hoist duplicated PowerShell launcher primitives into one dot-sourced module (the safe-delete guard has already forked)`
- **Labels:** `tech-debt`, `area:desktop`, `code-quality`, `priority:p3`
- **Classification:** gated (risk-surface — touches the destructive recursive-delete guard). Human spec + plan review retained; `ce-doc-review` is the machine pre-pass, not a substitute for the human gate.
- **Date:** 2026-07-03
- **Review:** revised after a 5-persona `ce-doc-review` pass (coherence, feasibility, security-lens, adversarial, scope-guardian). Disposition of every finding is in §9.

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

### 1.1 Latent bug #1 — `IsPathFullyQualified` throws under WinPS 5.1

`run.ps1`'s guard calls `[System.IO.Path]::IsPathFullyQualified`, a **.NET Core / .NET Standard 2.1
API that does not exist in .NET Framework 4.x**, i.e. it **throws under Windows PowerShell 5.1**.
`run-desktop.ps1`'s twin deliberately avoids it with the regex and documents why (L166–168).

Consequence: on a machine whose default PowerShell is Windows PowerShell 5.1, **`./run.ps1 -Reset
Full` (or `-Reset Token` / `-Reset Auth`) throws at the guard before doing anything**. It is latent
because the normal `-Reset None` launch path never calls the guard (`run.ps1` L141 gates on `-Reset
-ne 'None'`), and `run.ps1` has no guard tests. Unifying onto the 5.1-safe regex fixes this.

### 1.2 Latent bug #2 — device-namespace paths (`\\?\`, `\\.\`) bypass the protected-root denylist

Surfaced by the security + adversarial reviews and **empirically confirmed on both hosts** by running
the .NET path APIs. Both guards' protected-root check is a string-equality test
(`$resolved.TrimEnd('\','/').Equals($bad, OrdinalIgnoreCase)`), and `[IO.Path]::GetFullPath` **does
not strip a `\\?\` (extended-length) or `\\.\` (device-namespace) prefix**. So
`\\.\C:\Users\<user>\AppData\Local` (and the `\\?\` form):

- passes empty-check, passes absolute-check (the UNC branch `^[\\/][\\/]` matches `\\.\…`/`\\?\…`),
- passes the too-shallow check (4 segments below the root),
- **fails to string-match** the plain `C:\Users\<user>\AppData\Local` denylist entry, and
- has no `.git`/`.sln`/`package.json` to trip the checkout backstop.

Result: `-Reset Full -DataDir '\\.\C:\Users\<user>\AppData\Local'` would `Remove-Item -Recurse
-Force` the user's **entire `%LOCALAPPDATA%`** (on pwsh 7 it fails *open* — silent wipe; on WinPS 5.1
it fails closed-but-ugly); the `\\.\C:\Users\<user>` form wipes the whole profile. Pre-existing in
both guards on `main`.

Fix: the unified predicate **strips any `\\?\`/`\\.\` device prefix (and their UNC forms) before the
absolute check + resolve**, so device forms canonicalize to their plain equivalent (caught by the
denylist) and a bare-drive remainder (`\\?\C:` → `C:`) is rejected as `NotAbsolute` rather than
resolving to the current directory. NT object paths (`\??\…`) and relative paths are already rejected
as `NotAbsolute` (they never reach `GetFullPath`). Red→green tests cover all of these on both hosts.

**These two guard fixes (§1.1, §1.2) are the only intentional behavior changes to the guard.** All
other primitive extractions are behavior-preserving (§2).

### 1.3 The other three primitives

- **No-BOM UTF-8 write** — `[IO.File]::WriteAllText(p, t, [Text.UTF8Encoding]::new($false))`.
  Byte-identical across four sites: named in `run.ps1` L148 and `serve-detached.ps1` L175; inline in
  `run-desktop.ps1` L136 and L331.
- **Windows + WMI preflight** — the `Get-CimClass Win32_Process` probe is identical
  (`serve-detached.ps1:Assert-Platform` L50, `run-desktop.ps1:Assert-Platform` L209). What differs:
  the Windows check (`serve-detached` uses `$IsWindows`; `run-desktop` uses `$env:OS -eq
  'Windows_NT'` because it must run under 5.1) and the two per-caller error messages (not-Windows
  remediation *and* WMI-unreachable remediation — see §3.2.4).
- **Detached WMI spawn** — the `Win32_Process.Create` + `ReturnValue`-check core is shared, but the
  command line and startup info diverge: `run-desktop` (L341–356) passes a `Win32_ProcessStartup`
  with `ShowWindow=[uint16]0` and resolves its host via `Get-PowerShellHostPath`; `serve-detached`
  (L262) sets no `ShowWindow` and hardcodes a bare `pwsh`. Only the `Create`+`ReturnValue` line is
  genuinely common (§3.2.5).

## 2. Goals / non-goals

**Goals**
- One real implementation of each shared primitive, in `scripts/PRismLauncher.psm1`, imported by all
  three scripts.
- **Behavior-preserving at every call site**, except these explicitly-sanctioned changes:
  1. the guard's absolute-path check (§1.1, fixes the 5.1 throw);
  2. the guard's `\\?\` canonicalization (§1.2, fixes the denylist bypass);
  3. `serve-detached`'s platform check moves from `$IsWindows` to `$env:OS -eq 'Windows_NT'` (via the
     shared `Test-OnWindows`) — identical on a well-formed Windows environment; the one narrowing is
     that `$env:OS` is user-mutable where `$IsWindows` was authoritative (§3.2.3). Accepted as
     negligible; `serve-detached` is still Windows-only.
- First-ever test coverage for the `run.ps1`-mode guard, including 5.1 and `\\?\` regressions; the
  existing `run-desktop` guard/helper tests keep passing unchanged as the no-regression net.

**Explicitly NOT changed (behavior preserved despite the extraction):**
- `serve-detached`'s spawn host stays a **bare `pwsh`** — it does *not* adopt `Get-PowerShellHostPath`
  (that would change which `pwsh` runs under a multi-install / user-PATH-only setup).
- Both callers' error strings are preserved by parameterizing *both* the not-Windows and the
  WMI-unreachable messages (§3.2.4) — no wording is silently standardized.
- `run-desktop`'s spawn keeps its full-path host and `ShowWindow=[uint16]0` startup info.

**Non-goals**
- `scripts/run-desktop.sh` (the Bash macOS sibling) is out of scope.
- No behavior *improvements* to the individual scripts (e.g. **not** adding `ShowWindow=0` to
  `serve-detached` — that would be an unrequested behavior change; note it as a possible follow-up).
- Full `run-desktop` Electron end-to-end validation needs a published sidecar and stays **manual**
  (issue #369's territory); everything else is validated automatically (§6).

## 3. Design

### 3.1 Module and mechanism

New file `scripts/PRismLauncher.psm1` (the repo's first `.psm1`), ending with an explicit
`Export-ModuleMember`. Imported with `-Force`:

- `run.ps1` (repo root): `Import-Module (Join-Path $PSScriptRoot 'scripts/PRismLauncher.psm1') -Force`
- `scripts/serve-detached.ps1`: `Import-Module (Join-Path $PSScriptRoot 'PRismLauncher.psm1') -Force`
- `scripts/run-desktop.ps1`: `Import-Module (Join-Path $PSScriptRoot 'PRismLauncher.psm1') -Force`

**Hard constraints (load-bearing — see the risks in §7):**
- **Each import is at the script's top level, outside any `if ($MyInvocation.InvocationName -ne '.')`
  main-guard**, so a test that dot-sources the script also runs the import (module commands then
  resolve). Confirmed against `run-desktop.ps1`'s main-guard at L364.
- **`PRismLauncher.psm1` MUST be Windows PowerShell 5.1-compatible** — no 7-only syntax (`??`, `?.`,
  ternary `? :`, `&&`/`||`, `$IsWindows`, `-Parallel`). It is a hard dependency of all three
  launchers, **including `run.ps1 -Reset None`** (the 99% path), which today touches none of these
  primitives. A 7-only idiom would break the common path under 5.1, and `run.Tests.ps1` cannot catch
  it (§5).

Module functions are added to the session command table (not scoped like dot-source), so an imported
script exposes them to a test that dot-sources it; tests still import the module **directly** (§5).

### 3.2 Exported functions (5)

Only the genuinely-shared code moves. `Get-PowerShellHostPath` stays in `run-desktop.ps1` (its sole
user after the spawn redesign — see §3.2.5), avoiding needless module surface.

**1. `Test-SafeDeleteTarget`** — the one real guard, a pure predicate.

```
Test-SafeDeleteTarget
  -Path <string>
  [-RequireLeafName <string>]            # when set, leaf must equal it (run-desktop: 'PRism')
  [-AdditionalProtectedRoots <string[]>] # extra exact roots to deny (run.ps1: repo root, %TEMP% root)
  [-CheckoutBackstop]                    # reject a dir containing .git/package.json/*.sln (run.ps1)
  -> [pscustomobject]@{ Safe = <bool>; Reason = <string> }
```

- **Canonicalize first:** strip a leading `\\?\` or `\\.\` device prefix (and their UNC forms) from
  the path **before** the absolute check + `GetFullPath`, so device-path forms can't dodge the
  denylist and a bare-drive remainder (`\\?\C:` → `C:`) can't launder past the absolute gate into the
  current directory (§1.2).
- Base protected roots (always): `UserProfile`, `LocalApplicationData`. Callers add more via
  `-AdditionalProtectedRoots`.
- Absolute check: the **5.1-safe regex** (`^[A-Za-z]:[\\/]` or UNC `^[\\/][\\/]`), never
  `IsPathFullyQualified`.
- Shallow check: reject `< 2` segments below the drive root, splitting on `[\\/]` and **filtering
  empty segments** (the `run-desktop` form; `GetFullPath` already collapses doubled separators, so
  this agrees with `run.ps1`'s unfiltered form in practice — the filtered form is adopted as the
  slightly stricter one).
- **Checks are independent boolean predicates over a `$resolved` computed once, ANDed together — not
  a priority pipeline.** Order determines only which `Reason` surfaces first, never whether `Safe`
  ends up `$true`. This invariant is stated in a module comment and covered by an order-invariance
  test (§5), because a future maintainer optimizing the predicate could otherwise break it silently.
- Evaluation order: empty → not-absolute → wrong-leaf (if `-RequireLeafName`) → protected-root
  (base + additional) → too-shallow → looks-like-checkout (if `-CheckoutBackstop`).
- `Reason ∈ { 'Empty', 'NotAbsolute', 'WrongLeaf', 'ProtectedRoot', 'TooShallow',
  'LooksLikeCheckout' }`; `Safe = $true` with empty `Reason` when all pass.
- **Permissive-by-default caveat:** with no narrowing switches the predicate applies only the base
  protections. Every caller must pass the switches its target demands; a future third caller that
  omits them silently gets the weakest tier. Documented at the call sites and in §7.

Maps **exactly** onto both current contracts (verified by all five reviewers), the only deltas being
§1.1 + §1.2:
- `run.ps1`: `-CheckoutBackstop -AdditionalProtectedRoots @($PSScriptRoot, [IO.Path]::GetTempPath())`,
  no `-RequireLeafName` → same protected set (repo + profile + LAD + temp), same backstop, still
  allows `PRism-wt-0`. Denying the *Temp root* still permits a real `%TEMP%\PRism-wt-0` — such a path
  is several segments below the drive root (e.g. `C:\Users\<u>\AppData\Local\Temp\PRism-wt-0`) and
  only the exact Temp *root* string is denied, so it is never blocked.
- `run-desktop`: `-RequireLeafName 'PRism'`, no extras, no backstop → same {profile, LAD} set + leaf
  lock.

**2. `Write-Utf8NoBom -Path -Text`** — `[IO.File]::WriteAllText($Path, $Text,
[Text.UTF8Encoding]::new($false))`. Replaces all four copies.

**3. `Test-OnWindows [-OsEnv $env:OS]`** → `$OsEnv -eq 'Windows_NT'` (5.1-safe). Moved verbatim from
`run-desktop.ps1`. `serve-detached` adopts it (its `Assert-Platform` becomes `Assert-WindowsWmi`),
switching from `$IsWindows` to `$env:OS` — identical on a well-formed Windows host; §2 records the
one narrowing (user-mutable env var vs authoritative automatic var).

**4. `Assert-WindowsWmi -NotWindowsMessage <string> -WmiUnreachableMessage <string>`** — `if (-not
(Test-OnWindows)) { throw $NotWindowsMessage }`, then the `Get-CimClass Win32_Process` probe, `throw
$WmiUnreachableMessage` (with the underlying error appended) on failure. **Both** messages are
per-caller parameters, because both remediations genuinely differ:
- `serve-detached`: not-Windows → "use `run.ps1` in the foreground"; WMI-unreachable → "…cannot spawn
  outside the harness job object. Run `run.ps1` in the foreground instead."
- `run-desktop`: not-Windows → "run `scripts/run-desktop.sh` instead"; WMI-unreachable → its shorter
  variant.

The two *callers* are `serve-detached.ps1` and `run-desktop.ps1` (the only scripts with a WMI
preflight); `run.ps1` has no WMI primitive and `run-desktop.sh` is out of scope.

**5. `Invoke-Win32ProcessCreate -CommandLine <string> -WorkingDirectory <string> [-StartupInfo
<CimInstance>]`** → `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
CommandLine; CurrentDirectory = $WorkingDirectory; ProcessStartupInformation = $StartupInfo (only
when provided) }`; throw on non-zero `ReturnValue`; return `[int] ProcessId`. This is the minimal
genuinely-shared core (the review rejected a `-Hidden`/`-HostExe` `Start-DetachedWrapper` as a forced
abstraction that would inject a window-hiding capability into `serve-detached` and change its host
resolution). **Each caller builds its own command line and startup info:**
- `serve-detached`: builds `"pwsh -NoProfile -ExecutionPolicy Bypass -File `"$WrapperPath`""` (bare
  `pwsh`, unchanged), calls `Invoke-Win32ProcessCreate -CommandLine $cmd -WorkingDirectory $repoRoot`
  (no `-StartupInfo`).
- `run-desktop`: builds its full-path-host command line via its own `Get-PowerShellHostPath`, builds
  `$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow =
  [uint16]0 }` (the `[uint16]` cast preserved), calls `Invoke-Win32ProcessCreate -CommandLine $cmd
  -WorkingDirectory $desktopDir -StartupInfo $startup`.
- Neither caller changes its pidfile handling.

### 3.3 Call-site adapters (why the two guard names survive)

The rich per-failure throw messages in `run.ps1` are launcher-specific UX and stay out of the shared
predicate. Each call site keeps a **thin adapter** over the one real guard:

- `run.ps1:Assert-SafeResetTarget` becomes a throw-adapter: call `Test-SafeDeleteTarget`, `switch` on
  `.Reason` to throw the existing message strings. Call site (L142) unchanged.
- `run-desktop.ps1:Test-CleanTargetSafe` becomes a bool-adapter: `return (Test-SafeDeleteTarget -Path
  $Path -RequireLeafName 'PRism').Safe`. Call site (L279) unchanged — **and its existing 9 tests keep
  passing verbatim**, which is the behavior-preservation proof for the run-desktop mode.

One implementation, two adapters, zero call-site churn.

## 4. Commit plan

Ordered so the security-sensitive guard is isolated and reviewable on its own, and so **every commit
leaves all three scripts loadable at runtime** (not merely "harnesses green" — `serve-detached` has
no harness, so all three imports land up front to avoid a silent runtime break):

1. **Module + guard + all three imports.** Add `PRismLauncher.psm1` with `Test-SafeDeleteTarget`
   (incl. the `\\?\` canonicalization and 5.1 regex); convert `Assert-SafeResetTarget` and
   `Test-CleanTargetSafe` to adapters; **add the `Import-Module` line to all three scripts now** (an
   unused import in `serve-detached`/`run-desktop` is harmless and prevents any later commit from
   referencing a moved-but-not-yet-imported helper). Add `PRismLauncher.Tests.ps1` with the guard's
   red→green coverage incl. the 5.1 and `\\?\` regressions and the order-invariance test.
2. **`Write-Utf8NoBom`.** Move to the module; replace the two named (`run.ps1`, `serve-detached.ps1`)
   + two inline (`run-desktop.ps1`) copies. Imports already present from commit 1. Test.
3. **`Test-OnWindows` + `Assert-WindowsWmi`.** Move `Test-OnWindows` to the module; add
   `Assert-WindowsWmi`; convert both `Assert-Platform`s to call it (each passing its own
   `-NotWindowsMessage` + `-WmiUnreachableMessage`). Migrate the `Test-OnWindows` tests to
   `PRismLauncher.Tests.ps1`. (`Get-PowerShellHostPath` stays in `run-desktop.ps1`.)
4. **`Invoke-Win32ProcessCreate`.** Move the CIM `Create`+`ReturnValue` core to the module; both
   spawn sites call it, each building its own command line / startup info. Not unit-tested (the CIM
   call can't be faked from a module-external scope, and the repo never unit-tested the WMI spawn —
   §5); validated by the `serve-detached` smoke + manual `run-desktop`.
5. **Docs.** `development-process.md` pre-push step 7 already lists the PS harnesses; add
   `PRismLauncher.Tests.ps1`. Refresh the "Mirrors …" comments that now point at the module.

## 5. Test strategy

- New `scripts/PRismLauncher.Tests.ps1` — plain assertion harness (repo convention, **no Pester**;
  mirrors `run.Tests.ps1` / `run-desktop.Tests.ps1`). Imports the module directly with `Import-Module
  … -Force`. Runs under **both** pwsh 7 and Windows PowerShell 5.1.
- **Guard (`Test-SafeDeleteTarget`):** `run.ps1`-mode cases (`-CheckoutBackstop` + repo/temp denial,
  `PRism-wt-0` allowed, each `Reason` value); the **5.1 regression** (a valid absolute path returns
  `Safe` under WinPS 5.1, where `main`'s `run.ps1` guard throws); the **`\\?\` regressions**
  (`\\?\C:\Users\<u>` and `\\?\C:\Users\<u>\AppData\Local` are rejected as `ProtectedRoot`); an
  **order-invariance test** (permuting the switch combinations yields the same `Safe` verdict). The
  existing 9 `run-desktop` guard cases stay in `run-desktop.Tests.ps1` (they call the adapter,
  proving no regression) — only the `Test-OnWindows` tests move here.
- **`Write-Utf8NoBom`, `Test-OnWindows`:** pure, param-injected unit tests.
- **`Assert-WindowsWmi` / `Invoke-Win32ProcessCreate`:** the CIM/`Get-CimClass` calls are **not**
  unit-tested — a plain function fake defined in the test's scope does not reach a module-internal
  cmdlet call (the reason Pester needs `InModuleScope`), and the repo has no precedent for
  shadowing a module-internal cmdlet. This matches the existing "pure helper tested, WMI spawn not"
  pattern (`New-DesktopLauncherWrapper`/`Write-WrapperScript` are tested; the actual `Create` calls
  are not). Their behavior is covered by the `serve-detached` headless smoke and the manual
  `run-desktop` launch (§6). `Test-OnWindows` (the platform half of `Assert-WindowsWmi`) is
  unit-tested independently.
- **`run.Tests.ps1` stays green for a specific reason:** it is AST param-block extraction (it grafts
  `run.ps1`'s `param` block onto a probe; it never dot-sources `run.ps1` or runs the `Import-Module`).
  Adding an import to `run.ps1`'s body can't affect it — **and therefore it cannot catch a module
  5.1-break either**, which is why the `powershell.exe`-5.1 run in §6 is mandatory, not optional.

## 6. Validation plan

- All three harnesses (`run.Tests.ps1`, `run-desktop.Tests.ps1`, `PRismLauncher.Tests.ps1`) green
  under **pwsh 7 and `powershell.exe` 5.1**. The 5.1 run is **load-bearing**: it is the only harness
  path that exercises the module under Windows PowerShell 5.1 (§5).
- `run.ps1 -Reset Full -DataDir $env:TEMP\prism-676-smoke` against a throwaway temp store proven to
  clean (not throw) under **WinPS 5.1** — the concrete §1.1 fix demonstration. Plus a manual check
  that `-Reset Full -DataDir '\\?\C:\…\prism-676-smoke-devpath'` is **refused** — the §1.2 fix.
- `serve-detached.ps1` headless launch + `-Stop` smoke on a private `(port, dataDir)` — exercises the
  real `Invoke-Win32ProcessCreate` spawn.
- `run-desktop.ps1` full Electron launch is **manual** (needs a published sidecar), consistent with
  #369. Not a merge blocker; the unit harness covers the extracted pure helpers.
- CI: PowerShell + docs only (no C#/TS/workflow inputs), PS harnesses not CI-wired, so CI passes
  trivially; correctness rests on the local both-hosts run above.

## 7. Risks & mitigations

- **Device-namespace denylist bypass (§1.2)** was catastrophic and latent (`\\.\%LOCALAPPDATA%` wiped
  the whole store; `\\?\` likewise). Mitigation: strip any `\\?\`/`\\.\` prefix (incl. UNC) before
  resolving + explicit rejection tests for both, plus the bare-drive (`\\?\C:`) and `\??\` cases, on
  both hosts. Residual: **8.3 short-name aliases** of a protected root (e.g. `PRATYU~1`) still
  string-miss the denylist because `GetFullPath` does not expand them — closing this needs a
  filesystem `Get-Item .FullName` expansion (I/O on a possibly-nonexistent path), so it is deferred to
  a follow-up (§8) to keep the predicate pure. Pre-existing in both guards; fail-closed for a
  nonexistent alias.
- **The module is a 5.1-compatibility surface and a single point of failure** now hard-depended on by
  `run.ps1 -Reset None` (which used zero primitives before). Mitigation: the §3.1 5.1-compat
  invariant + the mandatory `powershell.exe`-5.1 harness run (§6). Accepted residual: a partial/sparse
  checkout that excludes `scripts/` now breaks `run.ps1` even for `-Reset None`; the repo ships the
  scripts together, so standalone `run.ps1` extraction is unsupported.
- **`Test-SafeDeleteTarget` defaults to minimum protection.** Mitigation: the permissive-default
  caveat is documented at both call sites and here; the order-invariance test also pins the
  independent-AND invariant so a future refactor can't silently turn it into a fail-open pipeline.
- **Behavior drift in the extracted platform/spawn code.** Mitigation: parameterize the divergent
  bits (`-NotWindowsMessage`, `-WmiUnreachableMessage`, per-caller command line + startup info); keep
  `serve-detached`'s bare `pwsh` host and no-hidden-window behavior; unit-test what's pure, smoke the
  rest.
- **First `.psm1` in the repo / import-path resolution** (repo-root `run.ps1` vs `scripts/` scripts).
  Mitigation: `$PSScriptRoot`-relative import paths, top-level imports, verified from all three under
  both hosts.

## 8. Decisions locked (owner)

- **Scope:** all four primitives in one PR (option B), with the guard isolated as commit 1.
- **Mechanism:** `.psm1` + `Import-Module` (option A).
- **`\\?\` denylist hardening (§1.2): owner-approved 2026-07-03, in scope.** A scope expansion beyond
  "de-dup + the 5.1 fix", but it sits on the exact destructive-delete surface this PR hardens and is
  fixed once for both callers.
- **Follow-up candidates (not this PR):** `serve-detached` stray-window `ShowWindow=0`; CI-wiring the
  PS harnesses (a pre-existing repo-wide gap noted on #274); **8.3 short-name denylist expansion** in
  the guard (§7 — needs filesystem I/O; pre-existing, low-severity, fail-closed); and the guard
  validating the *canonicalized* path while `Remove-Item` targets the raw `$DataDir` (a `\\?\`+`..`
  combo could theoretically diverge — pre-existing, fail-closed since Windows disables `..` under a
  `\\?\` prefix).

## 9. `ce-doc-review` findings & dispositions

| # | Reviewer(s) | Finding | Disposition |
|---|---|---|---|
| 1 | feasibility (F1), adversarial (F3), scope-guardian | "Inject a fake `Invoke-CimMethod`" can't work from module-external scope; `Start-DetachedWrapper` with `-Hidden`/`-HostExe` is a forced abstraction | **Applied** — replaced with minimal `Invoke-Win32ProcessCreate`; spawn not unit-tested (§3.2.5, §5) |
| 2 | feasibility (F2), adversarial (F1) | Commit 2 deletes `serve-detached`'s `Write-Utf8NoBom` before its import (commit 3) → silent runtime break (no serve-detached harness) | **Applied** — all three imports moved into commit 1 (§4) |
| 3 | security (F1) | `\\?\` device paths bypass the protected-root denylist → whole-`%LOCALAPPDATA%`/profile wipe | **Applied** — canonicalize prefix + tests (§1.2, §3.2.1); flagged for owner sign-off (§8) |
| 4 | adversarial (F2), scope-guardian | `serve-detached` host `pwsh`→`Get-PowerShellHostPath` is a real behavior change, not "same process" | **Applied** — `serve-detached` keeps bare `pwsh`; `Get-PowerShellHostPath` stays in `run-desktop` (§2, §3.2.5) |
| 5 | adversarial (F4), scope-guardian | Standardizing the WMI-unreachable message drops caller-specific remediation | **Applied** — parameterized `-WmiUnreachableMessage` too (§3.2.4) |
| 6 | coherence, scope-guardian | §3.2 phrasing named `run.ps1` / out-of-scope `run-desktop.sh` as the WMI callers | **Applied** — corrected to `serve-detached.ps1` / `run-desktop.ps1` (§3.2.4) |
| 7 | adversarial (F5), feasibility | Module is a 5.1-compat SPOF that `run.ps1 -Reset None` now hard-depends on; `run.Tests.ps1` can't catch a module 5.1-break | **Applied** — §3.1 invariant + §5 explanation + §6 mandatory 5.1 run + §7 risk |
| 8 | scope-guardian | §2 "single exception" undercounts disclosed deltas | **Applied** — §2 rewritten to enumerate all sanctioned changes |
| 9 | security (F2) + threat item 3 | Predicate permissive-by-default; independent-AND invariant unstated | **Applied** — caveat + module comment + order-invariance test (§3.2.1, §5, §7) |
| 10 | adversarial (F3 tail) | `ShowWindow = 0` shorthand drops the `[uint16]` cast | **Applied** — cast preserved (§3.2.5) |
| 11 | security (minor) | §3.2 "2 segments deep" arithmetic wrong (measured from drive root) | **Applied** — corrected (§3.2.1) |
| 12 | adversarial (F6) | `$IsWindows`→`$env:OS` downgrades authoritative→mutable; "behavior-identical" overstates | **Applied** — claim softened, narrowing noted (§2, §3.2.3) |
| 13 | feasibility (minor), adversarial | Too-shallow empty-segment filtering differs (moot post-`GetFullPath`) | **Applied** — unified on the filtered form (§3.2.1) |
| 14 | adversarial (holds) | `run.Tests.ps1` staying green is asserted but unexplained | **Applied** — explanation added (§5) |
| 15 | adversarial (F7) | Ship the 5.1 fix as a separate PR to shrink the risky diff | **Skipped** — the fix *is* the regex in the unified predicate; severing means writing it twice (throwaway inline, then adapter) = more churn on the risky path. Owner locked scope B; commit-1 already isolates the guard |
| 16 | scope-guardian (FYI) | Bundling the guard with 3 mechanical extracts dilutes review | **Acknowledged** — owner-locked (B); mitigated by commit-1 isolation (§4) |
