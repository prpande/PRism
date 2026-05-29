---
date: 2026-05-29
topic: design-parity-recovery
kind: deferrals-sidecar
source-doc: docs/specs/2026-05-29-design-parity-recovery-design.md
plan-doc: docs/plans/2026-05-29-design-parity-recovery-pr1-foundation.md
---

# Design parity recovery — deferrals sidecar

Companion to [`2026-05-29-design-parity-recovery-design.md`](2026-05-29-design-parity-recovery-design.md) and the PR1 plan [`2026-05-29-design-parity-recovery-pr1-foundation.md`](../plans/2026-05-29-design-parity-recovery-pr1-foundation.md). Captures decisions / deferrals that surface during implementation; new entries are appended below.

---

## PR1 — Foundation

### D1 — HandoffParityFixture: cost-to-gate fallback selected

**Date:** 2026-05-29 (PR1 implementation).
**Spec §:** 4.1.1.
**Decision:** Skip the new `HandoffParityFixture` C# class and the `POST /test/load-handoff-parity-fixture` endpoint. PR1 ships no fixture work. Side-by-side review uses the existing `acme/api/123` scenario fixture (`FakeReviewBackingStore.Scenario`) as the implementation side; the locally-loaded handoff prototype (`design/handoff/PRism.html`) provides the reference side.
**Why:** `FakeReviewBackingStore.Scenario` is a `public static readonly` field hardcoded across `FakePrReader`, `FakePrDiscovery`, `FakeReviewSubmitter`, and the test endpoints in `PRism.Web/TestHooks/TestEndpoints.cs`. Multi-scenario extension requires either a registry refactor (every fake takes a per-call reference; the singleton becomes a dictionary) or a parallel store singleton (separate DI registration). Either path is 2-3 days of work plus rework risk on the existing E2E suite (24 specs depend on the current single-scenario shape). The spec's cost-to-gate threshold (~1 day) is exceeded. The marginal value of identical fixture content over the locally-loaded prototype is acknowledged but is not the parity gate — the human side-by-side review is, per spec §4.1.4.
**Consequence:** Reviewers comparing the implementation side against the prototype work with _different PRs_ (acme/api/123 "Calc utilities" vs handoff's `#1842` "Refactor LeaseRenewalProcessor"). The comparison is structural ("does this section's card layout match?") rather than content-matched ("does the title wrap at the same column?"). Per spec §4.1.4 this is acceptable for the parity gate; § 4.1.1's stated benefit of "exercises the real render pipeline" still holds because the scenario fixture also exercises the real render pipeline.
**Reversible:** Yes. If a later PR finds the comparison-on-different-content harder than anticipated, a follow-up slice can pay the extension cost. PR1 sets up no obstacle to that.
**Cross-refs:** Spec §4.1.1 cost-to-gate fallback paragraph; the `setupAndOpenHandoffParityFixture` helper landing in Task 4 is a thin alias rather than a fixture-loading entry point.

### D2 — Reconciliation-panel baseline deferred to PR5

**Date:** 2026-05-29 (PR1 implementation).
**Spec §:** 4.1.3.
**Decision:** Drop the `pr-detail-reconciliation-panel` test from PR1's `parity-baselines.spec.ts`. Re-add it in PR5 when the reconciliation surface is restored.
**Why:** The `UnresolvedPanel` component currently exposes only `data-testid="unresolved-panel-announce"` (an aria-live region inside the component) — there is no container `data-testid` to capture the panel's visual zone. Adding a container `data-testid` is a JSX touch that belongs in PR5's slice (where `UnresolvedPanel` gets its module CSS). PR1's "no production code edits" rule (§4.1.5) prevents adding the selector here. The baseline for the dormant reconciliation panel state captures in PR5 alongside the styled state.
**Reversible:** Yes. PR5 re-adds the test definition + adds the container `data-testid` + captures the baseline in one slice.
**Cross-refs:** Spec §4.1.3 zone list; spec §4.5 PR5 scope (Reconciliation surface).

### D3 — Sibling 401 endpoints (PrSubmit / PrDraftsDiscardAll) not flipped

**Date:** 2026-05-29 (PR1 implementation).
**Spec §:** 4.1.2.
**Decision:** Leave `PrSubmitEndpoints.SubmitAsync`, `ResumeForeignPendingReviewAsync`, `DiscardForeignPendingReviewAsync`, and `PrDraftsDiscardAllEndpoint.DiscardAllAsync` returning 401 (`"unauthorized"` SubmitErrorDto code) on `IsSubscribed == false`. Do NOT flip them to 403 in PR1.
**Why:** These are user-triggered mutating actions (submit, resume, discard). For the dev-mode cascade to fire, the user would have to dispatch one of these actions BEFORE the SSE-subscribe loop completes — which is structurally rare (the subscribe POST is `useEffect`-driven and fires on PR-detail mount, well before any user can click Submit or Resume). The Events/Subscribe path is different because it fires _automatically_ on every PR detail navigation, so its 401 is the one that user-visibly bounces. Flipping submit/resume/discard would be a defensive change with no current symptom.
**Reversible:** Yes. If a future report observes a dev-mode bounce from a Submit action, the same 401→403 reasoning applies — flip those endpoints in a follow-up slice. `apiClient.ts`'s 401→prism-auth-rejected dispatch stays the load-bearing trigger; widening the 401→403 conversion is a narrow surface.
**Cross-refs:** Audit performed in PR1 plan Task 2 Step 2.6; affected endpoints enumerated in `grep -rn "Status401Unauthorized" PRism.Web/Endpoints/` output.

### D4 — `Calc.cs` selector brittleness inherited by PR4

**Date:** 2026-05-29 (PR1 code-quality review of commit 97cc96d).
**Spec §:** 4.1.3 / Task 5.
**Decision:** PR1's `parity-baselines.spec.ts` test `pr-detail-files-diff` selects the file row via `page.locator('[data-testid="files-tab-tree"]').getByText('Calc.cs').click()`. The substring `Calc.cs` matches any node containing that text (rows, breadcrumbs, tooltips) and would fail strict-mode if the scenario fixture later grows a second file matching. PR4 (Files tab restoration) MUST ship a stable per-file selector — e.g. `[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]` — at the same time as the `[data-testid="files-tab-tree"]` and `[data-testid="files-tab-diff"]` selectors, and update this test to use it.
**Why:** PR1's test is dormant (the `[data-testid="files-tab-tree"]` outer selector doesn't exist yet, so the test fails at locator timeout long before reaching the `Calc.cs` click). Tightening it in PR1 would be speculative against unwritten DOM. PR4 owns the DOM; PR4 owns the selector.
**Reversible:** N/A (no code change in PR1; this is a hand-off note to PR4).
**Cross-refs:** Spec §4.5 PR4 scope; Task 5 code-quality review of commit 97cc96d (M-1 + I-1).

