---
source-doc: docs/specs/2026-05-15-s6-polish-and-distribution-design.md
plan-doc: docs/plans/2026-05-15-s6-polish-and-distribution.md
created: 2026-05-23
last-updated: 2026-05-26
status: open
revisions:
  - 2026-05-23: created during the 2026-05-23 spec amendment pass to record one deferral surfaced by the drift review against PRs #55–#65.
  - 2026-05-25: post-PR-#67 review pass — rewrote `[Risk] LogsPathOptions` to match the spec's revised `LogsPathInfo` singleton recommendation; fixed broken `§ 15.3` cross-link to point at the § 15.1 row; updated `last-updated` per the file-finalization convention used in this repo.
  - 2026-05-26: PR6 implementation — recorded the `LoadingScreen` third-swap-site no-op deviation against spec § 5.5 / plan PR6 Task 6.2 Step 3.
  - 2026-05-26: PR6 implementation — recorded the icon-asset shrink deviation against spec § 5.1's naive `cp` prescription (1.84 MB blocked Playwright `load` event).
---

# Deferrals — S6 polish and distribution

Decisions that surfaced during the 2026-05-23 amendment pass and were intentionally NOT absorbed into the S6 spec. Each entry names the source, severity (P0 = blocks merge, P1 = revisit before v2, P2 = noted for posterity, P3 = advisory only — no implementation action required), date, rationale, and the trigger that should reopen the decision.

The 2026-05-23 amendment pass itself folded its other findings directly into the spec (see § 15.1 of the design doc); this sidecar captures the items that were considered and explicitly deferred.

---

## Plan-time / amendment-time deferrals

### [Decision] Real-flow Playwright Replace-token spec deferred

