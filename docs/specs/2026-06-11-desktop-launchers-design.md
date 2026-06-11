# Desktop launchers: clone-and-run the Electron app standalone (detached) — design

**Issue:** #306
**Date:** 2026-06-11
**Status:** Design — pending human review

## 1. Goal

Give testers a **one-command** way to run the PRism desktop (Electron) experience
**after cloning the repository**, on **Windows and macOS**. Running the launcher
builds everything from source and brings up the desktop app **detached**, so the
terminal the script was invoked from is freed once the build completes and the app
is launched, after which the app stands on its own — as close as possible to how
the tool will feel once it is an installed product, without requiring a
packaging/install step. (The hand-off is detached, not instant: the build runs
synchronously first; see §5 and the `-SkipBuild` escape hatch in §10/§11.)

The window that comes up is the real `desktop/src/main.ts` / `BrowserWindow`, so
it is runtime-identical to the eventual shipped app.

## 2. Audience and non-goals

**Audience:** testers (technical enough to install an SDK if prompted) who have a
fresh clone and want to *run the app*, not validate the installer.

**Non-goals (explicitly out of this slice):**

- The `run.ps1 -Mode Desktop` **foreground dev-loop switch** from the first half
  of #306. Deferred; may become a follow-up if a fast foreground inner-loop is
  wanted later. This slice delivers the standalone testers' path only.
- **Packaging / installer fidelity** (electron-builder `.dmg` / NSIS, Gatekeeper
  install flow, Dock/Start-menu entry). `npm run dist` already produces installable
  artifacts for the day the *installer itself* needs testing. Cloning-then-running
  signals "run the app", not "exercise the installer", so from-source is the right
  fidelity level.
- **Shipping prebuilt binaries** in git (the ~80 MB-per-platform decision the issue
  flags). The launcher builds from source; it does not commit or fetch binaries.

## 3. Deliverables

- `scripts/run-desktop.ps1` — Windows launcher.
- `scripts/run-desktop.sh` — macOS launcher (`chmod +x`; documented as terminal-run;
  a `.command` rename for Finder double-click is a possible nicety, not required).
- `desktop/README.md` — documents both launchers, the toolchain prerequisites, the
  macOS Gatekeeper caveat, and the relationship to (deferred) `run.ps1 -Mode Desktop`.
- `.gitignore` entry for the dev sidecar publish dir (`desktop/.dev-sidecar/`), kept
  **separate** from the electron-builder `desktop/sidecar/` packaging dir. The
  separation is deliberate, not cosmetic: `electron-builder.yml` copies
  `desktop/sidecar/` verbatim into the package via `extraResources`, and the dev
  launcher's output is *framework-dependent* and named `PRism.Web.exe`, whereas a
  shippable package needs the *self-contained*, CI-renamed `PRism-<rid>` artifact.
  Publishing the dev sidecar into `desktop/sidecar/` would let a later `npm run dist`
  (run without the CI publish+rename step) package a broken sidecar. A distinct dir
  removes that contamination path.

The two scripts are **parallel implementations** of the same pipeline in two
languages (PowerShell, bash). No code is shared across them; they are kept
behaviorally aligned by this spec. This mirrors the existing precedent where
`scripts/serve-detached.ps1` is Windows-specific.

## 4. Preflight with remediation (runs first; builds nothing on a miss)

The launcher's **first** job is to verify the build infrastructure. On any miss it
prints OS-specific, copy-pasteable remediation and **exits non-zero without
building**.

Checks:

- **Node + npm** — presence check (`node`/`npm` resolve on `PATH`). The repo pins no
  `engines` field, `.nvmrc`, or `global.json`, so there is **no authoritative Node
  minimum** to gate on; CI builds on Node 24, which the remediation text surfaces as
  the recommended version rather than a hard gate. A "node not found" miss is the
  realistic failure for this audience, not a too-old-version miss.
- **.NET SDK** — parse `dotnet --list-sdks` and require at least one SDK whose **major
  version is ≥ 10** (the solution targets `net10.0`; a 10.x SDK is required to publish
  it — verified against every csproj and the `10.0.x` pin in CI). A missing `dotnet`,
  or only SDKs below major 10, is a miss: print the remediation and exit non-zero with
  a message naming the SDK versions found (if any) and the required major.

