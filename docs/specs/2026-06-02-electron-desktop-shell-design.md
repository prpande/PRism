# Electron desktop shell (v0.2.0)

**Date**: 2026-06-02.
**Status**: Draft — brainstorm output; implementation plan written ([`../plans/2026-06-02-electron-desktop-shell.md`](../plans/2026-06-02-electron-desktop-shell.md), this PR).
**Target release**: v0.2.0 (ships *after* the browser-tab v0.1.0; built in parallel on a long-lived `desktop` branch).
**Source authorities**:
- [`docs/specs/2026-05-28-v1-completion-roadmap-design.md`](2026-05-28-v1-completion-roadmap-design.md) § Amendments — the native-app-shell scope shift that deferred Phase 1 single-instance enforcement pending a framework decision. This spec *is* that framework decision.
- [`docs/specs/2026-05-06-architectural-readiness-design.md`](2026-05-06-architectural-readiness-design.md) § ADR-P0-4 — single-instance enforcement seed sketch (named mutex / IPC focus). Superseded here by Electron's first-class single-instance primitive.
- [`docs/specs/2026-05-28-manual-validation-test-plan-design.md`](2026-05-28-manual-validation-test-plan-design.md) — the validation suite whose **D1 blocker** ("standalone-SPA shell decision") this spec resolves toward "Architecture A: shell-agnostic launch layer."
- `PRism.Web/Program.cs`, `PRism.Web/Endpoints/HealthEndpoints.cs`, `PRism.Web/Middleware/SessionTokenMiddleware.cs`, `PRism.Web/Middleware/OriginCheckMiddleware.cs`, `PRism.Core/Hosting/LockfileManager.cs` — the current production launch path, health/auth/origin contracts, and lockfile the shell reuses.
- [`.ai/docs/documentation-maintenance.md`](../../.ai/docs/documentation-maintenance.md) — which docs to update per change type.

---

## Resolved decisions (from human review, 2026-06-02)

Two strategic calls surfaced by review, now decided:

1. **The unsigned shell IS the trial vehicle for the first colleague-testing round.** Accepted that the OS first-run warning is walkable for a hand-held technical cohort; the § 8.1 real-Mac smoke and § 8.0 Mac-tester gate still apply, and `TESTING.md` (§ 7) sets the expectation so the warning reads as expected. If a later, wider round needs a clean first impression, the $99 macOS signing spend (§ 8.3) is the lever — not a re-architecture.
2. **The single-instance fix ships *with* the shell, not severed onto `main`.** Goal B stays bundled in v0.2.0; no separate browser-tab lockfile/focus PR. The backend lockfile remains the dataDir-integrity guard (§ 3.2) and Electron's lock adds the focus-existing-window UX — both land together in the shell.

---

## 1. Goal and scope

### 1.1 Goal

Wrap the existing PRism web app in an Electron desktop shell so it installs and launches like a regular Windows / macOS application instead of opening a browser tab against `localhost`. The shell delivers:

