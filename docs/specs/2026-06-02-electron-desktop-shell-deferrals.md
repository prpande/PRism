# Electron desktop shell — deferrals

**Source spec**: [`2026-06-02-electron-desktop-shell-design.md`](2026-06-02-electron-desktop-shell-design.md).
**Status**: open.
**Purpose**: records decisions deferred or rejected during the 2026-06-02 brainstorm, each with the reason and the trigger that should reopen it. Items are tagged `[Defer]` (will likely return), `[Skip]` (rejected for this app), or `[Risk]` (accepted residual risk).

---

## Distribution / trust

### [Defer] Windows code signing (Azure Trusted Signing / EV / OV cert)
Deliberate zero-spend decision. Unsigned Windows = SmartScreen "More info → Run anyway" on every fresh download; no reputation accrues. Tolerable for a hand-held technical cohort.
**Reopen when:** cohort widens beyond sit-next-to colleagues; a tester on managed Windows is hard-blocked; or auto-update is pursued (unsigned updates re-trigger SmartScreen). Azure Trusted Signing (~$10/mo, CI-friendly) is the recommended path over an EV cert + hardware token.

### [Defer] macOS Developer ID signing + notarization (Apple Developer Program, $99/yr)
Zero-spend decision. **This is the single highest-value future spend** — macOS is where unsigned distribution actually breaks (Sequoia buried the Open-Anyway flow; "damaged" requires a Terminal `xattr`), whereas Windows-unsigned is one click. Without it, macOS auto-update is impossible (electron-updater requires a Developer ID signature to apply updates).
**Reopen when:** any of — cohort widens; auto-update is pursued; macOS first-impression friction is observed to poison trial feedback; or the project commits to self-service (non-hand-held) distribution. Enrollment has a multi-day identity-verification lead time — start it the moment the decision flips.

### [Defer] Auto-update (electron-updater + GitHub Releases feed)
Out of this cut because its *correctness depends on signing*: macOS updates require a Developer ID signature; Windows unsigned updates re-warn via SmartScreen each time. A broken auto-updater can brick a tester's install mid-trial — the worst trial outcome. Trial cohort does manual re-download.
**Reopen when:** signing lands (at minimum macOS). Then wire electron-updater with GitHub Releases (`latest.yml` / `latest-mac.yml`) and test the update flow end-to-end before relying on it.

---

## Native chrome (minimal-first cuts)

### [Defer] System tray / menubar presence
Not required for A+B. Adds background-process UX questions (close-to-tray vs quit).
**Reopen when:** the app should persist in the background to surface PR-update notifications without a window open.

### [Defer] Native application menus
Standard OS frame ships with a default menu; a curated menu (with app-specific actions, keyboard accelerators mirroring the in-app cheatsheet) is polish.
**Reopen when:** menu-driven discoverability or native accelerators are wanted.

### [Defer] OS notifications wired to SSE banner events
The app already surfaces pr-updated banners in-window. Native OS notifications (fired from the Electron main process on SSE events) need an IPC bridge from renderer → main and a notification-permission/preference model.
**Reopen when:** users want to be notified of PR updates while PRism is not focused. Pairs naturally with the tray item.

### [Defer] Deep links (`prism://pr/owner/repo/123`)
Protocol registration + single-instance argv parsing + route handoff to the renderer. Not needed for the trial.
**Reopen when:** users want to open a specific PR from a browser/Slack link. Note: deep-link argv arrives via the `second-instance` handler, so it composes with the single-instance design already in scope.

### [Defer] Custom / frameless title bar
A frameless window with a custom title bar is more "Slack/Claude," but it is pure polish and adds per-OS traffic-light/caption-button handling. Minimal cut ships the standard OS frame.
**Reopen when:** the branded-window look becomes a priority (likely alongside C/distribution polish).

### [Defer] Window size / position persistence across launches
The shell opens to Electron's default size every launch. Persisting size/position is a P4-polish backlog item (`docs/backlog/05-P4-polish.md`), not required for Goal A or B, and it adds multi-monitor / minimized-last-session edge cases.
**Reopen when:** dogfooding friction on window placement is reported, or alongside other native-chrome polish.