Remediation copy (examples; the script prints the block matching the host OS):

- **Windows:** `winget install OpenJS.NodeJS.LTS`, `winget install Microsoft.DotNet.SDK.10`
  (plus the official download URLs as a fallback for machines without winget).
- **macOS:** `brew install node`, `brew install --cask dotnet-sdk` (verify it provides a
  .NET 10 SDK; otherwise the official .NET 10 installer) — plus the official download
  URLs as a fallback for machines without Homebrew.

This is the "check the needed infrastructure and SDK, and tell the user how to fix
a miss" requirement from the issue, realized as a gating preflight.

## 5. Build pipeline (identical logic, two languages)

Run only after preflight passes:

1. **Frontend SPA** — `npm ci && npm run build` in `frontend/`. Outputs the SPA into
   `PRism.Web/wwwroot`.
2. **Sidecar** — `dotnet publish PRism.Web` for the **host RID**, **framework-dependent**
   (`--self-contained false`), Release configuration, into `desktop/.dev-sidecar/`.
   - **Clear `desktop/.dev-sidecar/` before publishing.** `dotnet publish` overlays its
     output rather than cleaning it, so a stale binary or a wrong-arch artifact from a
     prior run (e.g. after an `arm64`↔`x64` host change, or a renamed leftover) could
     shadow the fresh output and `PRISM_SIDECAR_BINARY` could point into a mixed tree.
     A clean publish dir keeps the "always build = always fresh" guarantee honest.
   - Host RID: Windows → `win-x64`; macOS → `osx-arm64` or `osx-x64`, detected via
     `uname -m` (`arm64` → `osx-arm64`, `x86_64` → `osx-x64`).
3. **Electron shell** — `npm ci && npm run build` in `desktop/` (tsc → `dist/main.js`).
4. **Wire the sidecar** — set `PRISM_SIDECAR_BINARY` to the published apphost in
   `desktop/.dev-sidecar/` (`PRism.Web.exe` on Windows, `PRism.Web` on macOS — the
   apphost name from the csproj assembly name, **not** the renamed `PRism-<rid>`
   artifact that the packaging path produces).

**Why publish, not a raw Debug exe:** a *published* ASP.NET app lays a **physical
`wwwroot`** down next to the binary. The sidecar pins its cwd to the binary's
directory and serves the SPA from `{cwd}/wwwroot/index.html`
(`desktop/src/sidecar.ts:planSpawn`), and spawns the backend with a minimal env
that has **no** `ASPNETCORE_ENVIRONMENT`, so it runs in Production. A raw
`dotnet build` Debug exe has no physical `wwwroot` beside it and would rely on the
Development static-web-assets manifest — which is off in Production — yielding a
**blank SPA**. Publishing sidesteps this entirely: physical `wwwroot`, served in
Production exactly as the shipped app does.

**Why framework-dependent (not self-contained):** the preflight has already
confirmed the .NET SDK (hence the runtime) is present, so the runtime dependency
is satisfied. Framework-dependent publish is small and fast and avoids both the
~80 MB self-contained payload **and** the single-file extraction cost that #282 is
actively fighting. The preflight's `≥ 10` SDK-major check mitigates the one failure
mode (an SDK too old to publish `net10.0`).

## 6. Detached launch

The launcher spawns Electron such that it **survives the calling shell returning**,
with `cwd = desktop/`, `PRISM_SIDECAR_BINARY` in its environment, and Electron's
stdout/stderr captured to a log file (under the data dir / `desktop/.dev-sidecar/`)
for post-launch diagnosis on **both** OSes.