- **A — Own-window identity.** Its own window, app icon, taskbar/dock presence, Alt-Tab/⌘-Tab membership, no browser address bar or tab chrome. *Honest scope:* this buys "a credible native window with dock presence," **not** the full "Slack/Claude feel" — that identity includes a signed, notarized, auto-updating trust layer that is explicitly out of this cut (§ 1.3). The most native-feeling polish (frameless/custom title bar) is also deferred. What ships is the window, not the trust layer.
- **B — Single-instance enforcement.** A real process identity that closes the two-PRism-windows data-loss path deferred since S3 and again at v1 (roadmap § Amendments). Second launch focuses the existing window instead of spawning a second backend. Decided (Resolved decisions #2): ships *with* the shell, not severed onto `main`.
- **D — Renderer consistency.** Electron bundles Chromium, so the app renders identically on Windows and macOS. *Honest scope:* this is a **tiebreaker, not a headline** — on Windows, WebView2 already supplies Chromium, and the macOS render risk it would eliminate is separately covered by the mandatory real-Mac smoke (§ 8.1). D is load-bearing only against a *system-webview* alternative (WebView2-on-Windows + WKWebView-on-macOS); against the alternatives actually weighed (§ 1.5) it is roughly a wash. It is not "free" — it costs ~150 MB of bundled Chromium.

**Opportunity-cost note.** This is a multi-week effort undertaken *before* the N=3 wedge signal lands. The justification is not "highest-leverage work available" but "low-regret work that survives any product pivot (packaging is orthogonal to product direction) and finally gives the long-deferred single-instance fix a home." If something higher-leverage is queued, it should outrank this; the parallel-branch model (§ 9) exists precisely so this does not block the v0.1.0 ship or the trial.

### 1.2 In scope (v0.2.0)

1. An Electron main process (`desktop/`) that acquires a single-instance lock, spawns the existing `PRism.Web` binary as a managed sidecar, learns the bound port from the sidecar, waits for health, and opens a `BrowserWindow` on the loopback URL.
2. Single-instance + second-launch focus (the **B** fix).
3. App icon, standard OS window frame, clean quit with **no orphaned sidecar process**.
4. A small set of additive backend changes (§ 4) that land on `main` first.
5. A cross-platform build/packaging pipeline producing **unsigned** Windows (`.exe`, NSIS or portable) and macOS (`.dmg`, ad-hoc-signed, arm64) artifacts via a CI matrix (`windows-latest` + `macos-latest`).
6. `TESTING.md` with exact per-platform install + bypass instructions.
7. An Electron e2e smoke suite (`_electron.launch()`).

Window size/position persistence is **out** of this cut (§ 1.3) — it is P4 polish, not required for A or B.

### 1.3 Out of scope — each with a one-line "why not now"

Captured authoritatively in the deferrals companion [`2026-06-02-electron-desktop-shell-deferrals.md`](2026-06-02-electron-desktop-shell-deferrals.md). Summary:

- **Code signing (Windows) + macOS Developer ID signing + notarization.** Why not now: deliberate zero-spend decision ($99/yr Apple; ~$120/yr Windows). Trial cohort is hand-held and technical. Highest-priority future spend, macOS first (§ 8.3).
- **Auto-update (electron-updater).** Why not now: its correctness *depends on signing* — macOS requires a Developer ID signature to apply updates; Windows unsigned updates re-trigger SmartScreen. Trial cohort does manual re-download.
- **System tray, native menus, OS notifications, deep links, custom/frameless title bar, window-state persistence.** Why not now: each is its own scope; none required for A+B. Minimal-first.
- **Collapsing the backend in-process (no localhost HTTP server).** Why not now: would discard the HTTP/SSE/session-token surface for no v0.2.0 benefit and break the additive-shell invariant.
- **macOS x64 / universal binary.** Why not now: arm64 (Apple Silicon) only, consistent with the v1 roadmap.

### 1.4 The hard invariant — additive shell, never a parallel runtime

The app **must stay fully functional and developable as a plain localhost web app.** Electron is a packaging skin wrapped around the unchanged backend + frontend:

- The inner dev loop (`dotnet watch run` + `npm run dev` Vite HMR, opened in any browser) is unchanged. You never launch Electron to build an app feature.
- Every existing Playwright test stays on `localhost` and stays representative (Electron renders with Chromium too).
- **Precise statement of the invariant:** no *app-domain* behavior (endpoints, SSE, state, draft/submit flows, rendering) may require Electron to exercise. *Shell-domain* behavior (single-instance focus, sidecar lifecycle, watchdog, packaging) legitimately does require Electron and gets its own bounded test layer (§ 10). The smell to avoid is app behavior leaking into the shell, not the shell having its own tests.

This invariant is *why* Approach 1 was chosen over an in-process collapse — the wrapper consumes the existing prod asset-serving mode (Kestrel serves built `wwwroot`) rather than forking it. It does **not**, by itself, distinguish Electron from a .NET-native webview host; that comparison is § 1.5.

### 1.5 Why Electron over the alternatives (decision record)

The additive-shell invariant is satisfied equally by Electron and by a .NET-native webview host, so it cannot be the deciding factor. The decision was made deliberately in brainstorm against these alternatives:

| Option | Toolchain added | Bundle size | Render engine (Win / Mac) | Single-instance primitive | Notes |
|---|---|---|---|---|---|
| **Electron + .NET sidecar** *(chosen)* | Node | ~150 MB Chromium + ~70 MB sidecar | Chromium / Chromium (bundled) | `requestSingleInstanceLock()` (first-class) | Mature cross-platform installer + (future) auto-update ecosystem; identical render both OSes. |
| Photino + .NET sidecar | none (.NET) | ~small | WebView2 / WKWebView | DIY mutex + IPC | One toolchain, but system webview → no render determinism on macOS (the platform already unverified). |
| WinUI3 / WPF + WebView2 + sidecar | none (.NET) | small | WebView2 / — | DIY mutex | Windows-centric; macOS needs a separate host — defeats single cross-platform build. |
| Tauri + .NET sidecar | Rust | small | WebView2 / WKWebView | plugin | Adds a Rust toolchain *and* keeps the sidecar cost *and* drops render determinism — worst trade for this app. |

**Why Electron won, concretely:** (1) a single cross-platform build/installer story for a solo maintainer with no Mac hardware; (2) `requestSingleInstanceLock()` is a first-class, well-trodden primitive vs. a hand-rolled mutex + IPC focus channel; (3) bundled Chromium normalizes rendering across both OSes (the D tiebreaker). **The acknowledged cost:** it adds a Node toolchain and ~150 MB to a project that otherwise values "stay in .NET / one toolchain," and the render-determinism benefit is partial (Windows already has Chromium via WebView2). The author accepted that cost explicitly for the packaging-ecosystem maturity and the single-instance primitive. If that trade is reopened, Photino is the fallback (one toolchain, accept the macOS-webview risk).

---

## 2. Architecture

### 2.1 Three-process model

```
 ┌────────────────────────┐         spawns          ┌──────────────────────────────┐
 │  Electron main (Node)  │ ──────────────────────▶ │  PRism.Web sidecar (.NET)     │
 │  desktop/src/main.ts   │ ◀── stdout: port ────── │  --no-browser, picks port     │
 │  • single-instance lock│                         │  binds http://127.0.0.1:<port>│
 │  • spawn/kill sidecar  │ ◀── GET /api/health 200 │  serves wwwroot + API + SSE   │
 │  • BrowserWindow       │                         └──────────────┬───────────────┘
 └───────────┬────────────┘                                        │ loopback HTTP
             │ loads http://127.0.0.1:<port>                        │
             ▼                                                      ▼
   Renderer = the React app (unchanged), Chromium, sandboxed
   same-origin to the sidecar → session-token + Origin handshake unchanged
```

Only the Electron main process is new code. The sidecar is the current `PRism.Web` binary; the renderer is the current React frontend. **One loopback host string — `127.0.0.1` — is used end-to-end** (bind, stdout report, window load, Origin allowlist) to avoid `localhost`/`127.0.0.1`/`::1` drift (§ 4, § 5).

### 2.2 Electron main responsibilities (`desktop/src/main.ts`)

1. **Single-instance gate (first, before spawning anything):** `app.requestSingleInstanceLock()`. If not acquired, `app.quit()` immediately — the second process never spawns a backend. The primary registers a `second-instance` handler that restores (if minimized) and focuses the existing window.
2. **Spawn the sidecar:** `child_process.spawn(prismWebPath, ['--no-browser', '--dataDir', <resolved>], { env: { ...process.env, PRISM_SIDECAR: '1', PRISM_PARENT_PID: String(process.pid) } })`. The backend runs its **existing** port-selection (5180–5199 → first free; see `Program.cs`) and prints the bound URL to stdout. The shell does **not** pre-pick the port (avoids the TOCTOU race in § 3.4). Sidecar mode is signaled by the `PRISM_SIDECAR` **environment variable**, not a CLI flag, so it is not inspectable via `ps`/`wmic` and cannot be spoofed as easily by a co-resident process (§ 5).
3. **Learn the port:** parse the sidecar's stdout `PRism listening on http://127.0.0.1:<port>` line to obtain the bound port. (Backend bind host standardized to `127.0.0.1` per § 4.)
4. **Health gate:** poll `GET http://127.0.0.1:<port>/api/health` until HTTP 200 or a bounded timeout (e.g. 15 s). `/api/health` is auth-exempt (`SessionTokenMiddleware.IsLivenessEndpoint`) and returns `{ port, version, dataDir }` — the correct liveness signal. On timeout → error dialog + quit (§ 3.4).
5. **Open window:** create `BrowserWindow` with the app icon, standard OS frame, default size. Load `http://127.0.0.1:<port>`. `webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }` — no preload bridge at minimal scope.
6. **Teardown:** on `before-quit` / `window-all-closed`, gracefully terminate the sidecar (§ 3.3).

### 2.3 The .NET sidecar — unchanged, plus the § 4 changes

The sidecar is the existing `PRism.Web` self-contained single-file binary. It already accepts `--no-browser` (parsed in `Program.cs`) and reads `DataDir` / `urls` via the configuration provider. **`--dataDir` is not a bespoke flag** — it binds via ASP.NET's default command-line config provider mapping `--dataDir <value>` → key `DataDir`; § 4 pins that contract with a test. The only genuine new code is the § 4 changes, all gated to sidecar mode and harmless to browser-tab mode.

### 2.4 The renderer

The current React app, served by the sidecar from `wwwroot`, loaded over loopback HTTP. Because it is same-origin to the sidecar, the existing `SessionTokenMiddleware` token handshake and `OriginCheckMiddleware` authorize it unchanged — **subject to the Electron-session verification in § 5 and § 10** (Electron's Chromium has its own cookie store and secure-context heuristics; "unchanged" is asserted-then-tested, not assumed). Electron's sandbox + `nodeIntegration: false` means the web content has zero OS/Node access.

---

## 3. Lifecycle and data flow

### 3.1 Launch sequence

1. User launches PRism (installed app icon).
2. Electron acquires the single-instance lock.
3. Electron spawns `PRism.Web --no-browser --dataDir <…>` with `PRISM_SIDECAR=1` + `PRISM_PARENT_PID=<electron pid>`.
4. The backend selects a free port (existing logic), binds `http://127.0.0.1:<port>`, prints it to stdout.
5. Electron parses the port from stdout, then polls `GET /api/health` until 200 (bounded).
6. Electron opens the `BrowserWindow` at `http://127.0.0.1:<port>`.
7. The React app performs its normal session-token/auth handshake and renders. First-run = paste-PAT flow, unchanged.

### 3.2 Single-instance and second launch (the B fix)

`requestSingleInstanceLock()` is the **UX-level** enforcement: a second launch fails to acquire the lock → `app.quit()` **before spawning a backend**, and the primary's `second-instance` event restores + focuses the existing window. This is what closes the *accidental double-launch* path (the common case from roadmap § 1.6).

The backend `LockfileManager` is the **data-integrity** enforcement and **stays active** (it is *complementary*, not redundant): it prevents *any* second backend — however launched, including a direct binary invocation outside Electron — from sharing one `dataDir` and racing `state.json`. Its existing stale-lock takeover (`IsAlive` PID + binary-path match) handles crash recovery. **Seam work is limited to verification, not removal** (§ 4.2). Together: Electron's lock stops the accidental second *window*; the lockfile stops a second *backend* from corrupting state.

(Severability resolved — Resolved decisions #2: the fix ships with the shell, not on `main` ahead of it.)

### 3.3 Quit and orphan prevention

- **Graceful quit.** On window close / `before-quit`: send the sidecar a termination signal — `SIGTERM` on macOS, `TerminateProcess`/`taskkill` on Windows (the .NET process has no console to Ctrl-C) — set a `quitting` flag, wait up to ~5 s, then force-kill if still alive. Backend writes are atomic, so an interrupted write is safe.
- **Orphan prevention on shell crash** (shell dies without running teardown): a **parent-PID liveness watchdog inside the sidecar**, armed only when `PRISM_SIDECAR=1`, reading `PRISM_PARENT_PID`. It must use a **recycle-resistant** liveness check — mirror `LockfileManager.IsAlive`'s PID-plus-identity approach (PID alone can be recycled to an unrelated live process on Windows, which would either strand the orphan or kill a healthy session). Poll cadence and the exact per-OS mechanism (Windows `Process` handle + start-time; macOS `getppid()` reparent-to-launchd detection or `kqueue NOTE_EXIT`) are pinned at plan time.
- **Watchdog ↔ graceful-quit ordering contract:** during a normal quit the shell *intentionally* disappears, so the watchdog must not race it into a misleading "parent vanished" self-kill or a restart fight. The watchdog only self-exits the sidecar; it never restarts it. The graceful-quit force-kill is the authoritative teardown; the watchdog is the fallback for the *un*graceful case. (Cross-platform parent-death detection is itself unverified on macOS — see § 8.1; the deferrals companion keeps a Windows job object as a possible belt-and-suspenders.)

### 3.4 Crash / error handling

| Failure | Shell behavior |
|---|---|
| Sidecar fails to start / health timeout | Error dialog ("PRism failed to start"), write diagnostic to a log file under `dataDir`, quit. |
| Port conflict | The **backend owns port selection** and retries the next free port in-range itself (existing `Program.cs` logic), so there is no shell-side TOCTOU and no separate retry path to wire. If the whole range is exhausted the backend exits → treated as "failed to start" above. |
| Sidecar exits unexpectedly mid-session | Shell detects child `exit` → dialog ("PRism stopped unexpectedly") → quit. Auto-restart is a v0.2.x nicety, not minimal. |
| Renderer load failure (`did-fail-load`) | Retry the loopback URL a bounded number of times, then error dialog + quit. |

---

## 4. Backend changes — land on `main` first (standalone PRs)

These keep the `desktop` branch purely additive (only new `desktop/` files), so `main` ↔ `desktop` merges touch disjoint files. Each is harmless to browser-tab mode and independently valid:

1. **Verify + pin the launch contract (mostly verification, not new code).** Confirm `--no-browser` is parsed, the port is reported to stdout in a stable parseable form, and `--dataDir` binds via the config provider's `DataDir` key (it is *not* a bespoke flag). The `--dataDir` → `DataDir` binding is pinned by the **D1 e2e** (which sets `PRISM_DATA_DIR` → `DataDir` to a temp dir and asserts the sidecar's artifacts land there); add a focused config-binding unit test if a faster guard against an SDK default-config change is wanted. The health endpoint already exists — `GET /api/health`, auth-exempt — so **no `/healthz` is added** (the earlier "add if needed" option is moot).
2. **Verify the lockfile coexists with the shell lock (verification, not removal).** `LockfileManager` stays active as the `dataDir`-integrity guard (§ 3.2). Confirm stale-lock takeover works for a sidecar relaunch after a crash (it already does). Do **not** skip `LockfileManager.Acquire()` in sidecar mode — that guard is what stops a rogue/second backend from corrupting `state.json`.
3. **Standardize the loopback host + confirm Origin/cookie behavior.** Bind the sidecar to `http://127.0.0.1:<port>` (today's browser-tab path binds `localhost`; standardize on the literal `127.0.0.1` end-to-end to avoid `localhost`→`::1` ambiguity). Confirm `OriginCheckMiddleware` accepts the same-origin `http://127.0.0.1:<port>` (its exact-match + both-loopback branches already do) and that the `prism-session` cookie is host-scoped consistently under `127.0.0.1`. The Origin allowlist must accept only the **literal address** form, never the `localhost` hostname (§ 5 T3).
4. **Parent-PID liveness watchdog** (§ 3.3), armed by `PRISM_SIDECAR=1`, reading `PRISM_PARENT_PID`, recycle-resistant.

A shell→backend startup **shared secret** is deferred but its deferral is now **conditional** on the § 5 DNS-rebinding resolution — see deferrals companion.

---

## 5. Security model

The sidecar binds `127.0.0.1` loopback and serves API + SSE and holds a GitHub PAT on disk. Existing defenses: `SessionTokenMiddleware` (validates an `X-PRism-Session` header the renderer echoes from a non-HttpOnly `prism-session` cookie) + `OriginCheckMiddleware` (rejects empty/foreign Origin on mutating verbs). Threat model is single-user localhost. Review surfaced four items the spec must address rather than wave at:

- **DNS rebinding (the real one).** Allowlisting the loopback Origin to support the renderer means a malicious web page that rebinds a domain to `127.0.0.1:<port>` becomes *same-origin* to the sidecar; because the session cookie is JS-readable (`HttpOnly=false`) and `SameSite=Strict` no longer helps once same-origin, the page could read the token and drive the API. **Mitigation in scope: a Host-header allowlist check** — the backend rejects any request whose `Host` is not a loopback literal (`127.0.0.1` / `[::1]`; see plan Task A4 for the exact predicate). Rebinding sends the *attacker's* domain in `Host`, which is not a loopback literal, so this defeats it cleanly and cheaply. The **ephemeral/in-range port** (unpredictable to a remote attacker) is a secondary mitigation. This Host-check is added alongside seam § 4.3.
- **Shared-secret deferral is conditional, not categorical.** It is defense-in-depth *only if* the Host-header check above ships. If the Host-check is descoped, the shared secret becomes load-bearing and must return. The deferrals companion records this condition.
- **No secrets in spawn args.** Sidecar mode and parent PID go via **environment variables** (`PRISM_SIDECAR`, `PRISM_PARENT_PID`), not CLI flags, so they are not exposed in the process list and a co-resident process cannot trivially spoof sidecar mode on the command line. `--dataDir` is a path (not a secret); the PAT is never passed as an argument.
- **`dataDir` file permissions.** The installed-app `dataDir` resolves under the user profile (not the install directory) and the PAT cache + `state.json` must be created user-only (`0700` dir / private DACL). This is largely existing behavior via `DataDirectoryResolver`; the plan confirms it holds under the installed-app path, since the distribution change is what alters where `dataDir` lands.

Electron hardening: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no preload bridge → the web content cannot reach Node/OS; there is no IPC surface to audit at minimal scope. The unsigned-binary trust gap is a *distribution* concern (§ 6.3, § 8), not a runtime vulnerability.

**Out-of-model (accepted):** a malicious same-UID process can already run `PRism.Web` directly or read `dataDir` today; Electron's single-instance lock never claimed to defend that, and the lockfile (§ 3.2) blunts the state-corruption half. Not a v0.2.0 gap.

---

## 6. Build and packaging — unsigned, cross-platform

### 6.1 Build pipeline

Per platform, three stages: `npm run build` (frontend → `wwwroot`) → `dotnet publish --runtime <rid> --self-contained -p:PublishProfile=ci` (single-file binary with `wwwroot` inside; the existing csproj-gated profile) → `electron-builder` packs the published binary as `extraResources` alongside the Electron main code. The React app is **not bundled twice** — it is served by the sidecar from `wwwroot`. (Verified: `PublishSingleFile` + `IncludeNativeLibrariesForSelfExtract` keeps managed code in-process under .NET 5+, so the spawned PID is the one to kill and there is no hidden grandchild to orphan.)

### 6.2 electron-builder configuration (`desktop/electron-builder.yml`)

- `appId`, `productName: PRism`, icons (Windows `.ico`, macOS `.icns`) derived from the existing `assets/icons/` source.
- **Windows:** NSIS installer and/or portable `.exe` (portable preferred for the trial to dodge UAC; SmartScreen still fires).
- **macOS:** `.dmg`, `arch: arm64`. No notarization / Developer ID → electron-builder applies an **ad-hoc signature** (runs locally after quarantine removal; does not satisfy Gatekeeper for downloads).
- `extraResources`: the per-RID published `PRism.Web` binary.
- Explicitly **no** notarization hook and **no** auto-update provider in this cut.

### 6.3 Unsigned distribution reality — per platform (informs `TESTING.md`)

| Platform | First-run friction | Bypass |
|---|---|---|
| **Windows** | SmartScreen "Windows protected your PC" on every fresh download (no reputation accrues unsigned). | **More info → Run anyway.** Portable `.exe` avoids UAC. |
| **Windows (corporate-managed)** | MDM/Intune SmartScreen-Block, AppLocker, or WDAC may **hard-block with no override.** | None user-side — verify testers are not on locked-down managed Windows (§ 8.2). |
| **macOS (Sonoma 14 and earlier)** | "Apple could not verify… free of malware." | Control-click → Open → Open. |
| **macOS (Sequoia 15+)** | Same warning; Control-click bypass removed. | **System Settings → Privacy & Security → Open Anyway → authenticate.** |
| **macOS (broken/missing signature)** | "PRism is damaged and can't be opened" — no GUI override. | Terminal: `xattr -dr com.apple.quarantine /Applications/PRism.app`. |

### 6.4 CI matrix and coexistence with `publish.yml`

A new workflow with a build matrix: `windows-latest` builds the win-x64 artifact; `macos-latest` builds the osx-arm64 `.dmg` (electron-builder `.dmg` packaging is macOS-only; the macOS runner also runs its own `dotnet publish osx-arm64` since it packs that binary). Both produce **unsigned** artifacts attached to a draft GitHub Release. Third-party-action SHA-pinning + Dependabot discipline carries over.

**Coexistence decision (not deferred):** the desktop workflow fires on **`v0.2.*` tags only**; the existing `publish.yml` continues to fire on **`v0.1.*` tags** and keeps producing the raw browser-tab binary. They never run on the same tag, so the v0.1.0 fallback artifact (needed for managed-Windows testers per § 8.2) is preserved and the release pages stay unambiguous.

---

## 7. `TESTING.md` deliverable

A required repo-root deliverable (not a nicety) — under unsigned distribution the bypass steps *are* the install instructions:

- Per-platform download + install + first-run bypass (the § 6.3 table, written for a non-author reader).
- Expectation-setting framing: "PRism is an unsigned PoC build; your OS will warn you. Here's exactly what to click" — so the warning reads as *expected*.
- "Recovering a lost draft" / "Where's my data?" pointers (mirrors README troubleshooting).
- Explicit "auto-update is not present — to update, download the latest build and reinstall."
- macOS `xattr` fallback for the damaged-app case.

Distinct from `CONTRIBUTING.md` (dev workflow, v1 roadmap Phase 2) and the public README. It is a trial-cohort artifact.

---

## 8. Distribution and the N=3 trial

### 8.0 Gate the macOS target on a confirmed Mac tester

Mirror the § 8.2 Windows check: **build, ad-hoc-sign, and document the macOS `.dmg` only if the cohort actually contains a macOS tester.** macOS is where unsigned distribution most breaks (§ 6.3) and where the build is unverified (§ 8.1); standing up the entire macOS path for a cohort with no Mac user is speculative surface to maintain. If no Mac tester is confirmed, defer the macOS target wholesale to a follow-up. (Resolving Open Question #1 + the cohort composition settles this.)

### 8.1 macOS runtime-verification gate (hard requirement, if macOS ships)

**Notarization (absent here) only proves a scan; nothing here proves the app runs.** The `osx-arm64` .NET sidecar and the Electron-on-macOS build have never executed on Apple hardware. Electron removes the *rendering* risk but not the "does the sidecar spawn, the watchdog work, and the window open on macOS" risk (the parent-death watchdog in particular is unverified cross-platform). **Before any `.dmg` reaches a tester, smoke it on one real Mac for one hour.** CI can build but cannot verify a GUI launch. Non-negotiable for a scarce cohort.

### 8.2 Corporate-managed-machine risk (Windows)

If testers are colleagues on managed Windows, an unsigned `.exe` may be policy-blocked with no override. **Confirm each Windows tester can run unsigned apps**, or hand those testers the browser-tab v0.1.0 build instead (preserved per § 6.4).

### 8.3 The signing decision is deferred, not closed

Highest-value future spend is the **$99/yr Apple Developer Program** — macOS is where unsigned breaks; Windows-unsigned is one click. Revisit when the cohort widens, auto-update becomes worth its complexity, or the OS-trust first impression is observed to poison trial feedback (Open Question #1). Recorded in the deferrals companion.

---

## 9. Repo structure and branching

- New top-level **`desktop/`**: `package.json` (electron, electron-builder, `@playwright/test`), `src/main.ts`, `electron-builder.yml`, `assets/icons/`.
- `desktop/` lives on a long-lived **`desktop` branch**, developed in a git worktree per the project's worktree convention. `main` keeps shipping the browser-tab tool (v0.1.0 and ongoing fixes).
- The § 4 backend changes land on **`main` first** as small standalone PRs, so `main` ↔ `desktop` touch disjoint files. **Merge `main` → `desktop` frequently.**
- The shell merges back to `main` as **v0.2.0** when ready.
- **Architecture A (shell-agnostic launch layer):** the app can start either as a bare Kestrel process (browser/Playwright) or via Electron. Building the validation suite's launch abstraction this way (when those phases are planned) lets it span both modes and resolves the validation spec's D1 blocker. See § 13 and the deferrals companion for the ordering dependency.

---

## 10. Testing strategy

- **Unchanged (fast inner loop):** every existing browser + Playwright test stays on `localhost` and stays representative (Electron = Chromium).
- **New, bounded — Electron e2e** via Playwright's `_electron.launch()`:
  - window opens and loads the app (renderer reaches the sidecar over loopback);
  - **single-instance:** launch twice → exactly one window, second launch focuses it (the B fix);
  - **clean quit:** after quit, **no orphaned `PRism.Web` process** remains;
  - **session handshake under Electron:** the `prism-session` cookie is present and echoed as `X-PRism-Session` on the first authenticated fetch — turning § 2.4's "authorize unchanged" into a tested invariant (catches Electron cookie-store/secure-context surprises).
- **Manual smoke** (not CI-automatable): app icon is correct on the window/taskbar/dock; real-Windows-hardware launch each build; the § 8.1 one-time real-Mac smoke before cohort hand-out.
- The Electron e2e suite is small and isolated; it does not duplicate the app's existing coverage.

---

## 11. Deferred / out of scope

Authoritative list with revisit-triggers in [`2026-06-02-electron-desktop-shell-deferrals.md`](2026-06-02-electron-desktop-shell-deferrals.md): code signing (Win + Mac), notarization, auto-update, tray, native menus, OS notifications, deep links, custom/frameless title bar, window-state persistence, in-process backend collapse, shared-secret hardening (conditional — § 5), Windows job-object orphan-prevention alternative, macOS x64/universal, and the validation-suite shell-agnostic launch-layer wiring.

---

## 12. Acceptance criteria

1. Launching the installed app opens a native PRism window (own icon, OS frame, no browser chrome) that loads the full app and completes the paste-PAT first-run flow.
2. Launching a second time focuses the existing window and spawns no second backend (verified: exactly one `PRism.Web` process, one window).
3. Quitting leaves no orphaned `PRism.Web` process; killing the shell process leaves no orphaned sidecar (watchdog fires, recycle-resistant).
4. `electron-builder` produces unsigned Windows (`.exe`) and macOS (`.dmg`, arm64) artifacts from the CI matrix; `v0.2.*` tags drive the desktop workflow and `v0.1.*` tags still drive `publish.yml`.
5. `TESTING.md` exists with accurate per-platform install + bypass steps and the "no auto-update" note.
6. The Electron e2e smoke suite passes (including the session-handshake assertion); every pre-existing browser/Playwright test still passes unchanged on `localhost`.
7. The additive-shell invariant holds: no *app-domain* behavior requires Electron to test (shell-domain behavior may; § 1.4).
8. If macOS ships, the § 8.1 real-Mac smoke has passed before any cohort hand-out.

---

## 13. Artifact and downstream wiring

- This spec: `docs/specs/2026-06-02-electron-desktop-shell-design.md`. Deferrals companion: `docs/specs/2026-06-02-electron-desktop-shell-deferrals.md`.
- New entry in `docs/specs/README.md` under "In progress."
- New row in `docs/roadmap.md` after the v1-completion section, referencing this spec as the v0.2.0 desktop-shell workstream; note that it resolves the architectural-readiness "single-instance enforcement (Before P0+)" row and the v1 roadmap's deferred Phase 1.
- Cross-reference from the validation spec's **D1 blocker** to this spec (resolves the shell decision → Architecture A shell-agnostic launch layer). **Ordering note:** validation Phases 2–5 can *plan* against Architecture A immediately but cannot *implement* the Electron launch path until the `desktop/` scaffold (`main.ts` + `package.json`) lands.
- The implementation plan is written and ships in this PR: [`../plans/2026-06-02-electron-desktop-shell.md`](../plans/2026-06-02-electron-desktop-shell.md) (4 phases / 16 tasks: backend changes on `main` → `desktop/` scaffold → packaging → CI matrix → e2e → `TESTING.md`). Implementation is a separate multi-PR effort executed against that plan.