---

## Architecture

### [Skip] Collapse the backend in-process (no localhost HTTP server)
Rejected. Would discard the HTTP endpoint surface, SSE, and the cross-origin/session-token defense model, and would break the additive-shell invariant — all for no v0.2.0 benefit. The sidecar model keeps the app byte-identical and developable as a plain web app.
**Reopen when:** never, unless a future requirement makes the localhost server itself untenable (not foreseeable for a single-user PoC).

### [Defer — CONDITIONAL] Shell→backend startup shared secret
Optional hardening: a one-time secret passed shell→sidecar (env var) that the backend requires, so a co-resident local browser cannot drive the sidecar even within the loopback binding.
**The deferral is conditional on the § 5 Host-header DNS-rebinding check shipping.** A JS-readable session cookie + an allowlisted loopback Origin means a DNS-rebinded page could otherwise drive the API; the Host-header check (reject any `Host` ≠ the bound `127.0.0.1:<port>`) closes that cheaply. If the Host-header check is descoped at plan time, this shared secret becomes **load-bearing and must return to scope** — it is no longer "defense-in-depth."
**Reopen when:** the Host-header check is dropped; OR the threat model expands beyond single-user localhost; OR a concrete co-resident/rebinding attack is demonstrated.

### [Skip → in favor of watchdog] Windows job object for orphan prevention
A Windows job object (children die with the parent) is the OS-native alternative to the parent-PID watchdog chosen in § 3.3. Rejected as the primary mechanism because it is Windows-only; the watchdog is cross-platform and sets up macOS for free.
**Reopen when:** the watchdog proves unreliable on Windows specifically; the job object can be layered as Windows-only belt-and-suspenders.

### [Defer] macOS x64 / universal binary
arm64 (Apple Silicon) only, consistent with the v1 roadmap's macOS posture. Intel-Mac testers are unsupported in v0.2.0.
**Reopen when:** an Intel-Mac tester is in the cohort, or universal distribution is wanted post-signing.

### [Defer] Sidecar auto-restart on unexpected exit
Minimal cut shows a dialog and quits on sidecar crash. A supervised restart (bounded retries) is a reliability nicety.
**Reopen when:** dogfooding surfaces sidecar crashes that a restart would paper over gracefully.

---

## Accepted residual risks

### [Risk] macOS build is unverified on real hardware until the § 8.1 smoke
The osx-arm64 sidecar + Electron-mac build have never run on Apple hardware. Electron removes the rendering risk but not the launch/spawn risk. Mitigation is the mandatory borrow-a-Mac smoke before cohort hand-out. This is a *process* gate, not a code fix.

### [Risk] Corporate-managed Windows may hard-block the unsigned `.exe`
MDM/AppLocker/WDAC can block with no user override. Mitigation: confirm each Windows tester can run unsigned apps, or hand them the browser-tab v0.1.0 build instead.

### [Risk] Unsigned first-impression may conflate the N=3 signal
A malware-warning cold open is a worse first interaction than the stale-docs risk the v1 roadmap already weighed. A tester who bounces at the Gatekeeper/SmartScreen wall yields no wedge signal. Accepted for the hand-held cohort because the bypass is walkable with direct support; revisit if observed to drag trial responses into the rejected bucket (→ promotes the macOS signing spend).

---

## Cross-workstream wiring

### [Defer] Validation-suite shell-agnostic launch layer (resolves validation D1)
The Electron decision resolves the validation spec's **D1 blocker** ("standalone-SPA shell decision") toward Architecture A: a shell-agnostic launch abstraction that can start the app as either a bare Kestrel process (browser/Playwright) or via Electron. Building it shell-agnostic from the start means it absorbs this shell instead of being re-touched.
**Owned by:** the validation-suite Phases 2–5 plans, not this spec. This entry is the forward pointer so the coupling is not lost.
**Ordering dependency:** validation Phases 2–5 can *plan* against Architecture A immediately, but cannot *implement* the Electron launch path until the `desktop/` scaffold (`main.ts` + `package.json` skeleton, so `_electron.launch()` is importable) lands. "D1 resolved" ≠ "validation implementation can start now."