- **Windows:** follow `scripts/serve-detached.ps1`'s **wrapper-script** pattern, not a
  bare WMI spawn. A `Win32_Process.Create` command line carries **neither environment
  variables nor redirection operators** — so setting `$env:PRISM_SIDECAR_BINARY` in the
  launching shell and calling `Win32_Process.Create` directly would let Electron start
  *without* the var, fall into `resolveBinaryPath()`'s packaged branch
  (`process.resourcesPath/sidecar/…`, which does not exist for a from-source run), and
  fail at sidecar spawn. Instead the script writes a small disposable wrapper `.ps1`
  that (a) sets `$env:PRISM_SIDECAR_BINARY`, (b) `Set-Location`s to `desktop/`, and
  (c) launches `node_modules/.bin/electron .` with its own `*>> $log` redirection — then
  spawns *that wrapper* via `Win32_Process.Create` so it lands outside the calling
  shell's job object and survives the script returning. (`Start-Process` / background
  jobs get reaped; the WMI-launched wrapper does not.) This is the exact reason
  `serve-detached.ps1` needs a wrapper rather than a bare command.
- **macOS:** `nohup ./node_modules/.bin/electron . >"$log" 2>&1 & disown`, with
  `PRISM_SIDECAR_BINARY` exported into the environment first. `nohup` ignores SIGHUP
  and `disown` removes the job from the shell's table, so closing Terminal does not
  kill Electron (and the sidecar Electron owns).

Electron spawns the sidecar as its **child** (`bootstrap()` → `startSidecar`), so the
sidecar's lifetime is owned by Electron, not the script.

**Success signal, and why there is no health gate.** Unlike `serve-detached.ps1`,
this launcher does **not** probe a readiness endpoint before returning: the sidecar
picks its own free port and reports it on stdout *to Electron* (`sidecar.ts`), so the
script never learns the URL to poll. The success signal a tester relies on is
therefore **the window appearing**. If it comes up blank or never appears, the
captured log — which includes the sidecar's port line, the `[startup]` timing line,
and any backend stderr — is the single failure-diagnosis affordance. The script is
fire-and-forget once the wrapper / `nohup` hand-off completes; it prints the log path
and returns.

## 7. Lifecycle and teardown