### D5 — Retry-0 setup-form-fill flake (known, absorbed by playwright `retries: 1`)

**Date:** 2026-05-29 (PR1 implementation of Task 5).
**Spec §:** 4.1.3 / Task 5.
**Decision:** PR1's `parity-baselines.spec.ts` exhibits a retry-0 flake in `setupAndOpenScenarioPr`'s setup-form-fill step (`getByLabel(/personal access token/i).fill(...)`). The flake manifests as the fill landing before React has hydrated the form input; retry-1 succeeds because the page is warmed. The existing `retries: 1` in `playwright.config.ts` absorbs it, so PR1 ships the spec without addressing the root cause.
**Why:** Fixing the flake requires diagnosing `setupAndOpenScenarioPr`'s post-navigation wait conditions (likely a missing await on a post-hydration marker) — out of scope for the parity slice. The retry mechanism contains the symptom. Documenting here so a future PR can pick it up cleanly.
**Reversible:** Yes — fix the helper to await a post-hydration marker and the flake goes away.
**Cross-refs:** Task 5 code-quality review of commit 97cc96d (I-2); `frontend/e2e/helpers/s4-setup.ts` `setupAndOpenScenarioPr`.

---

## PR2 — PR Detail chrome

### D6 — No handoff CSS source for 3 of 5 PR2 components

**Spec position:** §4.2 lists `BannerRefresh`, `CrossTabPresenceBanner`, `ImportedDraftsBanner` as scope items receiving module CSS, alongside the handoff-restored `PrHeader` and `PrSubTabStrip`.

**Reality:** Grep against `design/handoff/screens.css` and `design/handoff/*.jsx` returns zero matches for `banner-refresh*`, `cross-tab-presence-banner*`, and `imported-drafts-banner*`. The handoff's update-banner equivalent uses bare `.banner` (`design/handoff/tokens.css:396`, already ported to `frontend/src/styles/tokens.css:422`).

**Plan resolution:** Compose each component with the global(s) appropriate to its surface; module CSS authors only the additional layout (action-group flex, paragraph spacing) the globals don't ship.

