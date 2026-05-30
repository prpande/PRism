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

---

## PR3 — Overview tab card grid

### D12 — Production-vs-handoff naming divergence

**Spec position:** §3.1 "Kebab-case from the handoff → camelCase in the module" assumes 1:1 selector mapping.

**Reality:** Four PR3 components diverge:
- `StatsTiles` JSX uses `.stats-tile*`; handoff uses `.ov-stat*`.
- `PrRootConversation` JSX uses `.pr-root-comment*`; handoff uses `.pr-conv-*` against a `<ul>/<li>` structure.
- `AiSummaryCard` JSX uses `.ai-summary-card` / `.ai-summary-chip` / `.ai-summary-category`; handoff uses `.pr-ai-summary` + `.ai-summary-head` / `.ai-summary-label` / `.ai-summary-bullets`.
- `PrDescription` JSX uses `.pr-description*` (no handoff equivalent — handoff renders the description body inside the AI hero card as `.overview-desc`).

**Plan resolution:** Author module CSS under PRODUCTION class names (camelCased). Port the handoff *visual treatment* rather than handoff *selector names*. Production JSX class strings stay; the test seam stays; only the visual paint matches the handoff.

**Status:** Applied in PR3.

### D13 — PrRootConversation vertical timeline as CSS-only treatment

**Spec position:** §4.3 "PR-root conversation as a vertical timeline with avatar rail + connecting line."

**Reality:** Handoff renders `<ul>/<li>` with dedicated `.pr-conv-rail` + `.pr-conv-line` child elements. Production renders `<article>` per comment with no rail child. JSX restructuring is out of scope per §2.2 ("class names, layout, and small JSX restructuring are in scope; state, routing, and data fetching are out").

**Plan resolution:** CSS-only treatment using `::before` (vertical line, full height, 1px) + `::after` (small accent dot at the avatar position) pseudo-elements on each `.prRootComment`. The last comment's `::before` stops at `50%` so the timeline ends mid-way through the last item — matching the handoff's behavior where no `.pr-conv-line` is rendered after the last `<li>`. Avatars are NOT rendered (would require JSX structural change).

**Status:** Applied in PR3.

### D14 — overview-card-hero-no-ai authored without exact handoff source

**Spec position:** §3.1 + S3 deferral B26 keep the `.overview-card-hero-no-ai` modifier per "handoff is authoritative" — but the handoff `screens.css` has no exact rule.

**Reality:** Production wired the conditional class to PrDescription (line 13 of `PrDescription.tsx`) without a CSS rule. The visual intent: when `aiPreview=false`, `AiSummaryCard` returns null and `PrDescription` takes the hero slot. The modifier needs to ACTIVATE hero treatment in that path; the base `.overview-card` rule supplies the card surface (background, border) via the literal class string.

**Plan resolution:** Author `.overviewCardHeroNoAi` in `PrDescription.module.css` with the handoff's `.overview-card-hero` declarations (wider radius, larger padding). The literal class string `overview-card-hero-no-ai` stays in JSX as the test seam alongside the hashed module class. AI-ON path: PrDescription gets only the base card surface (no hero treatment) — sits below the AI summary hero. AI-OFF path: PrDescription gets card surface + hero treatment, filling the slot the AI summary would have occupied.

**Status:** Applied in PR3.

### D15 — PrRootReplyComposer scope limited to `.composer-actions` + outer

**Spec position:** §4.3 names `PrRootReplyComposer` as scope item for PR3.

**Reality:** Production JSX uses 7 composer-* classes (`composer-textarea`, `composer-preview-toggle`, `composer-badge`, `composer-discard`, `composer-save`, `composer-closed-banner`, `composer-actions`), but the handoff `screens.css` has rules for only 4 (`composer-tabs`, `composer-tabs .tab`, `composer-preview`, `composer-actions`) — and 3 of those (`composer-tabs`, `composer-tabs .tab`, `composer-preview`) reference a tabs-based composer structure production doesn't use. The only composer-class in both handoff and production is `.composer-actions`.

The remaining 6 production composer-classes are shared across all 3 composers (`InlineCommentComposer`, `ReplyComposer`, `PrRootReplyComposer`). Per spec §3.1's lift-on-second-use rule, they should live in `tokens.css`. PR4 owns all 3 composers and is the natural slice to author the lift.

**Plan resolution:** PR3 ports `.pr-root-reply-composer` (outer container) + `.composer-actions` (button-row layout) into `PrRootReplyComposer.module.css`. The 6 inner composer classes stay as bare global strings, awaiting PR4's lift to `tokens.css`. The `.composerActions` rule includes two pragmatic additions beyond the handoff source (`align-items: center` for badge vertical alignment + `gap: var(--s-2)` for consistent inter-button spacing) — the handoff's bare flex `space-between` is insufficient for production's badge sibling between the toggle and discard/save buttons.

Per **D21**, PR3's parity baseline captures the composer-CLOSED state (Reply button visible). The bare-default styling of the 6 inner classes is a known temporary visual gap until PR4 ships, NOT a regression for PR3.

**Reversible:** Yes. If side-by-side review of PR3 shows the bare-default button styling materially harms the Overview tab's restored visual coherence even with the composer closed, the 6 composer-class rules can be added as bare global rules to `tokens.css` in a PR3 follow-up.

**Status:** Partially applied (outer + composer-actions ported); inner-class lift deferred to PR4.