**Closing the window is the full teardown.** `desktop/src/main.ts` handles
`before-quit` by calling `sidecar.stop()` (SIGTERM, then SIGKILL after 5 s), so the
sidecar exits with the window. No `-Stop` subcommand is needed; the launcher does
not track or manage the running app after handing off. (Contrast `serve-detached.ps1`,
which needs `-Stop` because nothing else owns the detached web server's lifetime.)

**Second run while an instance is already up.** `main.ts` calls
`app.requestSingleInstanceLock()`, so a second `electron .` `app.quit()`s immediately
and the running instance merely refocuses its window (the `second-instance` handler).
Because the launcher always builds *before* it launches, a tester who re-runs the
script while PRism is open would otherwise sit through a full multi-minute rebuild
only to see no new window — a silent no-op. The launcher must account for this: either
a lightweight up-front check that short-circuits before the build with a clear message
("PRism is already running — close the window first, or a re-run just refocuses it"),
or, if no reliable pre-build check proves feasible, explicit documentation that a
second run rebuilds then refocuses the existing window. The detection mechanism is a
planning detail (a pidfile written at launch, mirroring serve-detached's per-store
pidfile, is the likely approach); the **requirement** is that a second run is not a
silent multi-minute no-op.

Edge case (deferred, not handled in this slice): if Electron is hard-killed rather
than closed cleanly, the sidecar's parent-death handling (`PRISM_PARENT_PID`) is the
existing backstop; the launcher adds no new supervision.

## 8. macOS specifics

- **Host arch:** `uname -m` selects the sidecar RID (`arm64` → `osx-arm64`,
  `x86_64` → `osx-x64`). The npm-installed Electron binary already matches the host
  arch, so no Electron-side arch handling is needed.
- **Gatekeeper / quarantine:** an npm-fetched Electron run from Terminal usually runs
  without a Gatekeeper prompt. The launcher does **not** pre-emptively strip the
  quarantine xattr — that defensive step is unverifiable from the Windows dev machine,
  a recursive `xattr -dr` is not worth baking in blind, and the real failure mode is
  already covered by documentation. Instead the README documents the remedy if a prompt
  does appear (`xattr -dr com.apple.quarantine node_modules/electron`, or
  right-click→Open). If a macOS tester confirms the prompt fires in practice, fold the
  strip into the script in a follow-up with real evidence.
- **Data dir:** `main.ts:resolveDataDir()` self-resolves the shared store; no
  `--dataDir` is passed, so the desktop run shares the same `LocalApplicationData/PRism`
  (Windows) / `~/.../PRism` (macOS) store as any other build — a tester's PAT and
  drafts carry across.

## 9. Verification reality

- **Windows (`run-desktop.ps1`):** verified end-to-end on this machine — preflight
  miss/hit, full build, detached launch, terminal freed, window up, close-to-teardown.
- **macOS (`run-desktop.sh`):** **cannot be run on the development machine** (Windows
  only). It is written carefully against the documented mechanisms and **must be
  confirmed by a macOS tester** before that half is called done. The spec and PR will
  state plainly that the macOS path is unverified-by-author at merge time; the macOS
  tester is the verification path. No success claim will be made on evidence not held.
- **Merge stance for the unverified macOS half.** Both scripts ship in one PR, but the
  macOS acceptance criterion stays **unchecked** at merge and **#306 stays open** until
  a macOS tester confirms `run-desktop.sh` end-to-end. The Windows half is fully
  verified and can be called done; the issue is **not** closed on the strength of the
  Windows half alone. This keeps the "Windows + macOS" goal honestly half-open rather
  than marking macOS done on untested code. (Alternative considered: a Windows-only PR
  with macOS split to a follow-up — rejected because the owner wants both scripts
  present and the testers *are* the macOS verification path.)

## 10. Acceptance criteria

- [ ] `scripts/run-desktop.ps1` brings up the desktop app from a fresh clone in one
      command on Windows, **detached** — the launching terminal can be closed and the
      app stays up.
- [ ] `scripts/run-desktop.sh` does the equivalent on macOS, detached. **Stays
      unchecked at merge** — checked only after a macOS tester confirms it end-to-end
      (see §9); #306 stays open until then.
- [ ] Neither script requires the tester to manually set `PRISM_SIDECAR_BINARY`,
      publish the sidecar, or run multiple steps — it is one command.
- [ ] Preflight detects a missing Node or an SDK below .NET 10 major **before building**
      and prints OS-specific, copy-pasteable remediation, then exits non-zero.
- [ ] First run with no prior build **builds from source** (frontend SPA →
      framework-dependent host-RID sidecar publish, into a freshly-cleared
      `desktop/.dev-sidecar/` → Electron TS) and launches.
- [ ] A `-SkipBuild` flag (default off) skips the build and launches against the
      current `desktop/.dev-sidecar/` output, mirroring `serve-detached.ps1`, for fast
      re-launches.
- [ ] A second run while an instance is already up is **not** a silent multi-minute
      no-op — it either short-circuits with a message or documents the
      rebuild-then-refocus behavior (§7).
- [ ] The detached launch captures Electron's stdout/stderr to a log file on **both**
      OSes, and the script prints that path.
- [ ] Closing the window tears down the sidecar (no orphaned backend).
- [ ] `desktop/README.md` documents both launchers, the toolchain prerequisites, the
      macOS Gatekeeper caveat, and the deferred `run.ps1 -Mode Desktop` relationship.
- [ ] `desktop/.dev-sidecar/` is gitignored and does not collide with the
      electron-builder `desktop/sidecar/` packaging dir.

## 11. Risks and open points

- **macOS unverifiable by author** (see §9) — mitigated by the macOS-tester gate, not
  eliminated.
- **Build cost per run:** the launcher always builds by default (two `npm ci` + a
  publish + tsc), which is the right default for "does everything for them" on a fresh
  clone. The `-SkipBuild` flag (now in scope, §10) is the escape hatch for fast
  re-launches against an existing build.
- **Framework-version drift:** a tester with an SDK too old to publish `net10.0` is
  caught by the preflight's `≥ 10` major-version check (§4) and surfaced as a
  remediation miss rather than a mid-build `dotnet publish` crash.

## 12. Out of scope / follow-ups

- `run.ps1 -Mode Desktop` foreground dev-loop switch (deferred half of #306).
- Detached **web** launch parity (the issue's note re: `serve-detached.ps1`) — not
  pursued here.
- Committing/fetching prebuilt per-OS binaries (separate, heavier decision).
