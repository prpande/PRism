---
source-doc: docs/specs/2026-05-15-s6-polish-and-distribution-design.md
plan-doc: docs/plans/2026-05-15-s6-polish-and-distribution.md
created: 2026-05-23
last-updated: 2026-05-27
status: open
revisions:
  - 2026-05-23: created during the 2026-05-23 spec amendment pass to record one deferral surfaced by the drift review against PRs #55–#65.
  - 2026-05-25: post-PR-#67 review pass — rewrote `[Risk] LogsPathOptions` to match the spec's revised `LogsPathInfo` singleton recommendation; fixed broken `§ 15.3` cross-link to point at the § 15.1 row; updated `last-updated` per the file-finalization convention used in this repo.
  - 2026-05-26: PR6 implementation — recorded the `LoadingScreen` third-swap-site no-op deviation against spec § 5.5 / plan PR6 Task 6.2 Step 3.
  - 2026-05-26: PR6 implementation — recorded the icon-asset shrink deviation against spec § 5.1's naive `cp` prescription (1.84 MB blocked Playwright `load` event).
  - 2026-05-26: PR6 implementation — recorded the pre-existing Vite-proxy `Origin` header gap that causes every `dev`-project Playwright spec to 401 locally under `ASPNETCORE_ENVIRONMENT=Test`.
  - 2026-05-27: PR7 implementation — recorded the VoiceOver manual pass deferral (no macOS dogfood machine available to the implementer).
  - 2026-05-27: PR9 implementation — recorded three plan-vs-as-built deviations: (a) RELEASE-LINK strategy switched from per-tag URLs to GitHub `/releases/latest` auto-redirect; (b) plan Task 9.3 Step 5 `assets/icons/README.md` duplication note skipped (file was already amended in PR #74 with derived-icon framing); (c) viewport regression spec uses scenario PR `acme/api/123` and a new `/test/emit-pr-updated` backend hook (the plan's `/test/advance-head` trigger is defeated by the PR0b cache pre-warm, which makes `ActivePrPoller` see no mismatch and never publish `ActivePrUpdated`).
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

### [Decision] Local `dev`-project Playwright specs 401 under Test env — pre-existing Vite-proxy `Origin` gap, not blocking S6 PR6 merge

- **Source:** PR6 implementation 2026-05-26 — surfaced during the pre-push checklist after the icon-asset shrink moved past the prior load-event hang.
- **Severity:** P2 — local-only pre-push gap. CI is unaffected: `playwright.config.ts` runs only the `prod` project under `isCI`. Documented as a known-pre-existing condition so future implementers stop debugging it as a regression.
- **Date:** 2026-05-26
- **Where:** `frontend/vite.config.ts` defines a plain `proxy: { '/api': 'http://localhost:5180' }`. Browser GETs to `http://localhost:5173/api/auth/state` are same-origin, so the browser omits the `Origin` header per the Fetch spec. Vite's http-proxy forwards the browser headers verbatim, so the upstream request to Kestrel at `:5180` also lacks `Origin`. `PRism.Web/Middleware/SessionTokenMiddleware.cs:50-92` enforces session-token auth under Test env via three bypass branches: (i) `/api/health` liveness, (ii) loopback-different-port via the `Origin` header (lines 84-92), (iii) valid `X-PRism-Session` header OR `prism-session` cookie. The Vite-proxied GET hits none of these: no `Origin` (Vite passthrough), no `prism-session` cookie (Vite served the HTML, not Kestrel — the cookie-stamp middleware never ran), no `X-PRism-Session` header (the SPA reads it from a cookie it doesn't have). Result: `401 application/problem+json` with `"type": "/auth/session-stale", "detail": "Session token mismatch — reload the page to refresh."`.
- **Empirical confirmation that this is pre-existing:** During PR6 pre-push, ran `npx playwright test cold-start` from the unmodified `main` checkout at `D:\src\PRism\frontend` (commit `6985264`, the PR #73 merge — no PR6 changes present). Stats: `expected: 3, unexpected: 3, flaky: 0`. The 3 cold-start specs each ran in both projects; prod (3) passed and dev (3) failed with the identical `Failed to load auth state: HTTP 401` alert at the same locator timeout. Manual verification: `curl http://localhost:5180/api/auth/state` → 401; `curl -H "Origin: http://localhost:5173" http://localhost:5180/api/auth/state` → `200 {"hasToken":false,...}`. The bypass works iff `Origin` is present; Vite isn't sending it.
- **Why the gap survived prior PRs:** CI gates only the prod project (per the `isCI` carve-out in `playwright.config.ts:39+118`); prior PRs (`#69`-`#73`) passed CI without locally stress-testing the dev project, OR ran step 5 only against prod, OR ignored local dev-project failures as known-noise. Memory entries for PR71-73 cite "Playwright" green at exit without specifying project; this deferral retroactively pins what that meant.
- **Why deferred (not folded into PR6):**
  - **Out of S6 PR6 scope.** PR6 is "icon assets + branded LoadingScreen" — touching `vite.config.ts` to add an `Origin` header on `/api` proxy requests is auth-pipeline plumbing, not loading-state polish.
  - **One-line fix already understood.** The remediation is: pass `proxy: { '/api': { target: 'http://localhost:5180', configure: (proxy) => { proxy.on('proxyReq', (proxyReq) => { proxyReq.setHeader('Origin', 'http://localhost:5173'); }); } } }`. A follow-up PR should land this with a single Playwright spec exercising a fresh-cookie dev GET to confirm the bypass fires.
  - **No user-visible regression.** `dotnet watch run` (the canonical dev workflow) defaults to `Development` env, where `SessionTokenMiddleware._enforced` is `false`. The 401 ONLY appears when the env is forced to `Test` — i.e., during Playwright's webServer-managed backend. Real developers running `npm run dev` + `dotnet watch run` are unaffected.
  - **Pre-existing on `main`.** Folding the fix into PR6 would mean PR6's diff is partially about auth-pipeline plumbing the implementer didn't sign up for, AND PR6's review surface conflates "loading state polish" with "dev-mode auth bypass". Better hygiene to land them separately.
- **Revisit when:**
  - The next PR that touches `frontend/vite.config.ts` or `PRism.Web/Middleware/SessionTokenMiddleware.cs` — both are natural homes for the Vite-side Origin fix.
  - A contributor reports "local Playwright doesn't pass on `npm run pre-push`" — that is THIS issue; point them at this entry.
  - The pre-push checklist in `.ai/docs/development-process.md` is amended (e.g., to clarify "prod-only suffices locally pending the Vite Origin fix").
- **Where the gap lives in code:** `frontend/vite.config.ts:8-10` (plain proxy, no `configure` hook); `PRism.Web/Middleware/SessionTokenMiddleware.cs:84-92` (Origin-only bypass branch). The fix is at the Vite layer, not the middleware (the middleware already correctly accommodates the dev port via Origin — it just isn't receiving one from Vite). A standalone follow-up branch can land the `configure` hook + one Playwright assertion in a ~10-line diff.

---

### [Decision] VoiceOver manual pass deferred — no macOS dogfood machine

- **Source:** PR7 implementation 2026-05-27 — spec § 6.1 Pass 3 ("Manual VoiceOver pass on macOS dogfood machine") + plan PR7 Task 7.2 Step 4 both prescribe a manual SR walkthrough. The implementer is on Windows and has no macOS host available for this slice.
- **Severity:** P2 — Pass 1 (automated axe-core) + Pass 2 (manual grep + fixes) already shipped in PR7 and cover the bulk of the DoD § 13 a11y bullets. VoiceOver-specific behavior (unique to macOS Safari + VO interaction model) is the residual gap.
- **Date:** 2026-05-27
- **What was shipped in PR7:**
  - Pass 1 (automated): new `frontend/e2e/a11y-audit.spec.ts` runs `@axe-core/playwright` against `/setup`, `/`, `/pr/octocat/Hello-World/1`, `/pr/octocat/Hello-World/1/files`, `/pr/octocat/Hello-World/1/drafts`, `/settings`, and the cheatsheet-open state. Asserts 0 serious/critical violations. Plus the fold-in `prefers-reduced-motion` LoadingScreen verification.
  - Pass 2 (manual fixes): `--text-3` token bumped from `oklch(0.58)` to `oklch(0.48)` in light mode so 12-14px body text against `surface-0` clears WCAG AA 4.5:1; `.sr-only` utility added to `tokens.css`; `PrSubTabStrip` count badge gains an `sr-only` companion (`", N items"` form) so screen readers announce "Files, 3 items" rather than bare "Files 3"; the existing `:focus-visible` rule in `tokens.css` already applies globally to every interactive element.
  - Pass 2 (verification): grep-audit of `Badge` / `Chip` / count-rendering components recorded — every remaining count chip (InboxRow comment counts, InboxSection counts, cross-tab presence badges) is already inside a `button` with `aria-label` that names the surrounding context (the `<span>{count}</span>` is suppressed from the accessible name computation), or is itself the accessible-name-providing text (e.g., section toggle button "Review requested 1").
- **What is deferred (Pass 3):**
  - VoiceOver-driven walkthrough of: unread badges on inbox rows, viewed checkbox toggle on Files tab, iteration tab strip navigation, composer open/dismiss/discard-confirm, cheatsheet open/close, LoadingScreen pulse + label, Replace-token UX (which lives at `/setup?replace=1` and isn't covered by axe-core directly).
  - Anything VoiceOver-specific that axe-core's heuristic rules don't surface — e.g., rotor-navigation friendliness of landmarks, focus-trap semantics under aria-modal="false" (the cheatsheet), live-region announcement timing for toasts.
- **Why deferred (not folded into PR7):**
  - No macOS host. The spec explicitly calls for "the macOS dogfood machine" because VoiceOver is the only mainstream SR with deep semantics-rotor behavior — running NVDA on Windows isn't a substitute for the spec's intent.
  - Pass 1 + Pass 2 are sufficient to close every line item in DoD § 13 ("Semantic landmarks", "ARIA on icon-only buttons", "Keyboard-navigable file tree", "Focus rings visible", "WCAG AA color contrast", "SR-only badge labels") with axe-core evidence + grep audit. The DoD doesn't require VoiceOver evidence specifically; spec § 6.1 Pass 3 is an additional confidence pass, not a DoD line.
  - The PoC's user base is the 5-dogfooder cohort (per spec § 1.1) — at least one will be on macOS and can drive the manual pass once the binaries from PR8 ship.
- **Revisit when:**
  - The implementer (or any contributor) has access to a macOS host and can run the walkthrough.
  - A dogfooder on macOS reports SR friction — that becomes the reproducer.
  - PR8 ships and the macOS binary is available; the walkthrough becomes part of the v0.1.0 acceptance-test pass.
- **Where the gap lives in code:** Nowhere — this is a verification-pass deferral, not a code defect. The spec is correctly calling out a manual check that isn't reproducible on the current host. If VoiceOver surfaces issues later, the fixes would land in the same component surface area Pass 2 already touched.

---

### [Decision] PR9 RELEASE-LINK uses `/releases/latest` auto-redirect, not per-tag URLs

- **Source:** PR9 implementation 2026-05-27 — plan Task 9.2 Step 1 + Step 2 instructed "Substitute `RELEASE-LINK` with the actual Release URL after PR8's first real-tag dispatch."
- **Severity:** P3 — README text is the only surface; no behavioral implication. The choice is a one-way door (later switching to per-tag URLs is a 4-line edit).
- **Date:** 2026-05-27
- **Spec position vs. actual:** Plan PR9 Task 9.2's "Replace the Status section" and "Add Download and first run" blocks both use `RELEASE-LINK` as a placeholder, with explicit instruction to substitute "after PR8's first real-tag dispatch." The plan author's sequencing assumed PR8 would dispatch before PR9 was cut.
- **What the PR ships instead:** Every `RELEASE-LINK` resolves to `https://github.com/prpande/PRism/releases/latest` (for the listing page link) or `https://github.com/prpande/PRism/releases/latest/download/<asset>` (for the platform-specific binary links). GitHub serves these as a 302 redirect to whatever the latest published release is, so:
  1. The README does not need a follow-up patch commit after each release tag.
  2. The very first reader after the first `workflow_dispatch` lands on the actual binary; no manual link substitution step exists to be forgotten.
  3. Pre-dispatch readers see a 404 on the links — the README's Status section explicitly names this state ("**S6 complete; first binary publish pending.**" + "Until the first dispatch, the links above return 404.") after preflight adversarial round-1 pushed back on the original "**Released.**" framing as overclaiming relative to the empty `releases` list.
- **Why deviate from plan:** The plan's "substitute after dispatch" model assumed PR8 dispatch would precede PR9. The user's actual pattern (per memory `project_pr76_s6_pr8_shipped`) parks `workflow_dispatch` verification (plan Task 8.4) as post-merge work, so PR9 ships before the first dispatch. Two compliant choices: (a) merge PR9 with broken placeholder URLs and add a follow-up commit post-dispatch, (b) use `/releases/latest`. Option (b) avoids a follow-up commit AND avoids the "what if the maintainer forgets the substitution" failure mode.
- **Revisit when:**
  - The maintainer prefers per-tag URLs for forensic reasons (e.g., the README mentions "v0.1.0" and an immutable URL to that tag's binary is desirable as evidence of which binary was current at README-write time). At that point, swap to `releases/download/v0.1.0/<asset>` URLs in a one-off commit.
  - GitHub changes `/releases/latest` redirect semantics — unlikely; it's a stable URL contract that's been documented for years.
- **Where the gap lives in code:** `README.md` Status section + Download and first run section. No other surface references the release URL.

### [Decision] PR9 Task 9.3 Step 5 — `assets/icons/README.md` duplication note skipped

- **Source:** PR9 implementation 2026-05-27 — plan Task 9.3 Step 5 prescribes appending a "Frontend asset duplication" section to `assets/icons/README.md` with the original `PRismOG.png → frontend/public/prism-logo.png` + `PRism256.ico → frontend/public/favicon.ico` mapping plus "If the canonical icons change, **re-copy** to the frontend `public/` directory in the same PR."
- **Severity:** P3 — documentation correctness, not behavioral.
- **Date:** 2026-05-27
- **Spec position vs. actual:** Plan Task 9.3 Step 5 is rooted in the spec § 5.1 prescription of "raw `cp` of canonical icons." That prescription was overridden by the PR6 deferral above (`Web icon assets are derived (resized) — not raw cp of canonical icons`) — PR #74 amended `assets/icons/README.md` with a derived-icon transform table (`sharp` re-derivation script + size annotations) and rewrote the duplication framing as "derived, web-optimized copies."
- **Why deviate from plan:** Re-applying plan Task 9.3 Step 5 verbatim would have prepended OR overwritten the PR6 amendment with the original raw-`cp` prescription, reintroducing the very bug the PR #74 deferral documents (1.84 MB inline image data blocking Playwright `load` event). The PR6 amendment is authoritative and already in the repo.
- **Disposition:** Task 9.3 Step 5 is recorded as completed by PR #74. The deferral above continues to govern. No PR9 edit to `assets/icons/README.md`.
- **Revisit when:** A future PR re-introduces raw `cp` of canonical icons (which would require build-pipeline asset transforms to make load-time-safe) — at that point, plan Task 9.3 Step 5's mapping section would become valid again.
- **Where the gap lives in code:** `assets/icons/README.md` already documents the correct (derived) mapping. The plan's Task 9.3 Step 5 text is the documentation surface; it could be marked "superseded by PR #74" in a future spec touch-up.

### [Decision] PR9 viewport regression — new `/test/emit-pr-updated` backend hook over plan's `/test/advance-head`

- **Source:** PR9 implementation 2026-05-27 — plan Task 9.1 Step 2 prescribes:
  ```ts
  await page.request.post('/test/advance-head', {
    data: { prRef: 'octocat/Hello-World/1', newHeadSha: 'feedfacedeadbeef' },
  });
  ```
- **Severity:** P3 — test-mechanism choice. The test still asserts the same DoD invariant ("no layout shift when a PR with new commits arrives").
- **Date:** 2026-05-27
- **Spec position vs. actual:** The plan's example assumed `/test/advance-head` would trigger the `ActivePrPoller → ActivePrUpdated → SseChannel.OnActivePrUpdated → pr-updated event → BannerRefresh renders` chain. It would have, before PR0b. Per the S5 PR0b commit message and `PRism.Web/TestHooks/TestEndpoints.cs:115-117`, `/test/advance-head` now also synchronously updates `IActivePrCache` to the just-advanced sha — added so the three un-fixme'd S4 specs that exercise `advanceHead → reload` don't 409-race the ~1s poller. The cache update is invisible to those specs but defeats PR9's poller-driven banner trigger entirely: the poller compares against the cache, sees no mismatch, and never publishes the event.
- **What the PR ships instead:** A new `/test/emit-pr-updated` Test-environment endpoint that publishes `ActivePrUpdated` directly via `IReviewEventBus`. Same wire shape, same SSE projection, same frontend handling — the test exercises `SseChannel.OnActivePrUpdated → projection → frontend useEventSource → useActivePrUpdates → BannerRefresh` end-to-end. The only path skipped is the `ActivePrPoller` itself, which is unrelated to PR9's layout assertion.
- **Why deviate from plan:**
  - The plan's mechanism is broken-by-design under the current code (`IActivePrCache` pre-warm in `/test/advance-head` is the load-bearing fix for prior-S4-spec races; we can't reasonably revert it).
  - Alternative explored (DOM injection via `page.evaluate`) would be synthetic — bypasses React rendering + CSS class application + SSE plumbing, exercises only DOM layout policy. That's a weaker signal than the end-to-end trigger.
  - Alternative explored (frontend test hook on `window` to force `hasUpdate=true`) requires adding `__prism_test_*` to production code paths for one test — broader blast radius than a Test-env-only backend endpoint.
  - The new endpoint is a 15-line addition, mirrors the existing `/test/*` hook pattern, sits behind the same `Test`-environment guard, and exercises strictly more code (event bus + SSE channel + projection + frontend hook chain) than DOM injection.
- **Also deviated:** Plan's example PR ref `octocat/Hello-World/1` does not exist in the fake backend; the canonical scenario PR is `acme/api/123` (per `PRism.Web/TestHooks/FakePrReader.cs`). The plan example was illustrative; spec uses the real scenario.
- **Where the gap lives in code:**
  - `PRism.Web/TestHooks/TestEndpoints.cs` — new `EmitPrUpdatedRequest` record + `app.MapPost("/test/emit-pr-updated", ...)` handler after `/test/advance-head`. Preflight adversarial round-1 added two consistency checks: 400 when `HeadShaChanged && NewHeadSha == null`, and 400 when `CommentCountChanged != (CommentCountDelta != 0)` — a typo'd test request now surfaces as 400 instead of an opaque downstream timeout.
  - `frontend/e2e/no-layout-shift-on-banner.spec.ts` — calls the new endpoint with `headShaChanged: true` and the scenario PR's `acme/api/123` ref. The spec also (a) awaits the `POST /api/events/subscriptions` response (set up before navigation) before emitting the event, closing the subscription-vs-publish race that preflight surfaced, and (b) guards the supplementary `toHaveScreenshot` assertion with `if (process.platform === 'win32')` so Linux/macOS contributors don't hit a missing-baseline failure (the load-bearing `getBoundingClientRect` block above runs on every platform).
  - `frontend/e2e/__screenshots__/win32/pr-detail-with-banner-masked.png` — Windows-baseline screenshot (renamed from `pr-detail-no-banner.png` after preflight — the snapshot is captured AFTER the banner appears with the banner zone masked, so the new name describes what the bytes actually are). Per-platform pathTemplate keeps Linux/macOS contributors from poisoning the diff.

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