- **Source:** 2026-05-23 amendment pass (cross-reference against PR #58 which shipped the real-flow harness against `prpande/prism-sandbox`).
- **Severity:** P2 — additive coverage, not blocking. The existing standard Playwright specs in § 11.4 (`replace-token-same-login.spec.ts`, `replace-token-different-login.spec.ts`, `replace-token-submit-in-flight.spec.ts`) already exercise the identity-change rule against fixture-controlled GitHub responses.
- **Date:** 2026-05-23
- **Reason considered:** PR #58's real-flow harness provides the strongest possible signal — live-GitHub validation against `prpande/prism-sandbox` PRs. Identity-change is exactly the kind of cross-cutting rule (Node IDs cleared, drafts preserved, foreign-pending-review path triggered on next submit) where a real-flow spec would catch wire-shape regressions the standard Playwright specs can't.
- **Why deferred:**
  - **Sandbox topology gap.** The real-flow harness today uses a single sandbox account (`prpande`'s PAT). A meaningful "different login" Replace-token spec needs a SECOND distinct GitHub account to swap to. Creating + maintaining that account is a real ongoing cost (PAT rotation, sandbox-PR access ACLs, leak-discipline for the second token in `fixtures.json`).
  - **Diminishing return vs. cost.** The standard Playwright specs in § 11.4 already mock the GraphQL boundary and assert the in-process identity-change rule end-to-end. The marginal bug a real-flow spec would catch is a GraphQL-wire-contract mismatch (the bug class PR #65 found for `pr-updated`) on the auth surface specifically — Replace token doesn't issue many GraphQL calls relative to the submit pipeline (one `viewer` query via `ValidateCredentialsAsync` and that's it). Catch rate is genuinely hard to estimate; PR #65 showed wire-shape risk is proportional to coverage gaps, not call volume, so the framing here is "smaller wire surface than submit-pipeline, combined with second-account cost, defers the spec" rather than a confident "low catch rate" claim.
  - **PR #58 precedent.** The real-flow suite ships with `retries: 0` and a 3-consecutive-green-runs pre-merge gate per `docs/e2e/real-flow.md`. Adding a fourth spec to the suite increases the suite's per-run wall-time AND the per-spec flake budget proportionally. Real-flow specs are expensive — each one must clear a "would this catch a bug the standard spec can't?" bar.
- **Revisit when:**
  - A second sandbox account becomes available (cost of standing up + rotating the PAT amortizes across enough specs).
  - A real-flow regression appears on the auth surface (validation, replace-token, identity-change) that the standard Playwright specs missed — that's evidence the real-flow lens IS catching something standard tests don't.
  - Multi-account v2 work begins — at that point the harness almost certainly needs a second-account flow anyway, and Replace-token becomes a free rider on that infrastructure.
- **Where the gap lives in code:** Nowhere — this is a not-added spec. The amendment doc's § 15.1 table (row "Real-flow Replace-token e2e") references this deferral by name. (Corrected 2026-05-25: earlier draft of this entry pointed at § 15.3, which doesn't exist — § 15.2 was added for the adversarial-round amendments and § 15.3 was collapsed during the same trim.)

### [Decision] `LoadingScreen` swap is two sites, not three — host-mismatch inline div does not exist

- **Source:** PR6 implementation 2026-05-26 — discovered while executing plan PR6 Task 6.2 Step 3.
- **Severity:** P3 — documentation correctness, not a behavioral gap. The runtime change matches spec intent.
- **Date:** 2026-05-26
- **Reason considered:** Spec § 5.5's table lists three rows under "After → `<LoadingScreen />`": (a) `App.tsx` initial `authState === null`, (b) `App.tsx` host-mismatch path before `HostChangeModal` renders, (c) `SetupPage.tsx` waiting for `authState`. Plan PR6 Task 6.2 Step 3 enumerates the same three sites and warns "round-1 ce-doc-review caught the missing third site". The implementer would naturally expect to find three `<div aria-busy="true">Loading…</div>` elements to swap.
- **Why deferred (no code change):**
  - **The third site doesn't exist in the current source.** `frontend/src/App.tsx` lines 39–53 (current `main` branch HEAD `6985264`) returns `<HostChangeModal ... />` directly from the `if (authState.hostMismatch)` branch with no inline `<div>` between the conditional and the return. `grep -n "aria-busy.*Loading" frontend/src/App.tsx` returns exactly one hit (the line-37 `if (authState === null)` branch).
  - **The line-37 site functionally covers both flows.** The `authState === null` check fires BEFORE the host-mismatch check. While `useAuth()` is still resolving, host-mismatch state is not yet known, so the user already sees `<LoadingScreen />` in the "loading before host-mismatch detected" window. Once `authState` resolves and `hostMismatch` is truthy, `<HostChangeModal>` renders directly with no intermediate loading frame — there is no observable moment where a "loading the modal" indicator would be useful.
  - **No behavioral gap.** The spec's intent — "no plain `Loading…` divs anywhere in the auth-resolution path" — is satisfied. The third-row entry is a spec/plan accounting artifact, not a real third call site.
- **Disposition:** PR6 swaps the two sites that exist (`App.tsx:37` and `SetupPage.tsx:158`); the third row in spec § 5.5 is harmless documentation drift. Two interpretations are consistent with how this row was authored: (a) an earlier App.tsx version (pre-PR-#43? pre-S5 host-change-resolution wiring?) had an inline loading div in the host-mismatch branch that was refactored away when `HostChangeModal` became the unconditional render in that branch, OR (b) the spec author counted "states the line-37 div covers" rather than "physical call sites" and the plan inherited the row verbatim. Both leave the user-visible behavior identical to what the spec describes.
- **Revisit when:** A future PR re-introduces an intermediate state in the host-mismatch branch (e.g., "verifying the new host's cert" or "fetching new-host fixtures" step) that needs its own loading frame. At that point, the third `<LoadingScreen />` slot becomes a real call site and the spec § 5.5 row becomes accurate again.
- **Where the gap lives in code:** Nowhere. The spec § 5.5 table is the documentation surface. Either trim the row when the spec next gets touched, or leave it as forward-looking documentation if the host-mismatch flow is expected to gain an intermediate state in v2.

### [Decision] Web icon assets are derived (resized) — not raw `cp` of canonical icons

- **Source:** PR6 implementation 2026-05-26 — discovered while running the pre-push Playwright pass.
- **Severity:** P2 — naive spec prescription would have shipped 1.84 MB of inline image data per page load. Caught before merge by the e2e suite. Future PRs touching `assets/icons/` need to re-derive, not re-copy.
- **Date:** 2026-05-26
- **Spec position vs. actual:** Spec § 5.1 prescribes a one-time `cp` of `assets/icons/PRismOG.png` (1.3 MB) → `frontend/public/prism-logo.png` and `assets/icons/PRism256.ico` (535 KB, multi-resolution pack containing 16/32/48/64/256/512 sub-icons) → `frontend/public/favicon.ico`. The "no build-pipeline changes" framing was load-bearing — the spec author wanted asset shipment to remain a manual step with no build dependency.
- **What broke:** The naive `cp` produced two issues:
  1. **Vite dev / Playwright page-load hang.** `<LoadingScreen>` renders the 1.3 MB PNG twice (watermark `<img>` + pulse `<img>`, sharing the same URL). The first download was being served by Vite dev (`http://localhost:5173/prism-logo.png`) with a `Content-Length: 1361495` header and a `Cache-Control: no-cache` response. Playwright's default `page.goto` `waitUntil: 'load'` blocks on the `load` event, which itself waits for every image to finish loading. Trace evidence: `frontend/test-results/inbox-AI-preview-toggle-reveals-activity-rail-dev-retry1/trace.zip` shows 10+ sequential 1.36 MB GETs in the first 3 seconds, and the page snapshot at test timeout is stuck on `<LoadingScreen>` because `page.goto` never returned control to the test. Every Playwright spec failed for the same reason — observed in `test-results/` as a complete `-dev` + `-dev-retry1` pair for each spec.
  2. **Favicon over-shipment.** Only the 16/32 sub-icons of `PRism256.ico` are useful for a browser favicon; the 256/512 sub-icons are dead weight (~95% of the 535 KB).
- **What the PR ships instead:**
  1. **`frontend/public/prism-logo.png` is a 256×256 derived PNG** (~22 KB) generated by `sharp` from `assets/icons/PRismOG.png`. Sized for crisp 2x HiDPI rendering at both the 96×96 LoadingScreen pulse and the 28×28 Header logo. Watermark uses the same image rescaled CSS-side via `width: 60vmin` — browser caching makes the second `<img>` reference a cache hit after the first 22 KB GET.
  2. **`frontend/public/favicon.png` is a 32×32 derived PNG** (~3 KB) generated by `sharp` from `assets/icons/PRismOG.png`. `frontend/index.html` references it via `<link rel="icon" type="image/png" href="/favicon.png">` (NOT `favicon.ico`). PNG favicons are supported by every browser that renders modern web content; the spec's `.ico` prescription was a conservative carryover, not a hard requirement.
  3. **`assets/icons/README.md` documents the derivation transforms verbatim** with the `node -e` invocations of `sharp` so a future maintainer regenerating the assets re-uses the same parameters. `sharp` is intentionally NOT a project dependency — installed ad-hoc with `npm install --no-save sharp` for the rare re-derivation event.
- **Why deviate from spec:** The spec § 5.1 framing of "manual copy, no build-pipeline change" was correct in spirit (the goal is zero ongoing complexity, not asset fidelity). A one-time hand-resized PNG/PNG pair satisfies that framing — the build pipeline is still untouched. The deviation is purely on the asset-shape side. Reverting to `cp` reintroduces the Playwright failure mode AND degrades dev-loop HMR speed.
- **Revisit when:**
  - PRism gains a build-pipeline asset transform (e.g., Vite imagetools plugin) — at that point, the manual derivation can be removed in favor of build-time generation.
  - `prism-logo.png` is used in contexts that need higher-DPI source (e.g., printable artwork, marketing assets) — at that point, the 256×256 cap might be tightened to a separate variant.
  - A future contributor proposes "let's just `cp` the canonical icon" — they need to read this entry first.
- **Where the gap lives in code:** `assets/icons/README.md` (re-derivation script), `frontend/public/prism-logo.png` + `frontend/public/favicon.png` (derived artifacts), `frontend/index.html` (PNG-favicon link tag), `docs/specs/2026-05-15-s6-polish-and-distribution-design.md` § 5.1 + § 5.3 (spec text not yet amended — flagged for next spec touch-up; this deferral is the authoritative override until then).

---

## Forward-looking residual risks for the implementer

Items the implementing engineer should keep an eye on during Phase 1 execution.

### [Risk] `LogsPathInfo` singleton — dual-derivation invariant against `FileLoggerProvider`

**Rewritten 2026-05-25 per PR #67 review.** The original entry described an `IOptions<LogsPathOptions>` / `LogsPathAccessor` approach that the 2026-05-25 adversarial round explicitly rejected; the spec now recommends a `LogsPathInfo(string Path)` singleton sourced from `dataDir` directly. This risk entry is preserved (renamed) to capture the actual residual invariant.

- **Where:** § 2.4 sources `logsPath` from a `LogsPathInfo` singleton registered in `Program.cs` from `dataDir` BEFORE `AddPRismFileLogger`. `FileLoggerExtensions.AddPRismFileLogger` independently computes `Path.Combine(dataDir, "logs")` internally (`FileLoggerExtensions.cs:34`). Both derivations being equal is an invariant, NOT a single-source guarantee. If a future refactor changes the `FileLoggerProvider` derivation (e.g., versioned log roots `Path.Combine(dataDir, "logs", appVersion)`), the `LogsPathInfo` singleton would silently diverge and the Settings page would surface a path no log file lives at.
- **Mitigation:** § 11.1's dual-derivation integration test (added 2026-05-25): with `PRISM_FILE_LOGGER_FORCE=1` set, construct the factory, write a log line through `FileLoggerProvider`, assert a `prism-YYYY-MM-DD.log` file exists in `LogsPathInfo.Path`. Drift bites the test, not the user.
- **Severity:** P2 (test-pinned).
- **Revisit when:** A future PR introduces versioned log roots or otherwise changes `FileLoggerExtensions.AddPRismFileLogger`'s internal derivation — at that point, refactor `FileLoggerExtensions` to read `LogsPathInfo` as the single source, which the round-2 amendment deliberately deferred to avoid scope-creeping into already-shipped PR #63 code.

### [Risk] `POST /api/auth/replace` is absent from the 16 KiB body-size-cap predicate

- **Source:** 2026-05-23 ce-doc-review security-lens pass.
- **Severity:** P3 (advisory — localhost-only threat model, mild DoS).
- **Date:** 2026-05-23
- **Where:** `PRism.Web/Program.cs:165-193` defines a `UseWhen` predicate that applies a 16 KiB body cap to mutating endpoints (`/api/events/subscriptions`, `PUT /api/pr/*/draft`, `POST /api/pr/*/reload`, `/submit`, `/submit/foreign-pending-review/*`, `/drafts/discard-all`). The new `POST /api/auth/replace` is not covered. An attacker who has obtained a session token can POST an arbitrarily large body, causing `JsonDocument.ParseAsync` to buffer the full payload before the PAT field is read.
- **Mitigation in v1:** None code-side. The threat model is localhost-only, so the realistic attacker is another localhost process or a browser extension with session-cookie access — both already have higher-impact paths available. The legitimate payload is ~40 chars (a PAT), so the cap would be ~99.9% headroom.
- **Revisit when:** PR2 implementer is wiring the endpoint — they can add `/api/auth/replace` (and arguably `/api/auth/*` as a class) to the `UseWhen` predicate as a one-line consistency fix without elevating this to a P0 blocker. Capture-and-fix rather than defer-and-track.
- **Severity rationale:** P3 because the threat model genuinely doesn't justify a code change before PR2 lands; treating this as a P0 would manufacture urgency for a 1-line consistency fix.

### [Risk] Existing `AuthEndpoints.cs` `LoggerMessage` methods silently redact GitHub login (forensic gap)

- **Source:** 2026-05-23 ce-doc-review security-lens pass.
- **Severity:** P2 (forensic visibility gap in existing code; not a disclosure risk — scrubber over-redacts, doesn't leak).
- **Date:** 2026-05-23
- **Where:** `PRism.Web/Endpoints/AuthEndpoints.cs:178` (`ConnectValidatedWithWarning`), `:180` (`ConnectCommitted`), `:188` (`CommitSucceeded`) — all three `[LoggerMessage]` source-generator methods declare a parameter named `login`. The `LoggerMessage` source generator emits the parameter name verbatim as the structured-log field key; `SensitiveFieldScrubber.BlockedFieldNames` includes `"login"` and matches case-insensitively (verified `SensitiveFieldScrubber.cs:41`). These three log lines therefore write `[REDACTED]` for the login value today.
- **Direction of harm:** the scrubber over-redacts — it does NOT leak; the bug is forensic completeness, not data disclosure. A maintainer grepping `<dataDir>/logs/` for `/api/auth/connect` outcomes sees `[REDACTED]` instead of the validated login, breaking the same "where did this token end up" reconstruction the S6 identity-change log was designed to support.
- **Mitigation in v1:** Out of scope for the S6 amendment (which is reviewing the polish-and-distribution spec). The fix is mechanical: rename the parameters to `validatedLogin` / `committedLogin` (3 one-line changes), or add a comment explicitly accepting the redaction as intentional. The S6 PR2 implementer is the natural owner of the fix since they'll be in the same file adding `LogIdentityChanged` with `priorLogin` / `newLogin` — extending the rename to the existing three sites is a one-commit follow-up.
- **Revisit when:** PR2 implementation begins; folding the rename into the same commit avoids a separate PR for three parameter renames.

### [Risk] LoggerMessage template-name discipline

- **Where:** § 3.6's amendment warns that any future call site emitting a bare `{login}` template argument would be silently redacted by `SensitiveFieldScrubber`. The current `LogIdentityChanged` argument names (`priorLogin`, `newLogin`) are safe, but a developer adding "log when validation succeeds" might intuitively pick `{login}`.
- **Mitigation:** No code change required in S6. Add a single line to `.ai/docs/behavioral-guidelines.md` or `CLAUDE.md` noting "if you need to log a GitHub login, pick a qualified name (priorLogin, newLogin, validatedLogin) — bare `{login}` is auto-redacted." Out of scope for S6; capture as a v2 backlog or behavioral-guidelines amendment.
- **Severity:** P3 (advisory).

### [Decision] `usePreferences` stays per-consumer; PreferencesContext refactor deferred

- **Source:** PR #71 (S6 PR3) post-open `@claude review` pass (2026-05-26).
- **Severity:** P2 — network chattiness, not correctness. Doesn't block merge per the reviewer's own framing.
- **Date:** 2026-05-26
- **Where:** `frontend/src/hooks/usePreferences.ts` exposes a per-consumer `useState` + window-focus listener. On `/settings`, the three section components (Appearance, InboxSections, Connection) PLUS `HeaderControls` each call `usePreferences()` → four independent state instances → four parallel `GET /api/preferences` requests on every `focus` event. PR #71's Copilot review (finding #2) caught the analogous problem for `useAuth()` in `Header` and fixed it by prop-drilling `hasToken` from `App`. The `usePreferences` case is the same pattern but with N=4 consumers instead of 2.
- **Why deferred:**
  - The reviewer (claude[bot]) explicitly framed this as "doesn't need to block this PR if the architectural change is scoped to a follow-up." Adding a `PreferencesContext` + `PreferencesProvider` is a small refactor in isolation but touches every existing `usePreferences()` call site (`HeaderControls`, `InboxPage`, `PrHeader`, `OverviewTab`, `AiComposerAssistant`, plus the three new Settings sections) and every mocked-`usePreferences` test (~10+ files). The DOM-side cross-component sync problem PR3 hit (theme picker in /settings didn't update HeaderControls) was already solved by extracting `applyThemeToDocument` to a shared util; the remaining issue is purely network chattiness.
  - PR3's diff is already large (+1148 / -73 across 21 files) and has been through one adversarial preflight pass + Copilot inline + `@claude review`. Scope-creeping a context refactor would invalidate the existing review and burn another review cycle.
  - Wall-clock impact is bounded: `/api/preferences` is a small JSON response served by the local Kestrel; 4 parallel GETs per focus are wasteful but not user-visible. The frontend client has no rate-limit concerns against a local backend.
- **Revisit when:**
  - Another section is added to `/settings` (more parallel fetchers — the linear scaling makes the fix more obvious).
  - `useAuth` and `usePreferences` both get a context refactor in the same PR (amortizes the touch cost of updating every consumer + test).
  - Telemetry or profiling surfaces measurable focus-handler latency on `/settings`.
- **Where the gap lives in code:** `frontend/src/hooks/usePreferences.ts` (per-consumer `useState`); `frontend/src/pages/SettingsPage.tsx` (composes three direct callers); `frontend/src/components/Header/HeaderControls.tsx` (fourth caller, always mounted).

---

## Note on the deferrals format

This sidecar mirrors the format of [`2026-05-11-s5-submit-pipeline-deferrals.md`](2026-05-11-s5-submit-pipeline-deferrals.md) and [`2026-05-10-multi-account-scaffold-deferrals.md`](2026-05-10-multi-account-scaffold-deferrals.md): `[Decision]` and `[Risk]` entries with severity, date, reason, revisit-trigger, where-the-gap-lives.