- **BannerRefresh** composes with bare `.banner` (info-tint + padding + bottom border + horizontal flex). Module supplies action-group flex.
- **CrossTabPresenceBanner** composes with bare `.banner` in the visibility-only state and `.banner banner-warning` in the `readOnly` state (warning tint overlay). Module supplies action-group flex.
- **ImportedDraftsBanner** composes only with `.banner-warning` (warning tint). It does NOT compose with bare `.banner`, because `.banner`'s `align-items: center` would horizontally center each `<p>` sibling in a multi-paragraph layout — visually wrong for left-aligned warning copy. The component's parent (`ForeignPendingReviewModal`) provides the container padding that bare top-level banners need from `.banner`. Module supplies multi-paragraph spacing (flex-column + gap + `<p>` margin reset).

**Status:** Applied in PR2.

### D7 — ImportedDraftsBanner on-disk path differs from spec §3.2 layout

**Spec position:** §3.2 lists `PrDetail/ImportedDraftsBanner.tsx + ImportedDraftsBanner.module.css` at the PrDetail top level.

**Reality:** The component lives at `frontend/src/components/PrDetail/ForeignPendingReviewModal/ImportedDraftsBanner.tsx`.

**Plan resolution:** Module CSS colocated with the actual on-disk file (no move). Spec §3.2 file layout was speculative; on-disk path is authoritative.

**Status:** Applied in PR2.

### D8 — Latent .btn-link CSS gap

**Spec position:** §3.1 implies `.btn*` primitives all live in `tokens.css`.

**Reality:** `CrossTabPresenceBanner.tsx:56` uses `btn btn-link btn-sm` but `.btn-link` has no rule in `tokens.css` or any module. Buttons today render with default browser button styling.

**Plan resolution:** Added a minimal `.btn-link` rule to `tokens.css` (transparent background, accent foreground, underline + hover state) alongside the existing `.btn-icon` block. Single consumer today, but it's a button variant — `tokens.css` is its semantic home for future use.

**Status:** Applied in PR2.

### D9 — Dormant JSX classes that are debris, not state hooks

**Spec position:** §6.2 says dormant CSS rules referencing unset attributes get ported as-is.

**Reality:** Some PrHeader JSX classes (`pr-meta`, `pr-meta-repo`, `pr-subtitle-author`, `pr-subtitle-branch`) have **no** rules in `screens.css` or any module — they aren't unset attributes, they're unset classes. PrSubTabStrip's `.is-disabled` is the only real state hook (the JSX uses it conditionally).

**Plan resolution:** PR2 authors a minimal `.prTab.isDisabled` rule (opacity + pointer-events) for the real state hook. The other four dormant classes stay as bare globals in the JSX so future styling has an anchor, but no rule is authored. The deferrals sidecar logs them so a future restoration PR doesn't re-discover the pattern.

**Status:** Applied in PR2.

### D10 — Test-selector migration via data-testid (not class-rename)

**Spec position:** §6.1 says "rename these selectors when the `.pr-tab-count` class moves into `PrSubTabStrip.module.css`."

**Reality:** Renaming to a hashed module class would require importing the module into each test file, which Vite's CSS-modules build doesn't support across the vitest + Playwright boundary cleanly.

**Plan resolution:** Migrate the affected test files to `[data-testid="..."]` selectors instead. PR2 adds `data-testid="pr-title"`, `data-testid="pr-tab-count"`, and `data-testid="imported-drafts-banner"` to the JSX as part of the slice (small scope addition to the otherwise-classname-only edit). Matches the project's standing preference for `data-testid` over class selectors (spec §4.1.3 note). Six spec files migrated in Task 3 (the third selector — `.imported-drafts-banner` in `s5-submit-foreign-pending-review.spec.ts:64` — was surfaced by Task 1 pre-flight, not the original spec §6.1 survey).

**Status:** Applied in PR2.

### D11 — pr-tab-count warn variant remains unwired in production JSX

**Spec position:** §4.2 says "three-tab sub-strip with proper active-state visual." Implicit: visual states match the handoff, which applies `pr-tab-count-warn` to the Drafts tab's count when `draftCount > 0` (`design/handoff/pr-detail.jsx:131`).

**Reality:** The current `PrSubTabStrip.tsx` does not render the warn variant — the count `<span>` only carries `pr-tab-count` regardless of value.

**Plan resolution:** PR2 authors `.prTabCountWarn` in the module so the rule is ready, but does NOT wire the conditional render. Wiring is a behavior change (the JSX decides when to apply the warn class), explicitly out of scope per §2.2. PR9 revisit can decide whether to wire it.

**Status:** Deferred to PR9 revisit.
