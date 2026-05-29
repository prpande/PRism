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