**Note for PR4 (surfaced by claude[bot] iter-2 review of PR #89):** `.composerActions` currently has `margin-top: var(--s-2)` on top of the parent `.prRootReplyComposer`'s `gap: var(--s-2)` — open-composer state will paint the actions row with doubled spacing (parent gap + own margin-top). PR3's parity baseline captures composer-CLOSED state (D21) so this isn't visible in the regression gate, but PR4's author should drop the `margin-top` (or the parent's `gap`, whichever ends up redundant once inner composer primitives lift to `tokens.css`) before un-fixme-ing the open-composer parity baseline.

### D16 — Test-selector migration via data-testid + literal-class retention

**Spec position:** §6.1 names PR2-specific selector renames; PR3 inherits the same risk for 5 vitest unit-test files (`OverviewTab.test.tsx`, `PrDescription.test.tsx`, `StatsTiles.test.tsx`, `PrRootConversation.test.tsx`, `AiSummaryCard.test.tsx`).

**Reality:** Vitest queries fail once CSS Modules hash the class names. `data-testid` queries + module-imported `styles.x` is the canonical pattern.

**Plan resolution:** Add 5 `data-testid` attributes to PR3 components (Task 2). Migrate 5 vitest unit-test files (Task 3) to `getByTestId(...)` / `queryAllByTestId(...)` for element SELECTION. For class-PRESENCE assertions on `.overview-card`, `.overview-card-hero`, `.overview-card-hero-no-ai` (3 classes), keep the literal strings in JSX — these classes have global rules in `tokens.css` after D22's lift, so the literal serves both as test seam AND as the styling hook.

For the `closest('.pr-description-title')` test seam (PrDescription.test.tsx line 31), use module-imported `closest(\`.${styles.prDescriptionTitle}\`)` — the canonical hashed-class assertion pattern.

Matches PR2 D10 resolution.

**Status:** Applied in PR3.

### D17 — Dormant handoff AI-summary rules ported AS-IS (overrides PR2 D9 precedent)

**Spec position:** §6.2 dormant-attribute policy — rules referencing unset attributes get ported as dormant.

**Reality:** The handoff designs a richer AI summary with head + label + bullets + risk chip (handoff `screens.css:90-102`). Production renders a stub with chip + body + category.

**Reconciliation with PR2 D9:** PR2 D9 narrowed the dormant-policy AWAY from dormant CLASSES — for the four PrHeader stub classes (`pr-meta`, `pr-meta-repo`, `pr-subtitle-author`, `pr-subtitle-branch`), no CSS rule was authored. PR3 D17 explicitly overrides D9 for these 5 AI-summary classes because: (a) they form a coherent multi-element layout (head + label + bulleted list + risk chip is a designed surface, not isolated naming anchors); (b) the handoff's intent for AI summary is a near-term richer surface — wiring is on the PR9 revisit shortlist; (c) the rules are scoped to a single module (`AiSummaryCard.module.css`), not lifted globally.

If PR9 revisit decides AI summary stays at the current stub shape, the 5 dormant rules become dead code and get removed in that pass.

**Plan resolution:** Port 5 dormant rules into `AiSummaryCard.module.css`:
- `.aiSummaryHead`
- `.aiSummaryLabel`
- `.aiSummaryBullets`
- `.aiSummaryBullets li`
- `.aiRisk`

The rules are inert (no JSX renders these classes today). Future JSX wiring or PR9 revisit picks them up without a second CSS pass.

**Status:** Applied in PR3.

### D18 — New production-only `overview-cta-*` sub-rules without handoff source

**Spec position:** §4.3 names `ReviewFilesCta` as scope but only references the handoff's `.overview-cta` parent rule (L335-341).

**Reality:** Production `ReviewFilesCta` JSX renders two child classes (`overview-cta-empty` for the "No files to review yet" hint, `overview-cta-footer` for the keyboard-hint paragraph) with no handoff source.

**Plan resolution:** Author `.overviewCtaEmpty` (small font + right margin) and `.overviewCtaFooter` (small font + flex layout for inline `<kbd>` children) as module CSS rules in `ReviewFilesCta.module.css`. Both classes compose with the existing `.muted` global. Flagged here so PR9 revisit can audit whether the rules align with the restored Overview visual language.

**Status:** Applied in PR3.

### D19 — Handoff `is-you` comment-bubble treatment NOT ported

**Spec position:** §4.3 names `PrRootConversation` scope including "vertical timeline" + comment cards.

**Reality:** Handoff `screens.css:382-385` defines `.pr-conv-item.is-you .pr-conv-body { background: var(--accent-soft); border-color: ... }` — an accent-tinted bubble that marks the current user's own comments. Production `IssueCommentDto` has no `isCurrentUser` field; `PrRootConversation` JSX has no per-comment author-vs-self comparison.

**Plan resolution:** Skip in PR3. Restoring requires (a) plumbing `currentUserLogin` through to `PrRootConversation` (from `useAuth` or a similar hook), (b) per-comment comparison + conditional `data-author-is-self` attribute, (c) adding the conditional CSS rule. That's a logic-and-data-flow change per §2.2.

**Reversible:** Yes. PR9 revisit or a follow-up slice can wire the comparison + add the CSS rule in one pass.

**Status:** Deferred to PR9 revisit alongside other who-said-what affordance decisions.

### D20 — Handoff `overview-card-head` top-of-card header NOT reproduced

**Spec position:** §4.3 names `MarkAllReadButton` in PR3 scope but doesn't specify placement.

**Reality:** Handoff renders an `overview-card-head` element at the TOP of the conversation card with a "Conversation" heading + the Mark-all-read button. Production renders Mark-all-read at the BOTTOM of the card, in the `pr-root-conversation-actions-row` alongside the Reply button.

**Plan resolution:** Keep production placement (bottom). Restoring the top-header requires moving `MarkAllReadButton` from `PrRootConversationActions` to a new sibling header element above the comment list — JSX structural change per §2.2. Production placement also preserves keyboard-flow ergonomics (Reply + Mark-all-read appear together at the natural footer position).

**Reversible:** Yes. PR9 revisit can decide top vs bottom placement against the restored visual language.

**Status:** Deferred to PR9 revisit.

### D21 — PR3 parity baseline captures composer-CLOSED state only

**Spec position:** §4.3 + §4.1.3 specify per-zone parity-baseline captures; §6.3 anticipates verdict-picker / Submit-button visual repositioning.

**Reality:** When the user clicks Reply on `PrRootConversation`, `PrRootReplyComposer` mounts and renders 6 production composer classes (textarea, preview-toggle, badge, discard, save, closed-banner) that have no handoff source and no rule in PR3 (per D15 — deferred to PR4). The open-composer state would capture default browser styling for these elements.

**Plan resolution:** Task 13 captures the composer-CLOSED state (Reply button + MarkAllReadButton visible; textarea + action buttons NOT mounted). The open-composer state's bare-default rendering is NOT covered by PR3's regression gate.

**Reversible:** Yes. PR4 lifts the composer primitives to `tokens.css` and captures the open-composer baseline as part of its slice. Until then, opening the composer on Overview is a known temporary visual gap — not a regression PR3's baseline gate is responsible for.

**Status:** Applied in PR3 (closed-state baseline locks in); open-composer baseline deferred to PR4.

### D22 — Lift `.overview-card` + `.overview-card-hero` to `tokens.css` upfront at Task 6

**Spec position:** §3.1 lift-on-second-use rule.

**Reality:** Both classes have ≥2 immediate consumers within PR3 (`PrDescription` + `AiSummaryCard` + `PrRootConversation` all use bare literal `overview-card` and/or `overview-card-hero` strings). Without the lift, the literals fire no rule, leaving each card visually unstyled.

**Plan resolution:** At Task 6 Step 6.1, append `.overview-card` (background + border + radius + padding) + `.overview-card-hero` (extends with larger radius + padding) to `tokens.css` as global rules. PrDescription / AiSummaryCard / PrRootConversation JSX compose these literals alongside their module-imported component-specific rules. `PrDescription.module.css` does NOT author hashed `.overviewCard` or `.overviewCardHero` (would be dead — JSX uses literals).

Originally flagged in the pre-revision plan as a "side-by-side review-time decision" at Task 13.3. That was structurally unsound (the baseline is captured before the decision), so promoted to upfront commit.

**Status:** Applied in PR3.

### D23 — Handoff `.ov-stat-sub` secondary-line slot NOT wired

**Spec position:** §4.3 names `StatsTiles` scope.

**Reality:** Handoff `.ov-stat-sub` (L327-333, small monospace) renders a secondary line on each tile (e.g., "+214 / -61" line counts, "73% reviewed" progress). Production `Tile` component takes only `label` + `value` props.

**Plan resolution:** Skip in PR3. Restoring requires (a) adding a `sub?: string` prop to `Tile`, (b) passing data from `OverviewTab.tsx` (e.g., diff `+adds/-deletes` from `diff.data.files`), (c) authoring a `.statsTileSub` module rule. Steps (a) and (b) are logic-and-data-flow changes per §2.2.

**Reversible:** Yes. PR9 revisit or a follow-up slice can wire the prop + data + rule in one pass.

**Status:** Deferred to PR9 revisit.

### D24 — AiSummaryCard active-shape parity delta from handoff `pr-detail.jsx:194`

**Spec position:** §3.1 + §4.3 imply handoff visual treatment is authoritative for restored surfaces. Handoff `pr-detail.jsx:194` composes `<section class="overview-card overview-card-hero ai-tint">` with NO additional `.pr-ai-summary` override on that node — the AI summary card visually IS the hero card.

**Reality:** Production JSX renders `<section class="ai-summary-card overview-card overview-card-hero ai-tint">` (additional `.ai-summary-card` literal class), and `AiSummaryCard.module.css`'s `.aiSummaryCard` hashed rule overrides `.overview-card-hero`'s padding/border-radius with the smaller values from handoff `screens.css:84-89` (`.pr-ai-summary` shape — `padding: var(--s-3) var(--s-4); border-radius: var(--radius-3)`). Vite injects CSS-modules AFTER global tokens.css, so the module rule wins the equal-specificity cascade.

The result is that AiSummaryCard ships in PR3 as the smaller `.pr-ai-summary` surface, NOT the full `.overview-card-hero` surface the handoff prototype renders for this slot.

**Plan resolution:** Accept the smaller-surface treatment for PR3. The module rule is authored intentionally (Task 7.1) with a header comment explaining the cascade-order intent. The literal `overview-card-hero` class stays on the JSX as a test seam (`OverviewTab.test.tsx:433` asserts `toHaveClass('overview-card-hero')` to verify the hero modifier is present on the AI summary section, even when the visual paint comes from the smaller `.aiSummaryCard` module rule).

If the side-by-side review pass after PR3 ships determines the production AI surface should match handoff `pr-detail.jsx:194`'s hero shape exactly, the resolution is to drop `padding` and `border-radius` from `.aiSummaryCard` (let `.overview-card-hero` win the cascade) — a one-line follow-up.

**Reversible:** Yes. PR9 revisit (or a focused follow-up before PR4) can decide between the two AI-summary shapes once the restored visual is in front of the N=3 cohort.

**Status:** Applied in PR3 (smaller `.pr-ai-summary` shape via module rule); deferred PR9 adjudication of whether the larger `.overview-card-hero` shape better matches handoff intent.

---

## PR4 — Files tab (CSS)

### D25 — Production-vs-handoff naming divergence is total in PR4

**Date:** 2026-05-30 (PR4 plan-writing pre-flight).

**Spec position:** §3.1 + §4.4 imply 1:1 kebab→camelCase mapping for module CSS class names. PR4 extends D12 (PR3) — naming divergence is the norm, not the exception, for PR Detail components below the Overview level.

**Reality:** 5 of the 13 PR4 components have ZERO direct handoff naming overlap (`FilesTab` outer shell, `CommitMultiSelectPicker`, `ComparePicker`, `MarkdownFileView`, `WordDiffOverlay`); 3 of those (`CommitMultiSelectPicker`, `MarkdownFileView`, `WordDiffOverlay`) have no handoff equivalent at all. The remaining 8 use production names like `iteration-tab*` / `file-tree*` / `diff-pane*` against handoff `iter-chip*` / `tree-*` / `diff-area*`.

**Plan resolution:** Module CSS authored under production class names. Where a handoff visual treatment exists, port it; where it doesn't, derive treatment from surrounding visual language and flag for PR9 visual-coherence review.

**Status:** Applied in PR4.

### D26 — 6 composer-inner classes lifted to `tokens.css` (PR3 D15 fulfillment); badge variants aligned with production union

**Date:** 2026-05-30 (PR4 Task 4).
**Spec position:** §3.1 lift-on-second-use rule; §4.4 lists all 3 composers; D15 (PR3) explicitly deferred the lift to PR4.
**Reality:** Three composers (`InlineCommentComposer`, `ReplyComposer`, `PrRootReplyComposer`) all consume the same 6 inner classes (`composer-textarea`, `composer-preview-toggle`, `composer-badge` + `composer-badge--{saved,saving,unsaved,rejected}` modifiers, `composer-discard`, `composer-closed-banner`, `composer-actions`). The badge state union is `'saved' | 'saving' | 'unsaved' | 'rejected'` (verified at `frontend/src/hooks/useComposerAutoSave.ts:5`). Lift-on-third-use unambiguously qualifies for `tokens.css`. `.composer-save` is NOT lifted — the `.btn .btn-primary .btn-sm` globals supply the full visual treatment in production JSX; an empty stub would be speculative.
**Plan resolution:** Append 6 global rules to `tokens.css` at Task 4 Step 4.2. PrRootReplyComposer's local `.composerActions` rule (PR3) is dropped and replaced by the global `.composer-actions` consumed via literal class.
**Status:** Applied in PR4.
**Cross-refs:** PR3 D15.

### D27 — `.composer-actions` `margin-top` dropped at lift

**Date:** 2026-05-30 (PR4 Task 4 Step 4.2).
**Spec position:** Handoff source `screens.css:776` includes `margin-top: 8px`.
**Reality:** PR3's `b4a916b` annotation: the parent composer-outer already provides `gap: var(--s-2)` via `flex-direction: column`, so the inner `margin-top` doubles the visual gap on the open-composer state. PR3 captured the closed-state baseline (per D21) and deferred the open-state defect to PR4.
**Plan resolution:** Lift `.composer-actions` to `tokens.css` with `display: flex; justify-content: space-between; align-items: center; gap: var(--s-2);` only — drop `margin-top` entirely.
**Status:** Applied in PR4.
**Cross-refs:** PR3 b4a916b annotation; PR3 D15; PR3 D21.

### D28 — IterationTabStrip chip-num + chip-meta inner spans only; iter-new-dot DEFERRED (no production data source)

**Date:** 2026-05-30 (PR4 Task 5).
**Spec position:** §4.4 line 249 — "iteration tab strip (chip cards with +/− counts, new-iteration dot)". §2.2 permits "small JSX restructuring".
**Reality:** Production `IterationDto` (`frontend/src/api/types.ts:162-168`) carries `{ number, beforeSha, afterSha, commits: CommitDto[], hasResolvableRange }` — there are NO `additions`/`deletions`/`isNew`/`label`/`index` fields. The chip-num + chip-label + chip-meta DOM is constructable from existing data; iter-new-dot is not.
**Plan resolution:** Ship 3 of the 4 inner spans: (a) chip-num renders `{iteration.number}`; (b) chip-label preserves the existing visible "Iter N" computed text so pre-existing `getByText('Iter 3')` tests still match; (c) chip-meta with `+adds`/`-rems` computed inline as `iteration.commits.reduce((s, c) => s + c.additions, 0)`. iter-new-dot is NOT rendered; the omission is documented for PR9 to wire via a state hook if needed.
**Status:** Applied in PR4 (chip-num + chip-meta); iter-new-dot deferred to PR9.
**Cross-refs:** Spec §4.4; §2.2 small-JSX-restructuring carve-out.

### D29 — IterationTabStrip overflow chip + dropdown styled production-only

**Date:** 2026-05-30 (PR4 Task 5).
**Spec position:** Handoff renders overflow inline; production renders a listbox dropdown.
**Reality:** No direct handoff source for `.iteration-dropdown` + `.iteration-option` structure (~30 lines of structured JSX in `IterationTabStrip.tsx:39-64`).
**Plan resolution:** Author dropdown rules from scratch using surface tokens + box-shadow + max-height. `iteration-tab--more` ports handoff `iter-chip-more` (dashed border + muted color).
**Status:** Applied in PR4. Flagged for PR9 visual-coherence review.

### D30 — CommitMultiSelectPicker — no handoff source

**Date:** 2026-05-30 (PR4 Task 6).
**Spec position:** §4.4 lists the component; handoff prototype has no equivalent (the picker is a S3-era production-only affordance for the low-quality clustering path).
**Reality:** Production-only conventions; no design source.
**Plan resolution:** Style for keyboard-affordance clarity (visible focused state) and consistency with the iteration strip surface tokens.
**Status:** Applied in PR4. Flagged for PR9 visual-coherence review.

### D31 — ComparePicker — production-only interaction shape; component is currently dead code (no production import)

**Date:** 2026-05-30 (PR4 Task 7).
**Spec position:** Handoff `iter-compare` is one chip that opens a comparison flyout; production renders two side-by-side `<select>`s with an arrow between.
**Reality:** S3-era decision to use native `<select>` controls instead of a flyout — different interaction model than the handoff prototype. ADDITIONALLY: grep for `import.*ComparePicker` and `<ComparePicker` across `frontend/src/` returns zero matches (verified 2026-05-30). The component file + its vitest test exist, but nothing mounts it in the running app — `FilesTab.tsx` renders only `IterationTabStrip` or `CommitMultiSelectPicker` depending on the clustering path. PR4's CSS work for ComparePicker is forward-compat only; the parity-baseline `pr-detail-files-tree` zone does NOT capture ComparePicker because it doesn't render.
**Plan resolution:** Style derived from surrounding chip-card surface tokens (`var(--surface-2)` background + `var(--border-1)` border). Arrow uses `var(--text-3)`. Arrow `⇄` carries `aria-hidden="true"` since the two labeled selects already communicate direction. Ship the CSS even though the component is dormant — keeping styling current avoids a later re-port pass when ComparePicker mounts.
**Status:** Applied in PR4 (CSS shipped; mount path is a separate slice's concern). Flagged for PR9 visual-coherence review on whether the styled-but-dormant component should be removed or wired.

### D32 — FileTree — port handoff `tree-*` under production `file-tree*` names; file-status enum is `'added' | 'modified' | 'deleted' | 'renamed'`

**Date:** 2026-05-30 (PR4 Task 8).
**Spec position:** Production family is wider than handoff (directory grouping + dir chevron + dir toggle have no handoff equivalent — production added directory grouping as a usability win).
**Reality:** Mapping: `tree-row` → `.fileTreeFile`; `tree-row.is-selected` → `.fileTreeFileSelected`; `tree-status-success/warning/danger/info` → `.fileStatusAdded` / `.fileStatusModified` / `.fileStatusDeleted` / `.fileStatusRenamed` (verified against `FileChangeStatus` union at `frontend/src/api/types.ts:209` — 4 values, no `removed`, no `copied`); `tree-name` → `.fileTreeFileName`; `tree-counts` + `tree-add` + `tree-rem` → small module rules with `.tnum`.
**Plan resolution:** Module CSS authored under production class names; handoff visual treatment ported.
**Status:** Applied in PR4.

### D32a — `.fileTreeAi` ships as a dormant rule; JSX wiring deferred to PR9

**Date:** 2026-05-30 (PR4 Task 8).
**Spec position:** §4.4 line 249 names "AI focus dot when `aiPreview` is on" as a restored visual; production has no data path for it today.
**Reality:** `FileTree.tsx` has no `aiPreview` consumption, no `aiFocus`-shaped prop on `FileChange`, no `<span class="file-tree-ai">` render. Adding the JSX wiring requires both a new state hook AND a data extension on `FileChange` — out of §2.2 scope for a CSS-only slice.
**Plan resolution:** `.fileTreeAi` rule (`6px × 6px` accent dot) lands in `FileTree.module.css` as a dormant module rule. PR9 can wire the JSX conditional render alongside other AI-surface decisions.
**Status:** Dormant rule applied in PR4; wiring deferred to PR9.
**Cross-refs:** PR3 D17 dormant-CSS precedent; §6.2 dormant-CSS policy.

### D33 — FileTree viewed-state is on the checkbox; CSS `:has()` selector bridges it

**Date:** 2026-05-30 (PR4 Task 8).
**Spec position:** Handoff strikes through the file basename via `.tree-row.is-viewed .tree-name .tree-base`.
**Reality:** Production has no `is-viewed` row modifier — the viewed-state is on the `<input type="checkbox">` (`.file-tree-viewed-checkbox`) directly.
**Plan resolution:** Bridge via the CSS `:has()` selector (`.fileTreeFile:has(.fileTreeViewedCheckbox:checked) .fileTreeFileName { ... }`). Baseline 2023; supported in all current Chromium, Safari, Firefox. PRism's targeted browsers (per `package.json` browserslist or default Vite) include these. Fallback if a future browser context lacks `:has()`: wire `aria-checked` on the row and a sibling state class via small JSX touch.
**Status:** Applied in PR4. Documented for future-coverage audit.

### D34 — DiffPane diff-line tinting uses production literal BEM classes lifted to `tokens.css`

**Date:** 2026-05-30 (PR4 Task 10).
**Spec position:** Spec §4.4 names DiffPane as scope.
**Reality:** Production `DiffPane.tsx:193` emits `rowClass = \`diff-line diff-line--${line.type}\`` where `line.type` is `'context' | 'insert' | 'delete' | 'hunk-header'`. The literal classes are bare strings with no rules today — exactly the §3.1 lift-on-second-use case (every diff row IS a consumer). The handoff prototype uses different rule names but the visual treatments map cleanly.
**Plan resolution:** Lift 4 global rules to `tokens.css` at Task 10 Step 10.4: `.diff-line` (font-mono base), `.diff-line--insert` (add tint), `.diff-line--delete` (rem tint), `.diff-line--hunk-header` (header surface). DiffPane.module.css supplies the gutter, content, comment-row, composer-row, header surfaces that are diff-pane-specific. Side-by-side diff (`.diff-line-sbs`) is NOT ported in PR4 — production is unified-only today.
**Status:** Applied in PR4. The CSS-only-data-attribute approach considered in the original plan draft (`tr[data-kind='add']`) was rejected because production already emits the literal BEM class strings; adding `data-kind` would have been a JSX touch with no payoff.

### D35 — `.diff-pane--empty` no-file-selected rule is new production-only design

**Date:** 2026-05-30 (PR4 Task 10).
**Spec position:** Spec §4.4 line 251 explicitly calls this out ("the handoff has no `.diff-pane-empty` rule, and this surface is unavoidable in production").
**Reality:** The handoff prototype always pre-selects a file. Production must handle the no-file-selected state.
**Plan resolution:** `.diffPaneEmpty` rule = centered muted text + min-height. Visual derivation matches `DraftListEmpty` and `compare-picker-empty` precedents.
**Status:** Applied in PR4. Flagged for PR9 visual-coherence review.

### D36 — Loading… overlay is JSX-driven `<span>`; `isLoading` prop threaded through `DiffPaneProps`

**Date:** 2026-05-30 (PR4 Task 10).
**Spec position:** Spec §4.4 line 253 describes a `var(--text-3)` Loading… overlay in the diff toolbar area during in-flight diff fetches.
**Reality:** `DiffPane.tsx:12-33` `DiffPaneProps` does NOT carry `isLoading` (the prop lives on `FileTree`, not `DiffPane`). PR4 adds `isLoading?: boolean` to `DiffPaneProps` and threads `isLoading={diff.isLoading}` on the `<DiffPane>` mount in `FilesTab.tsx`.
**Plan resolution:** Option B selected: JSX `<span className="diff-pane-loading muted">Loading…</span>` rendered conditionally inside the diff-pane header when `isLoading` is true. The CSS-only `::after { content: "Loading…" }` approach (Option A) was rejected per WCAG 2.1 F87 — CSS-generated content is not in the accessibility tree. JSX rendering puts the text in the a11y tree where screen readers can find it.
**Status:** Applied in PR4 (Option B; `isLoading?: boolean` threaded through `DiffPaneProps` + `FilesTab.tsx`).

### D37 — WordDiffOverlay — production-only; no handoff source

**Date:** 2026-05-30 (PR4 Task 14).
**Spec position:** §4.4 lists the component; handoff has no word-level overlay (production was authored to surface finer-grained diff for visual scanning — a S3-era win).
**Reality:** No direct source; treatment matches surrounding diff-add/diff-rem color tokens.
**Plan resolution:** `.wordDiffInsert` = `var(--diff-add-bg)` + `var(--success-fg)`; `.wordDiffDelete` = `var(--diff-rem-bg)` + `var(--danger-fg)` + line-through.
**Status:** Applied in PR4. Flagged for PR9 visual-coherence review.

### D38 — MarkdownFileView — production-only; no handoff source

**Date:** 2026-05-30 (PR4 Task 15).
**Spec position:** §4.4 lists the component; handoff has no equivalent (production-only affordance for `.md`/`.markdown` file paths).
**Reality:** No direct source; treatment matches surrounding diff-pane surface tokens.
**Plan resolution:** `.markdownFileView` = padded surface-1 container; toolbar with toggle buttons (`.toggleBtn` + `.toggleBtnActive` matching `.iterationTabActive` filled-accent style); raw mode = font-mono pre on surface-2.
**Status:** Applied in PR4. Flagged for PR9 visual-coherence review.

### D39 — Composer outer-classes are 3 modules; inner-classes are 6 globals (corrected from 7 — Task 4 dropped `composer-save`)

**Date:** 2026-05-30 (PR4 Task 4 + Tasks 16-18).
**Spec position:** §3.1 lift-on-second-use; D15 (PR3) called out the inner-vs-outer split.
**Reality:** Outer is unique per composer (different padding/background by mounting context — Inline inside `<table>` colspan-3, Reply inside `ExistingCommentWidget`, PrRootReply on Overview). Inner is shared. The original plan estimate was 7 inner globals; Task 4 dropped `composer-save` from the lift set (the `.btn .btn-primary .btn-sm` globals supply the full visual treatment in production JSX — an empty stub would have been speculative), leaving 6.
**Plan resolution:** 3 outer-only module CSS files + 6 inner global rules in `tokens.css`. JSX consumes outer via `${styles.x}` and inner via literal global strings.
**Status:** Applied in PR4.
**Cross-refs:** PR3 D15; D26.

### D40 — D21 fulfillment is implicit; no new baseline zone

**Date:** 2026-05-30 (PR4 plan-writing pre-flight; reframes PR3 D21).
**Spec position:** Spec §4.4 line 257 enumerates two PR4 baselines: file tree zone, diff pane zone. PR3 D21 mentioned "open-composer baseline" but did not pre-commit to a new zone in `parity-baselines.spec.ts`.
**Reality:** Adding a `pr-detail-overview-composer-open.png` zone would be brittle (mount is a click-interaction state) and not in §4.4 scope.
**Plan resolution:** Reframe D21 as "PR4 makes the open-composer state visually correct via the composer-primitive lift; test coverage of that state is left to natural growth of vitest unit tests on the composers." No new Playwright zone.
**Status:** Reframed in PR4. Logged for PR9 to audit if open-composer regression coverage is later judged insufficient.
**Cross-refs:** PR3 D21.

### D41 — D4 selector tightening (Calc.cs file row) — landed in PR4

**Date:** 2026-05-30 (PR4 Task 8 + Task 20 Step 20.2).
**Spec position:** PR1 D4 hand-off note to PR4.
**Reality:** PR4 owns the FileTree DOM. JSX adds `data-testid="files-tab-tree-row"` + `data-path={node.file.path}` to each file row at Task 2 Step 2.5 + Task 8 Step 8.2. Test selector tightens to `[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]` at Task 20 Step 20.2.
**Plan resolution:** Additive JSX attributes (§2.2-compliant); selector tightened in same PR.
**Status:** Applied in PR4.
**Cross-refs:** PR1 D4.

### D42 — PR4 split-checkpoint at Task 9.5 — decision: SINGLE-PR4

**Date:** 2026-05-30 (PR4 Task 9.5).
**Spec position:** §4.4 line 255 + §6.6 — implementer judges single-PR4 vs PR4a/PR4b split based on measured LOC + review-meaningful-change count.
**Reality:** Measured at end of Task 9: ~520 LOC of CSS added across Tasks 1-9 (`PrRootReplyComposer.module.css` -8, `CommitMultiSelectPicker` +57, `ComparePicker` +37, `FileTree` +154, `FilesTab` +69, `IterationTabStrip` +125, `tokens.css` +86). ~6 review-meaningful changes (composer-inner lift, IterationTabStrip chip-anatomy, CommitMultiSelectPicker, ComparePicker, FileTree, FilesTab shell). Both metrics below the split-tripper thresholds (>~600 LOC CSS / >~8 review-meaningful changes).
**Plan resolution:** Continue single-PR4. Tasks 10-19 added ~600 more CSS LOC + 10 more component touches; total PR4 LOC ~1120, total components ~15. Review weight is heavier than PR3 but within tolerance for a single PR given the slice's coherence (all components belong to FilesTab + DiffPane + Composer + their close neighbors).
**Status:** Decided at Task 9.5; PR4 ships single.
**Cross-refs:** Spec §6.6.

### D43 — Dropdown click-outside close DEFERRED to PR9 (CommitMultiSelectPicker + IterationTabStrip)

**Date:** 2026-05-30 (PR4 iter 1 claude[bot] review).
**Spec position:** §2.2 — "no state, no routing, no data fetching" changes in parity-restoration slices.
**Reality:** `CommitMultiSelectPicker.tsx` and `IterationTabStrip.tsx`'s overflow dropdown both open on button click but have no `useEffect` attached `mousedown`/`click` listener to `document`. Clicking outside leaves the listbox open indefinitely until the user clicks the trigger button again.
**Plan resolution:** Adding click-outside close requires new state + a `document` event listener — a behavior change explicitly out of §2.2 scope for parity slices. Defer to PR9 audit or a follow-up behavior slice that can verify against the handoff prototype's dropdown UX.
**Status:** Deferred to PR9 (or a behavior-slice follow-up).
**Cross-refs:** claude[bot] iter 1 finding #3.

### D44 — IterationTabStrip dropdown keyboard navigation DEFERRED to PR9

**Date:** 2026-05-30 (PR4 iter 1 claude[bot] review).
**Spec position:** §2.2 (no logic changes); ARIA listbox spec mandates arrow-key navigation.
**Reality:** `<div role="listbox">` has no `onKeyDown` handler; `<div role="option">` items have no `tabIndex` or keyboard handlers. Keyboard-only users cannot interact with the overflow dropdown.
**Plan resolution:** Adding arrow-key navigation requires new state + key event handlers + focus management — behavior changes out of §2.2 scope. Defer to PR9 audit.
**Status:** Deferred to PR9.
**Iter 2 update (2026-05-30):** Misleading ARIA roles dropped — `aria-haspopup="listbox"`, `role="listbox"` container, and `<div role="option">` items all removed. Per-iteration `<div>` switched to native `<button type="button">` for free Tab focus + Space/Enter activation. The remaining gap (arrow-key navigation between dropdown options, focus management on open/close) stays deferred to PR9. Behavior delta minimized: dropdown is now a button-list rather than a listbox.
**Cross-refs:** claude[bot] iter 1 finding #4.

### D45 — FileTree treeitem keyboard navigation gap (pre-existing) NOT addressed in PR4

**Date:** 2026-05-30 (PR4 iter 1 claude[bot] review).
**Spec position:** §2.2 (no logic changes); ARIA treeitem spec mandates up/down/left/right arrow key handling.
**Reality:** `<div role="treeitem">` has `onClick` + `tabIndex` but no `onKeyDown`. The gap is pre-existing — PR4 added CSS but did not introduce or address the keyboard handler.
**Plan resolution:** Pre-existing accessibility gap, not a PR4 regression. Defer to PR9 audit or a dedicated a11y slice.
**Status:** Acknowledged pre-existing; deferred to PR9.
**Cross-refs:** claude[bot] iter 1 finding #5.

---

## PR5 — Drafts tab + reconciliation surface (CSS)

### D46 — UnresolvedPanel + StaleDraftRow are the only handoff-derived PR5 components

**Date:** 2026-05-30 (PR5 plan-writing pre-flight).
**Spec position:** §4.5 names 10 components in scope. §3.1 implies handoff source applies to each.
**Reality:** Handoff prototype renders the Drafts sub-tab strip button (`pr-detail.jsx:127-135`) but the only DOM the prototype defines for the broader Drafts surface is `StaleDraftPanel` — used either standalone or `is-embedded` inside the Overview grid. The handoff has NO Drafts-tab content surface (drafts grouped by file with edit/delete actions), NO foreign-pending-review modal, NO discard-confirmation sub-modal. Only `StaleDraftPanel`'s structure maps to production `UnresolvedPanel` + `StaleDraftRow`.
**Plan resolution:** Port `.stale-panel*` / `.stale-row*` (screens.css:457-495) under production `.unresolvedPanel*` / `.staleDraftRow*` names. The other 8 components author production-only CSS derived from PR3/PR4 surface tokens, `.banner-warning`, the composer surface language, and (where needed) PR4's `.diffPaneEmpty` precedent for empty states.
**Status:** Applied in PR5.

### D47 — `chip-status-stale` + `chip-override` lifted to `tokens.css`; `chip-status-moved` + `chip-status-draft` stay LOCAL

**Date:** 2026-05-30 (PR5 plan-writing + ce-doc-review pass).
**Spec position:** §3.1 lift-on-second-use; §6.2 dormant-attribute policy.
**Reality:** Production JSX uses `chip-status-stale` at 3 explicit sites (StaleDraftRow.tsx:104, DraftsTab.tsx:146, UnresolvedPanel.tsx:155) + 1 dynamic interpolation in DraftListItem.tsx:81 — 4 producers. `chip-override` at 1 explicit site (DraftListItem.tsx:82) + 1 Playwright literal-test consumer (s4-keep-anyway-survives-reload.spec.ts:82 asserts on `.chip.chip-override`). `chip-status-moved` and `chip-status-draft` are emitted ONLY via the dynamic interpolation in DraftListItem.tsx:81 — single producer file each. Lift-on-second-use is satisfied for the first pair, not the second.
**Plan resolution:** Append `.chip-status-stale` (danger-soft/danger-fg) + `.chip-override` (surface-3/text-2 + dashed border) to `tokens.css`. Author `.chip-status-moved` (warning-soft/warning-fg) + `.chip-status-draft` (info-soft/info-fg) as `:global(...)` rules in `DraftListItem.module.css` — the dynamic literal interpolation in JSX continues to match these globals at render time. Initial draft of D47 attempted to lift all 4 as a "coherent semantic family"; ce-doc-review (scope-guardian) caught that this re-litigated D52's correct single-consumer rejection on structurally identical evidence, and the lift was narrowed.
**Status:** Applied in PR5 with the narrowed scope.
**Cross-refs:** D52 (verdict-reconfirm-row single-consumer rejection precedent); ce-doc-review scope-guardian finding S1.

### D48 — Stale-row AI suggestion span deferred to PR9

**Date:** 2026-05-30 (PR5 plan-writing).
**Spec position:** §4.5 line 263 names "AI-suggestion chip when `aiPreview` is on"; §6.4 says "Per slice, the styling lands; the data path stays canned."
**Reality:** `StaleDraftRow.tsx` has no `aiPreview` consumption, no `aiSuggestion` field on `DraftCommentDto`/`DraftReplyDto`. Restoring the handoff `.stale-ai` span requires (a) plumbing `aiPreview` via `usePreferences()`, (b) extending the DTOs with a canned `aiSuggestion` field, (c) authoring the `<span className="stale-ai ai-tint">` render conditional in JSX. Steps (a)+(b)+(c) collectively are a logic-and-data-flow change per §2.2.
**Plan resolution:** Skip in PR5. Same shape as PR4 D32a (FileTree AI focus dot). No dormant rule authored (would require a JSX touch to mount).
**Status:** Deferred to PR9 alongside other AI-surface wiring decisions.
**Cross-refs:** PR4 D32a; spec §6.4.

### D49 — PR1 D2 closed: data-testid + reconciliation-panel test + baseline

**Date:** 2026-05-30 (PR5 implementation).
**Spec position:** §4.1.3 + PR1 D2.
**Reality:** PR1 D2 explicitly deferred `[data-testid="unresolved-panel"]` JSX addition and the `pr-detail-reconciliation-panel` parity-baseline test to PR5.
**Plan resolution:** Task 3 added the testid on the visible `<section>` (UnresolvedPanel.tsx:137-143). Task 18 authored the `setupAndOpenHandoffParityFixtureWithStaleDraft` helper + the test definition. Task 20 captured the baseline (`pr-detail-reconciliation-panel.png`, 12.0 KB).
**Status:** Applied in PR5 (Tasks 3 + 18 + 20).
**Cross-refs:** PR1 D2.

### D50 — BEM class names port as literal-class-and-module

**Date:** 2026-05-30 (PR5 plan-writing + ce-doc-review pass).
**Spec position:** §3.1 module-CSS convention.
**Reality:** ForeignPendingReviewModal + DiscardConfirmationSubModal use BEM (`foreign-prr-modal__body`, `discard-confirmation-sub-modal__footer`, etc.). The Vite/postcss-modules default `camelCase` setting (no explicit `localsConvention` in `frontend/vite.config.ts`) exposes BOTH camelCase and kebab keys, but the project convention across PR2-PR4 (~26 modules) authors camelCase keys exclusively. Initial D50 draft cited `'camelCaseOnly'` as the Vite default — incorrect; ce-doc-review feasibility caught the rationale error.
**Plan resolution:** Author camelCase module keys (`.foreignPrrModal`, `.foreignPrrModalBody`, etc.). Production JSX keeps the literal BEM kebab classes as test seams + hashed module classes composed alongside via template literal. Matches PR4 D16 literal-class-and-module pattern.
**Status:** Applied in PR5 with the rationale corrected.
**Cross-refs:** PR4 D16; ce-doc-review feasibility finding F2.

### D51 — DiscardAllStaleButton.module.css authors modal-content rules only

**Date:** 2026-05-30 (PR5 plan-writing).
**Spec position:** §3.1.
**Reality:** The component is named after its trigger button but most of its rendered DOM lives inside a `<Modal>` confirming the destructive action. The trigger button uses `.btn .btn-danger .btn-sm` globals already in `tokens.css` — adding speculative trigger-button rules would be dead code.
**Plan resolution:** Author 3 module rules (`.discardAllPreviewList` ul, `.discardAllPreviewBody` pre, `.discardAllError` p). Leave the trigger button JSX untouched.
**Status:** Applied in PR5.

### D52 — `.verdictReconfirmRow` stays in UnresolvedPanel.module.css (single consumer)

**Date:** 2026-05-30 (PR5 plan-writing).
**Spec position:** §3.1 lift-on-second-use.
**Reality:** Single consumer (UnresolvedPanel verdict-reconfirm row); no second consumer planned.
**Plan resolution:** Author one module rule with row layout. Do NOT lift to `tokens.css`. Speculative lift would be pre-mature abstraction.
**Status:** Applied in PR5.

### D53 — `setupAndOpenHandoffParityFixtureWithStaleDraft` helper authored in parity-fixture.ts

**Date:** 2026-05-30 (PR5 plan-writing + Task 18 implementation).
**Spec position:** §4.1.3 (parity baseline zones).
**Reality:** Both PR5 parity baselines (drafts + reconciliation panel) require a non-empty stale-draft fixture state. Authoring two separate helpers (one for "1 draft" and one for "1 stale draft") would duplicate the composer-save + advanceHead dance. One shared helper covers both.
**Plan resolution:** Append `setupAndOpenHandoffParityFixtureWithStaleDraft(page)` to `frontend/e2e/helpers/parity-fixture.ts` alongside the existing `setupAndOpenHandoffParityFixture`. Helper uses `[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]` (PR4 D41 selector) + `getByRole('button', { name: /add comment on line 3/i })` (matches `aria-label="Add comment on line 3"` at `DiffPane.tsx:288`) + advanceHead + reload.
**Status:** Applied in PR5 (Task 18, commit `1463cbf`).
**Cross-refs:** PR4 D41; spec §4.1.3.

### D54 — PR5 split-checkpoint at Task 12.5: SINGLE-PR5 (override OR-tripwire on judgment grounds)

**Date:** 2026-05-30 (PR5 Task 12.5 measurement).
**Spec position:** §4.4 line 255 (split-policy carve-out PR4 also used).
**Reality:** Measured at end of Task 12: 311 LOC of CSS added across 8 module files + `tokens.css`. 9 review-meaningful changes (1 tokens.css lift + 8 module files). LOC tracks well below the 600 threshold (~half PR4's 520-at-checkpoint measurement); change count hits the 8 tripwire.
**Plan resolution:** Continue SINGLE-PR5. The OR-tripwire is informational, not absolute; PR4 precedent: judged single at the checkpoint (6 changes / 520 LOC) and shipped at 15/1120 with no split regret. PR5 coherence is higher than PR4 (8 modules across 2 dirs — DraftsTab + Reconciliation — vs PR4's 13 modules across 4 dirs). Review burden is CSS-only ports with literal-class-and-module continuity. Final PR5 LOC at ship: ~411 + ~70 BEM modals + ~40 deferrals append = ~520-600 LOC total — well under PR4's exit LOC.
**Status:** Decided at Task 12.5; PR5 ships single.
**Cross-refs:** PR4 D42.

### D55 — StaleDraftRow horizontal layout deviates from handoff's `flex-direction: column`

**Date:** 2026-05-30 (PR5 plan-writing + ce-doc-review pass).
**Spec position:** §2.2 ("Any deviation in a slice requires a justification in that slice's deferrals sidecar").
**Reality:** Handoff `.stale-row` (screens.css:473-476) is `display: flex; flex-direction: column; gap: 8px`. Production JSX `StaleDraftRow.tsx:103` uses `<li className="stale-draft-row row gap-2">`. The `row gap-2` global (from `tokens.css`) supplies `display: flex; flex-direction: row` — keeping production's horizontal layout already in place. Overriding to column would require either (a) dropping the `row gap-2` global compose (JSX restructuring beyond §2.2), or (b) module rule overriding the global at equal specificity (cascade complexity that would clash with the literal-class-and-module pattern).
**Plan resolution:** Author `.staleDraftRow` with `display: flex; align-items: center; gap: var(--s-2); flex-wrap: wrap` — matches the row-gap-2 production layout. Push the preview onto its own line via `.staleDraftRowPreview { flex: 1 1 100%; margin: 4px 0 0 }` — approximates the handoff blockquote effect (body quote becomes a full-width subordinate row below meta+actions).
**Status:** Applied in PR5 (Task 6, commit `2a618e4`). Side-by-side review will show the row-layout delta as expected; flag in PR description.
**Cross-refs:** ce-doc-review design-lens finding U-1.

### D56 — StaleDraftRow's "Delete" button label NOT renamed to handoff's "Discard"

**Date:** 2026-05-30 (PR5 plan-writing + ce-doc-review pass).
**Spec position:** §2.2 ("Class names, layout, and small JSX restructuring are in scope; state, routing, and data fetching are out").
**Reality:** Handoff `pr-detail.jsx:347` reads "Discard"; production `StaleDraftRow.tsx:129` reads "Delete". Renaming the button text would touch all 5 callers of the same delete-action verb across PRism (StaleDraftRow + DraftListItem + multiple composer surfaces) where production has used "Delete" since S4. Existing vitest tests assert on `/delete/i` regex; an existing Playwright spec (`s4-keep-anyway-survives-reload`) also clicks the Delete button.
**Plan resolution:** Keep "Delete". Button label is JSX text content but the cross-cutting nature of the rename pushes it out of §2.2 scope. PR9 revisit owns the copy adjudication if uniform "Discard" is preferred at trial-cohort feedback time.
**Status:** Deferred to PR9 (or a follow-up content-rename slice if trial signal demands earlier action).
**Cross-refs:** ce-doc-review design-lens finding U-2.

### D57 — UnresolvedPanel sticky-top implemented via `position: sticky; top: 0; z-index: 1`

**Date:** 2026-05-30 (PR5 plan-writing + ce-doc-review pass).
**Spec position:** §4.5 line 263 ("the unresolved-panel sticky-top reconciliation surface").
**Reality:** Spec calls out "sticky-top" behavior but the original plan draft authored no `position: sticky` rule on `.unresolvedPanel` — ce-doc-review design-lens caught the gap. `PrDetailPage.tsx` has no module CSS file today, so the parent wrapper has no explicit `overflow` declaration; `position: sticky` operates against the nearest ancestor with non-`visible` overflow, which is the viewport.
**Plan resolution:** Add `position: sticky; top: 0; z-index: 1` to `.unresolvedPanel` in `UnresolvedPanel.module.css`. Sticky against the viewport matches the spec's "stays pinned to the visible top of PR Detail while the user scrolls" intent. If a future PrDetailPage layout introduces an inner scroll container, the rule carries forward without change here. If side-by-side review shows the panel scrolling off in a way that conflicts with handoff intent, PR9 can add an inner-scroll container at PrDetailPage.
**Status:** Applied in PR5 (Task 5, commit `1f6fd0f`).
**Cross-refs:** ce-doc-review design-lens finding U-3.

---

## PR6 — Setup + Settings coherence

### D58 — `ScopePill.module.css` not created (spec mandate vs. zero-consumer reality)

**Date:** 2026-05-30 (PR6 plan-writing + ce-doc-review pass).
**Spec position:** §4.6 lists `ScopePill.module.css` as a new module for the Setup half.
**Reality:** `ScopePill.tsx` has ZERO production consumers (Grep over `frontend/src` matches only its own definition; pre-flight Task 1 Step 1 re-verifies at implementation time). Creating a module CSS file for an unrendered component is a speculative anchor — same trap PR4 D26 explicitly rejected for `.composer-save` / `.commentThreadReply` / `.iterationNewDot`.
**Plan resolution:** Defer `ScopePill.module.css` to PR9 (catalog round). PR6 wagers PR9 will either delete `ScopePill.tsx` OR document it as deferred dead-code with a v1.x consumer plan. If PR9 surfaces a consumer that needs ScopePill rendered, that PR pays the module-CSS cost, not PR6.
**Status:** Deferred to PR9.
**Cross-refs:** PR4 D26; spec §4.6 line 269.

### D59 — No per-section module CSS files in Settings

**Date:** 2026-05-30 (PR6 plan-writing pass).
**Spec position:** §4.6 says "polish to SettingsSections.module.css, plus any new module CSS the section components need."
**Reality:** The 4 section components (Appearance / InboxSections / Connection / Auth) all compose `SettingsSections.module.css` cleanly via shared classes (`.section`, `.row`, `.radioLabel`, `.help`, `.linkDisabled`, `.srOnly`). No per-section styling divergence exists in their JSX.
**Plan resolution:** SettingsSections.module.css stays as the single shared module for all 4 sections. Splitting into per-component modules would be YAGNI.
**Status:** Applied in PR6 (no new module files for sections).
**Cross-refs:** spec §4.6 line 273.

### D60 — Settings half acceptance is subjective but bound by falsifiable token targets

**Date:** 2026-05-30 (PR6 plan-writing + ce-doc-review pass).
**Spec position:** §4.6: "the only PR with subjective 'feels right' review criteria."
**Reality:** Coherence target empirically verified against `frontend/src/styles/tokens.css:506-511` (`.overview-card`): `var(--surface-1)` background, `var(--border-1)` border, `var(--radius-3)` (8px) radius, `var(--s-4) var(--s-5)` padding, **NO `box-shadow`**. PR6 Task 8 SettingsSections.module.css `.section` matches: `var(--surface-1)` / `var(--border-1)` / `var(--radius-3)` / `var(--s-5)` padding / `var(--text-lg)` h2 / NO shadow.
**Plan resolution:** Falsifiable token list; if post-merge regret surfaces a mismatch, the diff to revert is explicit. Maintainer judgment on the `settings-page.png` parity baseline is the gate.
**Status:** Applied in PR6 (Task 8, commit `6635c85`). The original plan draft had `var(--radius-4)` + `var(--shadow-1)` — ce-doc-review adversarial caught the empirical mismatch against PR3 `.overview-card`; correction applied before implementation.
**Cross-refs:** spec §4.6 lines 275-278; PR3 tokens.css `.overview-card`.

### D61 — SetupPage gains a 3-element wrapper structure (.screen > .bg + .card)

**Date:** 2026-05-30 (PR6 plan-writing pass).
**Spec position:** §4.6 line 271 ("centered card on the accent radial-gradient wash"); §2.2 ("no component-logic changes").
**Reality:** Current `SetupPage.tsx` returns `<><SetupForm /><NoReposWarningModal /></>` with zero outer wrapper. The centered-card-on-radial-gradient layout requires a positioned outer wrapper (`.screen` for flex centering + scroll), an absolutely-positioned background layer (`.bg` for the radial gradient), and a relatively-positioned card host (`.card` for the form chrome).
**Plan resolution:** Add the 3-element wrapper structure. Adds DOM nodes, zero behavior change — inside spec §2.2 per PR2-PR5 precedent (PR3 added `<span>Loading…</span>` for WCAG; PR4 added `.diff-line` BEM wrappers). Pseudo-element alternative for `.bg` is not viable — `.screen` uses flex layout with `overflow: auto`; a `::before` flex item would not absolute-position cleanly.
**Status:** Applied in PR6 (Task 3, commit `1c58130`).
**Cross-refs:** PR3 D29; spec §4.6.

### D62 — SetupForm.module.css `.form` drops card-chrome

**Date:** 2026-05-30 (PR6 plan-writing pass).
**Spec position:** §4.6 ("polish to SetupForm.module.css").
**Reality:** Existing `.form` carries card chrome (padding, background, border, border-radius). With D61's wrapper structure, the `.card` class in `SetupPage.module.css` now owns the surface treatment.
**Plan resolution:** `.form` becomes pure `flex-direction: column`; vertical rhythm via `.section` and `.brand` margins. Single-responsibility split between SetupPage's `.card` (chrome) and SetupForm's `.form` (layout).
**Status:** Applied in PR6 (Task 4, commit `64687e7`).
**Cross-refs:** D61.

### D63 — Step heading restructure: `<strong>1.</strong>` → `<section><h2><span num>1</span> <a link>Generate a token</a></h2>…</section>`

**Date:** 2026-05-30 (PR6 plan-writing + ce-doc-review pass).
**Spec position:** §4.6 line 271 ("numbered-step pattern").
**Reality:** Handoff `.setup-num` is a 20×20 circle with accent-soft background — cannot be styled on inline `<strong>` text. Critical test constraint: `setup-page.test.tsx:78` asserts `findByRole('link', { name: /generate a token/i })`. The link text "Generate a token" MUST remain.
**Plan resolution:** Step 1's heading is `<h2 className={styles.sectionHead}><span className={styles.num}>1</span> <a className={styles.link}>Generate a token</a></h2>` — the link is nested INSIDE the heading, so the link text is preserved AND the numbered badge sits before the link inside the heading row. Step 2 has no link, so its h2 is `<h2>…<span num>2</span> Paste it below</h2>`. **Ordinal stays in a11y tree** — no `aria-hidden` on the `<span num>`; SR users hear "1, Generate a token" / "2, Paste it below" preserving step-ordinality wayfinding.
**Status:** Applied in PR6 (Task 4, commit `64687e7`). The original plan draft had `aria-hidden="true"` on the badge AND renamed the link text to "Open GitHub fine-grained PAT page" — ce-doc-review feasibility caught the test collision; adversarial caught the wayfinding strip. Both corrections applied before implementation.
**Cross-refs:** spec §4.6; setup-page.test.tsx:78.

### D64 — Brand block wraps into `<div className=brand><h1 title><p sub>` (NOT `<header>`)

**Date:** 2026-05-30 (PR6 plan-writing pass + preflight adversarial review).
**Spec position:** §4.6 ("centered card on the accent radial-gradient wash").
**Reality:** Handoff `.setup-brand` / `.setup-title` / `.setup-sub` block at the top of the card. Each maps to one module class. The original plan draft used `<header>` for the wrapper — preflight adversarial review caught that `<header>` inside `<form>` IS mapped to `role=banner` (the HTML AAM exclusion list is article/aside/main/nav/section — `<form>` is NOT in it), which would have created a duplicate banner landmark alongside the App-level `<Header />` on /setup.
**Plan resolution:** Wrap with `<div className={styles.brand}>` instead. Preserves the visual grouping (D62/D63 styling unaffected) without duplicating the banner landmark.
**Status:** Applied in PR6 (Task 4 commit `64687e7`; preflight fix subsequently corrected `<header>` → `<div>`).
**Cross-refs:** D61; preflight adversarial review.

### D65 — MaskedInput inline style → module + local eye-button size override

**Date:** 2026-05-30 (PR6 plan-writing + ce-doc-review pass).
**Spec position:** §4.6 line 271 ("eye toggle on the textarea").
**Reality:** Current `MaskedInput.tsx` uses inline `style={{ position: 'relative' }}` and renders an inline `<button>` for the eye toggle. Handoff line 1277 defines `.btn-icon-sm` (18×18) IMMEDIATELY before `.setup-eye` (1279) — implying intended composition `.btn-icon .btn-icon-sm`. But `.btn-icon-sm` is **NOT in tokens.css** (only `.btn-icon` 30×30 exists). Composing `.btn-icon` alone would overflow the input.
**Plan resolution:** Replace inline style with `className={styles.wrap}`. `.eye` carries a **local 18×18 size override** (`width: 18px; height: 18px`) alongside its position rules (`top: 8px; right: 8px`). `.input` adds `min-height: 36px` + `box-sizing: border-box` for a stable container. Lift-on-second-use trigger for `.btn-icon-sm` remains; if PR9 needs the 18×18 variant on another surface, it lifts then.
**Status:** Applied in PR6 (Task 6, commit `35eca62`). The original plan draft composed `.btn-icon` (30×30) without size override — ce-doc-review feasibility + design-lens both caught the overflow risk; correction applied before implementation.
**Cross-refs:** spec §4.6; handoff screens.css:1277-1279.

### D66 — Eye-toggle glyph: `{shown ? '🙈' : '👁'}` (visible-state feedback)

**Date:** 2026-05-30 (PR6 plan-writing + ce-doc-review pass).
**Spec position:** §4.6 ("eye toggle on the textarea") + §2.2 (no behavior changes).
**Reality:** Current `MaskedInput.tsx` has `{shown ? '👁' : '👁'}` — both branches identical (copy-paste defect from earlier slice). Sighted users get no visual feedback on toggle.
**Plan resolution:** Replace with `{shown ? '🙈' : '👁'}` (see-no-evil monkey ↔ eye — widely-supported emoji pair). aria-label still announces "Show token" / "Hide token" for AT. Visible-state feedback captured in PR6 baseline (avoids PR9 baseline re-capture cost).
**Status:** Applied in PR6 (Task 6, commit `35eca62`). Original plan draft kept single `'👁'` and deferred the variant to PR9 — ce-doc-review design-lens caught the baseline-re-capture cost argument; correction applied before implementation.
**Cross-refs:** spec §4.6.

### D67 — No `.setup-*` rules lifted to tokens.css

**Date:** 2026-05-30 (PR6 plan-writing pass).
**Spec position:** PR3 D22 / PR4 D34 / PR5 D47 — lift-on-second-use is the documented trigger.
**Reality:** Inventory (per D58-D59 scope reductions, ScopePill is deferred) confirmed every `.setup-*` handoff rule ported in PR6 has exactly ONE production consumer.
**Plan resolution:** No lifts. If PR9 catalogs ScopePill back into a real consumer or adds another Setup-style surface, the lift happens then.
**Status:** Applied in PR6 (no tokens.css additions).
**Cross-refs:** PR3 D22; PR4 D34; PR5 D47.

### D68 — Conditional `--text-lg` token-vocabulary fallback — NOT TRIGGERED

**Date:** 2026-05-30 (Task 8 Step 2).
**Spec position:** PR6 plan Task 8 Step 2 (`Grep pattern="--text-lg" path="frontend/src/styles/tokens.css"`).
**Reality:** Reserved during plan-writing in case `--text-lg` was missing from tokens.css (token-vocabulary regression scenario). The grep at Task 8 Step 2 confirmed `--text-lg: 17px` exists at tokens.css line 19; the conditional fallback to `var(--font-size-lg, 1.125rem)` was NOT applied.
**Plan resolution:** Stub retained so the D58-D70 sequence is contiguous and auditable. No code change; entry exists only to preserve numbering.
**Status:** Conditional, did not trigger.
**Cross-refs:** PR6 plan Task 8.

### D69 — SINGLE-PR6 vs SPLIT decision at Task 8.5

**Date:** 2026-05-30 (Task 8.5 split-checkpoint).
**Spec position:** Subagent-driven-development convention; PR2-PR5 mid-plan checkpoint precedent.
**Reality:** Measured at Task 8.5: 344 LOC net (265 inserts + 79 deletes) across 11 files in 4 directories, 7 review-meaningful changes (Tasks 2 + 3 + 4 + 5 + 6 + 7 + 8). Both metrics well below LOC>700 / changes>18 thresholds.
**Plan resolution:** SINGLE-PR6 selected. Override-tripwire NOT applied — same-maintainer / same-review-window precedent from PR2-PR5 (PR4 shipped at 1120 LOC / 15 changes as single, PR5 at 311 LOC / 9 changes; PR6 at 344 LOC / 7 changes is well within the empirical SINGLE band). Subjective-Settings concern (D60) bound by falsifiable token targets per the post-ce-doc-review correction; reviewer can litigate exact tokens against tokens.css:506-511 rather than vibes.
**Status:** Decided at Task 8.5; PR6 ships single.
**Cross-refs:** D60; PR4 D42; PR5 D54.

### D70 — `.fineprint` lock icon deferred to PR9 a11y polish

**Date:** 2026-05-30 (PR6 plan-writing + ce-doc-review pass).
**Spec position:** §4.6 line 271 ("fineprint with lock icon").
**Reality:** Handoff `.setup-fineprint` (screens.css:1289-1295) defines `display: flex; align-items: center; gap: 6px; justify-content: center` — implying a flex row with an inline icon + short text. But the handoff doesn't ship a glyph source (no SVG token, no icon-library import); adding a lock icon requires a design call about source: emoji `🔒` (cross-platform-inconsistent rendering), SVG inlined into the JSX (visual fidelity but more code), or an icon library (new dependency). Furthermore, `FirstRunDisclosure` is a `<details>` block (collapsible multi-line content), not a flex row — the handoff's flex/center/gap rules don't apply meaningfully to it.
**Plan resolution:** Ship `.fineprint` typography (margin / font-size / color) in PR6 without a glyph. The handoff `.setup-fineprint` flex+gap+center rules intentionally NOT ported because the disclosure widget is multi-line collapsible content. PR9 polish picks the glyph source and re-captures the `setup-card.png` baseline. If PR9 adds a `<span aria-hidden="true">🔒</span>` prefix to the `<summary>`, the flex+gap+center rules land then.
**Status:** Deferred to PR9.
**Cross-refs:** spec §4.6; handoff screens.css:1289-1295.
