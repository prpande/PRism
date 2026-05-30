# Design parity recovery — non-Inbox surfaces (PR2-PR6) + handoff chrome additions (PR7-PR8)

**Date**: 2026-05-29.
**Status**: Drafted; `compound-engineering:ce-doc-review` pass complete (7 reviewers, ~40 findings triaged); awaiting human review before `writing-plans` handoff. Findings disposition surfaced in the chat summary that accompanies this draft.
**Source authorities**:
- [`design/handoff/README.md`](../../design/handoff/README.md) — handoff prototype's scope, fidelity, intentional mocks, and explicit non-goals.
- [`design/handoff/screens.css`](../../design/handoff/screens.css) — the 1500-ish lines of component-level CSS the production app needs to match.
- [`frontend/src/styles/tokens.css`](../../frontend/src/styles/tokens.css) — current token + primitive layer (faithful port from the handoff; one documented WCAG deviation).
- [`.ai/docs/design-handoff.md`](../../.ai/docs/design-handoff.md) — non-negotiables for the handoff port (tokens as-is, spacing scale gap, no hero panel, no rail < 1180px, slate tints).
- [`.ai/docs/documentation-maintenance.md`](../../.ai/docs/documentation-maintenance.md) — which docs to update per change type.
- [`docs/specs/2026-05-15-s6-polish-and-distribution-design.md`](2026-05-15-s6-polish-and-distribution-design.md) — S6 decided Settings is a page, not a floating tweaks panel. That decision stands.

---

## 1. Background — the gap is a porting omission, not a design drift

The handoff prototype (`design/handoff/`) is a high-fidelity React-via-inline-Babel prototype. Tokens (`design/handoff/tokens.css`) were ported to `frontend/src/styles/tokens.css` faithfully (one justified deviation: `--text-3` lightness was lowered in S6 PR #75 for WCAG AA contrast, documented inline). The Inbox surface got per-component CSS modules (`InboxRow.module.css`, `InboxSection.module.css`, `ActivityRail.module.css`, etc.) and matches the handoff.

Every other surface — Setup, Settings, and the entire PR Detail surface — is in a different state:

- **PR Detail** ships JSX referencing global class names (`pr-header`, `pr-meta`, `pr-actions`, `pr-title`, `pr-tab`, `overview-tab`, `overview-grid`, `overview-card`, `iter-chip`, `tree-row`, `diff-area`, `stale-row`, `drafts-tab-file-group`, etc.) that **do not exist anywhere in `frontend/src/`**. `design/handoff/screens.css` has 166 matching rule sets; not one was ported. The PR Detail surface is rendering structural DOM with only the utility classes from `tokens.css` (`row`, `col`, `gap-*`, `chip`, `btn`, `kbd`, `muted`, `tnum`) and a small set of S5-shipped submit-surface rules (`.verdict-picker`, `.submit-dialog`, etc., in `tokens.css:493-637`).
- **Setup** has partial module CSS (`SetupForm.module.css`, `NoReposWarningModal.module.css`) but doesn't yet implement the handoff's centered-card-on-accent-radial-gradient layout, numbered-step pattern, or eye toggle styling.
- **Settings** was built in S6 with no handoff reference — it's a *new* surface (the handoff has a floating bottom-right tweaks panel, which S6 explicitly replaced with a Settings page). Its current styling is functional but inconsistent with the rest of the restored design.
- **Two handoff-designed chrome pieces were never built**: the browser-style PR tab strip (top-of-app Row 2, persistent across the SPA, `⌘1–9` jump, `⌘W` close, overflow menu, unread dots) and the right-side Ask AI drawer (slide-in chat surface).

### 1.1 Verified — the "empty screen on inbox-row click" perception

A focused Playwright run (2026-05-29, against `dotnet run` Development env + Vite dev proxy, handoff fixture) confirms:

- Inbox row click navigates to `/pr/{owner}/{repo}/{number}`.
- The `<Route index element={<OverviewTab />} />` in [`App.tsx:72`](../../frontend/src/App.tsx) renders Overview by default. `aria-selected="true"` is on the Overview sub-tab.
- All 5 Overview components mount under `.overview-grid`: `AiSummaryCard`, `PrDescription`, `StatsTiles`, `PrRootConversation`, `ReviewFilesCta`.
- Clicking the Overview sub-tab while on Overview is a no-op (same URL, same content) — exactly the symptom the original report names as "have to click Overview to make it appear."

The perception of emptiness is **not** a routing or render bug; it is the consequence of the missing-CSS gap. The cards collapse to a flat text stack against `--surface-0` with no card boundaries, the stats tiles render as a vertical `<dt>/<dd>` dump because `.stats-tiles` has no grid layout, and `.pr-tab.is-active` has no visual treatment so the sub-tab strip can't telegraph which tab is active. **PR2 (sub-tab active-state + chrome) and PR3 (Overview card grid) together dissolve this perception.** Landing PR3 alone fixes the card-collapse symptom but leaves the sub-tab strip without a visible active-state until PR2 lands; the user-perceived "fix" requires both.

### 1.2 Side discovery — dev-mode 401 cascade

The verification surfaced a real but dev-mode-only bug. Sequence:

1. User clicks an inbox row → SPA navigates to `/pr/.../...`.
2. `useActivePrUpdates` mounts and `POST /api/events/subscriptions`.
3. Backend [`EventsEndpoints.SubscribeAsync`](../../PRism.Web/Endpoints/EventsEndpoints.cs#L37-L70) checks `Request.Cookies["prism-session"]`. In dev (Vite proxy on `:5173`, backend on `:5180`), this cookie is missing because Vite serves the SPA's HTML — `SessionTokenMiddleware` bypasses its own auth in Development for this exact reason ([`SessionTokenMiddleware.cs:30-44`](../../PRism.Web/Middleware/SessionTokenMiddleware.cs)), but `SubscribeAsync` does its own cookie check and returns **401**.
4. [`apiClient.ts:75-77`](../../frontend/src/api/client.ts) dispatches `prism-auth-rejected` on any 401.
5. [`App.tsx`](../../frontend/src/App.tsx) flips `authInvalidated` to true; `isAuthed` evaluates false; every protected route's `<Navigate to="/setup" replace />` fires; user is bounced to the Setup screen.

Production (Kestrel serves SPA and API on same origin, cookie present) does not exhibit this. The bug is dev-mode-only, but it blocks dev-time iteration for every PR in this roadmap. **PR1 includes the fix** (§ 4.1.2).

### 1.3 Relationship to v1 ship and other in-flight work

This roadmap is **post-v1** by default. The v1 completion roadmap ([`docs/specs/2026-05-28-v1-completion-roadmap-design.md`](2026-05-28-v1-completion-roadmap-design.md)) commits to a two-phase path (Phase 2 README sweep + Phase 3 tag/publish) on the explicit bounded-cost argument that polish is ~1-2 days. Inserting this 9-PR roadmap pre-v1 would invalidate that argument. Two exceptions are reasonable to consider during human review:

- **PR1 + PR2 + PR3 pre-v1.** These three close the user-visible "empty screen on inbox-row click" perception that motivates this whole roadmap. If first-impression quality for the N=3 cohort is load-bearing, the smallest pre-v1 cut is PR1 (foundation), PR2 (chrome), PR3 (Overview). PR4-PR9 remain post-v1.
- **Whole roadmap post-v1 (v0.1.x).** Cleaner sequencing. N=3 sees today's Inbox-restored + PR-Detail-unstyled state. The empty-screen perception is documented as a known issue alongside the single-instance one already deferred in PR #86.

**Native-shell coupling risk.** The v1 roadmap amendment (2026-05-28) notes the application architecture is shifting to a native shell (WebView2 / Tauri / Electron / MAUI Blazor Hybrid — framework TBD). Phase 1 single-instance was deferred specifically because the shell choice materially changes window/IPC/focus semantics. **PR7's browser-style tab strip is in the same risk class** — `⌘W`, `⌘1-9`, middle-click, and localStorage tab persistence are all browser-tab-architecture-bound design decisions that may need rework when the shell lands. PR7's brainstorm pass must surface this collision explicitly; defer-behind-shell-decision is an acceptable PR7 outcome.

**AI-during-trial signal pollution.** The v1 roadmap explicitly defers AI work. The handoff is AI-augmented throughout — AI summary card, AI hunk annotations, AI focus dots in file tree, AI suggestion in stale-draft rows, and the Ask AI drawer (PR8). Restoring these visuals with canned data risks polluting the N=3 trial's "I'd switch to this" signal (a faked AI feature may read as "the AI is bad" rather than "the AI is absent"). The PoC's existing surfaces gate on the `aiPreview` flag; restored AI-dependent visuals in this roadmap **must** stay gated. PR8's Ask AI drawer in particular is candidate for v1.x deferral rather than v1 ship — see § 4.8 and PR9's revisit candidates.

---

## 2. Goal and non-goals

### 2.1 Goal

Bring the non-Inbox surfaces (Setup, Settings, all of PR Detail) into visual parity with `design/handoff/screens.css`, and build the two pieces of designed-but-never-implemented chrome (browser-style PR tab strip across the top, right-side Ask AI drawer). Tokens are already faithful; what's missing is the component-level styling and the two chrome behaviors.

**Two categories of work.** PR2-PR6 are *parity restoration*: existing JSX with handoff classnames gets its CSS ported into modules. PR7-PR8 are *net-new behavior with handoff visual reference*: state, routing, focus management, and edge cases that the handoff sketches but the production app has never carried. The "parity" label is precise for the former; for the latter it means "the handoff's visual design serves as the spec, but the implementation is new code." Reviewers of PR7 and PR8 should bring brainstorm-level scrutiny, not className-rename scrutiny.

### 2.2 Non-goals — explicit

- **No redesign.** The handoff is the visual spec. Any deviation in a slice requires a justification in that slice's deferrals sidecar.
- **No component-logic changes.** Class names, layout, and small JSX restructuring are in scope; state, routing (except the new PR tab strip in PR7), and data fetching are out.
- **No Settings re-architecture.** The S6 decision to ship Settings as a page (not the handoff's floating tweaks panel) stands. PR6 aligns Settings to the *visual style* of the restored PR Detail — same surface/border tokens, type scale, spacing — but the structural divergence is intentional and stays. The Settings half of PR6 is the only PR with subjective "feels right" review criteria; the maintainer's side-by-side judgment is the gate.
- **No AI backend work.** The Ask AI drawer (PR8) is a working stub chat: textarea + send button + local message state + canned "AI" responses with a simulated delay. No model call. No backend.
- **No Inbox component changes.** Inbox component files (`InboxPage.tsx`, `InboxRow.tsx`, `InboxSection.tsx`, `InboxToolbar.tsx`, etc.) are not touched. If any Inbox file shows up in a diff, that's a regression to flag. **Caveat for PR7**: adding Row 2 (the PR tab strip) above the Header shifts Inbox's rendered Y-position whenever ≥1 PR is open, even though no Inbox file changes. The Inbox viewport baseline must be re-captured as part of PR7's scope (see § 6.9).

---

## 3. Styling architecture

Approach: **hybrid — CSS modules for component-specific layouts, additions to `tokens.css` for primitives shared across ≥2 component scopes**. This matches the existing project convention (Inbox / Setup / Settings already operate on this principle) and avoids creating a parallel global stylesheet for PR Detail.

### 3.1 Rules

- **Component-specific layouts → CSS modules.** Colocated with the `.tsx`. CamelCase class names. Example: `frontend/src/components/PrDetail/PrHeader.module.css` contains `.prHeader`, `.prHeaderTop`, `.prMeta`, `.prActions`, referenced as `styles.prHeader` etc. in `PrHeader.tsx`.
- **Primitives (≥2 component scopes) → `tokens.css`.** New ones the handoff introduces that aren't yet there (`.chip-status-stale`, `.chip-status-moved`, AI-surface variants, any diff color hooks not already defined) get appended to `tokens.css` in the slice that first needs them.
- **Existing global classes reused as-is.** `.row`, `.col`, `.gap-*`, `.muted`, `.tnum`, `.btn`, `.btn-primary`, `.btn-sm`, `.btn-ghost`, `.btn-secondary`, `.btn-icon`, `.chip`, `.chip-success`/`-warning`/`-danger`/`-info`/`-accent`, `.chip-status-*`, `.kbd`, `.ai-tint`, `.ai-icon`, `.dot`, `.card`, `.input`, `.textarea`, `.banner`, `.avatar`, `.logo-mark`, `.sr-only` all already live in [`tokens.css`](../../frontend/src/styles/tokens.css). JSX composes them as plain class strings alongside scoped module classes.
- **Class composition example.** Handoff source `<section class="overview-card overview-card-hero ai-tint">` ports to `<section className={`${styles.overviewCard} ${styles.overviewCardHero} ai-tint`}>`. The `ai-tint` primitive stays a plain global string; the layout classes are scoped.
- **Naming convention.** Kebab-case from the handoff → camelCase in the module. `.pr-header` → `styles.prHeader`. `.overview-card-hero` → `styles.overviewCardHero`. `.tree-status-success` → `styles.treeStatusSuccess`. State/variant modifiers stay as separate classes rather than collapsing into BEM suffixes (matches Inbox's `rowFresh`/`rowToday`/`rowOlder`).
- **Lift-on-second-use rule.** If a slice needs a class from a second module's CSS, lift it to `tokens.css` in that PR. Don't duplicate. The deferrals sidecar logs every lift so reviewers can trace where each primitive originated.
- **Multi-PR coordination.** The lift rule assumes sequential merges. To make this work without rebase churn: (i) PRs in this roadmap merge sequentially against `main` (no parallel WIP that shares the same primitive surface), OR (ii) speculative lifting is permitted when the spec explicitly lists ≥2 consumers — the deferrals sidecar logs the speculative lift with the second-consumer reference. Default is (i); (ii) is an opt-in for slices that the implementer has confident lookahead on.

### 3.2 Resulting file layout (PR Detail subset)

```
frontend/src/components/PrDetail/
  PrHeader.tsx + PrHeader.module.css
  PrSubTabStrip.tsx + PrSubTabStrip.module.css
  BannerRefresh.tsx + BannerRefresh.module.css
  CrossTabPresenceBanner.tsx + CrossTabPresenceBanner.module.css
  AskAiButton.tsx
  AskAiDrawer.tsx + AskAiDrawer.module.css         (new in PR8)
  OverviewTab/
    OverviewTab.tsx + OverviewTab.module.css
    AiSummaryCard.tsx + AiSummaryCard.module.css
    PrDescription.tsx + PrDescription.module.css
    StatsTiles.tsx + StatsTiles.module.css
    PrRootConversation.tsx + PrRootConversation.module.css
    MarkAllReadButton.tsx + MarkAllReadButton.module.css
    ReviewFilesCta.tsx + ReviewFilesCta.module.css
  FilesTab/
    FilesTab.tsx + FilesTab.module.css
    IterationTabStrip.tsx + IterationTabStrip.module.css
    CommitMultiSelectPicker.tsx + CommitMultiSelectPicker.module.css
    ComparePicker.tsx + ComparePicker.module.css
    FileTree.tsx + FileTree.module.css
    DiffPane/
      DiffPane.tsx + DiffPane.module.css
      AiHunkAnnotation.tsx + AiHunkAnnotation.module.css
      ExistingCommentWidget.tsx + ExistingCommentWidget.module.css
      DiffTruncationBanner.tsx + DiffTruncationBanner.module.css
      MarkdownFileView.tsx + MarkdownFileView.module.css
      WordDiffOverlay.tsx + WordDiffOverlay.module.css
  DraftsTab/
    DraftsTab.tsx + DraftsTab.module.css
    DraftListItem.tsx + DraftListItem.module.css
    DraftListEmpty.tsx + DraftListEmpty.module.css
    DraftsTabSkeleton.tsx + DraftsTabSkeleton.module.css
    DraftsTabError.tsx + DraftsTabError.module.css
    DiscardAllStaleButton.tsx + DiscardAllStaleButton.module.css
  Reconciliation/
    UnresolvedPanel.tsx + UnresolvedPanel.module.css
    StaleDraftRow.tsx + StaleDraftRow.module.css
  ImportedDraftsBanner.tsx + ImportedDraftsBanner.module.css
  ForeignPendingReviewModal/
    ForeignPendingReviewModal.tsx + ForeignPendingReviewModal.module.css
    DiscardConfirmationSubModal.tsx + DiscardConfirmationSubModal.module.css
  Composer/
    InlineCommentComposer.tsx + InlineCommentComposer.module.css
    ReplyComposer.tsx + ReplyComposer.module.css
    PrRootReplyComposer.tsx + PrRootReplyComposer.module.css
    ComposerMarkdownPreview.tsx + ComposerMarkdownPreview.module.css
```

The submit-surface (`SubmitButton.tsx`, `SubmitDialog/*`, `VerdictPicker.tsx`, `SubmitInProgressBadge.tsx`, `SubmitProgressIndicator.tsx`, `DiscardAllDraftsButton.tsx`, `DiscardAllConfirmationModal.tsx`) already has shipped styling in `tokens.css:493-637` from S5. **It is not re-styled in this roadmap.** If a slice (most likely PR5) finds genuine drift between the existing submit styling and the restored PR Detail visual language, the discrepancy is flagged in the slice's deferrals sidecar for the revisit pass (PR9) to adjudicate.

App-level chrome additions:
```
frontend/src/components/Header/
  Header.tsx + Header.module.css                   (existing — minor touch in PR7)
  PrTabStrip.tsx + PrTabStrip.module.css           (new in PR7 — Row 2)
```

---

## 4. The 9-PR plan

CSS-first ordering. Every PR2-PR6 is pure visual restoration (no behavior changes). PR7-PR8 add the two new chrome behaviors. PR9 audits and documents.

### 4.1 PR1 — Foundation

No visual changes. Four atomic pieces, all scaffolding for the rest of the roadmap.

#### 4.1.1 Handoff-parity fixture

Mirrors the handoff prototype's PR `#1842` exactly so side-by-side parity comparison works.

- New `HandoffParityFixture` class in `PRism.Web/TestHooks/`: hardcoded `PrDetailDto` matching handoff data. Title `"Refactor LeaseRenewalProcessor to use the new BillingClient batch API"`, author `amelia.cho`, branch `amelia/batch-renewal → main`, head SHA fake-stable (e.g., `1842abc…`), three iterations with the handoff's file lists (per `design/handoff/data.jsx`), threads anchored at the handoff's line numbers.
- New `POST /test/load-handoff-parity-fixture` endpoint **registered inside `MapTestEndpoints`** (which env-guards to `IsEnvironment("Test")` per `PRism.Web/TestHooks/TestEndpoints.cs:109`). The runtime `StoreMissing` guard fires when `FakeReviewBackingStore` is absent from DI (the `PRISM_E2E_FAKE_REVIEW` env-var controls that DI swap per `Program.cs`). This matches the existing `/test/advance-head`, `/test/reset`, etc. pattern. The previous draft of this spec described the gate as env-var-only, which was wrong — registration is Test-env-gated, the env-var is the secondary DI gate.
- Loads the fixture into a fixture-aware extension of `FakeReviewBackingStore`. **Schema-gap acknowledgement**: the handoff's `data.jsx` predates S0-S6 evolution (cross-tab stamps, V5→V6, foreign-pending-review payloads, iteration discriminated-union shapes). The fixture author must translate handoff content into the current `PrDetailDto`; where the translation drops handoff visual detail (e.g., handoff AI summary content shape vs `useAiSummary` shape, handoff stale-draft AI suggestion body), the gap is enumerated in this section before PR1 lands so PR3-PR5 inherit a known-defect-list rather than discovering them during side-by-side review.
- Reachable from the SPA at `/pr/handoff-parity/sample/1842` once loaded. Same code path as a real PR — comparison exercises the *real* render pipeline. In Development without the fixture loaded (e.g., a dogfooder running `dotnet run` after `PRISM_E2E_FAKE_REVIEW=1` was accidentally exported), the route falls through to the real GitHub client; a 404 (or whatever GitHub returns for `handoff-parity/sample`) renders. The fixture loader is opt-in by Playwright helper or manual `/test/load-handoff-parity-fixture` POST; nothing auto-loads.
- Playwright helper `setupAndOpenHandoffParityFixture(page)` in `frontend/e2e/helpers/`, mirroring the existing `setupAndOpenScenarioPr(page)`.
- Production builds — `MapTestEndpoints` returns early under `IsEnvironment("Test") == false`, so the endpoint is not registered. Zero attack surface.
- **Cost-to-gate fallback.** If `FakeReviewBackingStore` requires significant extension to host a second PR reference (the existing store is keyed to `Scenario = new("acme", "api", 123)`), and the construction cost exceeds ~1 day of work, fall back to using the existing `acme/api/123` scenario fixture with side-by-side review against the locally-loaded handoff prototype (no fixture-content match required — reviewers compare structure and visual treatment, not content). The fixture's marginal value over the locally-loaded prototype is real but not load-bearing; accept the simpler approach if the construction tax is high.

Tests: a unit-level assertion that the fixture's `PrDetailDto` shape round-trips through the same JSON path as real PR detail responses (catches token-rename regressions); an e2e smoke that `setupAndOpenHandoffParityFixture` actually navigates and renders the expected title.

#### 4.1.2 Dev-mode 401 fix

Single-file backend change to [`PRism.Web/Endpoints/EventsEndpoints.cs:64-70`](../../PRism.Web/Endpoints/EventsEndpoints.cs):

```csharp
if (string.IsNullOrEmpty(cookieSessionId))
{
    return TypedResults.Problem(
        detail: "No prism-session cookie present on this request — connect to /api/events first.",
        type: "/events/no-session",
        statusCode: StatusCodes.Status403Forbidden);  // was Status401Unauthorized
}
```

Rationale (kept as a code comment): 401 in this project means "session token is bad — re-auth"; 403 means "this operation is not allowed in the current state." Missing cookie is the latter — the user is authed; the SSE-connect prerequisite hasn't been met. The previous 401 caused `apiClient.ts:75-77` to dispatch `prism-auth-rejected`, triggering the unwanted /setup redirect in dev mode.

Tests: the existing `Subscribe_returns_401_when_no_cookie_session_present` test (in `tests/PRism.Web.Tests/Endpoints/EventsSubscriptionsEndpointTests.cs` per the round-1 security review) is renamed to `Subscribe_returns_403_when_no_cookie_session_present` and its `HttpStatusCode.Unauthorized` assertion flips to `HttpStatusCode.Forbidden`. No frontend changes (the existing 401-handling path in `apiClient.ts` stays — it's correct for the cases that produce *real* 401s, where the SessionTokenMiddleware itself rejects). PR1 review must confirm no other backend endpoint relies on `SubscribeAsync`'s cookie-missing 401 as a generic auth-failure signal.

#### 4.1.3 Viewport screenshot baseline harness

New Playwright spec `frontend/e2e/parity-baselines.spec.ts`. Extends the `__screenshots__/{platform}/` precedent from PR9's `no-layout-shift-on-banner.spec.ts`.

- **Scope (initial).** One test per restored surface zone, narrow viewport box per zone:
  - `inbox`, `inbox-activity-rail`, `setup-card`, `settings-page`
  - `pr-detail-header`, `pr-detail-overview`, `pr-detail-files-tree`, `pr-detail-files-diff`, `pr-detail-drafts`, `pr-detail-reconciliation-panel`
  - **Added in PR7**: `app-chrome-tabstrip`
  - **Added in PR8**: `ask-ai-drawer`
- **Fixture.** PR-detail zones load the handoff-parity fixture (§ 4.1.1). Inbox/Setup/Settings use the existing scenario fixtures.
- **Tolerance.** `maxDiffPixelRatio: 0.02` (loose, per the documented font-hinting / GPU-subpixel-rendering fragility in [`frontend/e2e/no-layout-shift-on-banner.spec.ts`](../../frontend/e2e/no-layout-shift-on-banner.spec.ts) — the precedent from S6 PR #82). The supplementary nature of the screenshot diff is documented inline in the spec.
- **Initial baseline policy.** PR1 commits `parity-baselines.spec.ts` **without** capturing the current unstyled-DOM baselines. Each subsequent restoration PR (PR2-PR8) is responsible for `--update-snapshots` on the zones it touches, with the *first styled / passing state* as the first committed baseline. This avoids committing 13 known-bad PNG snapshots into git as a binary "before" record (PNG binary diffs aren't human-readable; the historical-artifact value the original draft cited doesn't hold up). PR7 additionally re-captures the `inbox` and `inbox-activity-rail` baselines because Row 2 chrome shifts Inbox layout (see § 2.2 / § 6.9).
- **Scope clarification.** The harness catches per-zone visual drift between baseline updates. It does NOT (a) verify any baseline matches the handoff — the side-by-side review (§ 4.1.4) is the sole parity gate; nor (b) catch a token-level change that propagates within `maxDiffPixelRatio: 0.02` across multiple zones. Both limitations are accepted; the human side-by-side closes the parity-gate hole, and token changes are caught in the per-PR pre-push.
- **`data-testid` requirement.** Several zones don't yet have `data-testid` attributes (the spec defers component-level edits to per-slice work). PR1 documents the required selectors per zone but does NOT add the attributes — each restoration PR (PR2-PR8) adds its zone's `data-testid` as part of that slice's JSX touch. This is a narrow scope addition to the "PR1 does NOT touch frontend production code" rule (§ 4.1.5) — accepted, but called out so reviewers don't expect the harness to be greenfield-runnable on day one.
- **Per-platform pinning.** Same `__screenshots__/{platform}/` template as `no-layout-shift-on-banner.spec.ts`. Windows baseline lives under `win32/`; CI runs `windows-latest`, so the canonical baseline matches the CI platform.

#### 4.1.4 Side-by-side review convention

Addition to [`.ai/docs/design-handoff.md`](../../.ai/docs/design-handoff.md), one paragraph:

> **Parity PR checklist.** Every PR that ports a handoff-defined surface MUST include side-by-side screenshots in its description: handoff prototype on the left (load `design/handoff/PRism.html` locally with the handoff-parity fixture if needed), implementation on the right, captured at the same viewport. Use the `compound-engineering:ce-demo-reel` skill for capture. Reviewer's pass on the side-by-side is the parity gate; the viewport baseline regression in `frontend/e2e/parity-baselines.spec.ts` is the *regression* gate (catches future drift, not initial fidelity).

#### 4.1.5 PR1 explicitly does NOT

- Rename any existing JSX class names.
- Modify any existing module CSS.
- Touch any frontend production code. The 401 fix is server-side; the baseline harness lives under `frontend/e2e/`; the fixture helper lives under `frontend/e2e/helpers/`. The only frontend file touched is the test helper.

### 4.2 PR2 — PR Detail chrome (CSS)

Module CSS for: `PrHeader`, `PrSubTabStrip`, `BannerRefresh`, `CrossTabPresenceBanner`, `ImportedDraftsBanner`.

Restores: slim PR header layout (PR num/title/branch/author + verdict picker + Submit + Ask AI button), three-tab sub-strip with proper active-state visual, the update banner ("amelia.cho pushed iter 3 — 2 of your drafts may need attention"), the cross-tab presence banner, and the imported-drafts banner.

JSX changes are className-only — every component listed above shifts its global className strings to `styles.prHeader` / `styles.prHeaderTop` / etc. Each affected `.tsx` file gets a sibling `.module.css`. Test files asserting on `.pr-tab`, `h1.pr-title`, `.pr-actions` etc. are updated in the same PR.

Side-by-side capture target: the PR header + sub-tab strip zone.

### 4.3 PR3 — Overview tab (CSS)

Module CSS for: `OverviewTab`, `AiSummaryCard`, `PrDescription`, `StatsTiles`, `PrRootConversation`, `MarkAllReadButton`, `ReviewFilesCta`. Plus `PrRootReplyComposer` (the only composer surface visible on Overview).

Restores: the card grid, AI summary card with sparkle icon + label + risk chips, PR description card boundary, the stats tile row (files/drafts/threads/viewed as four distinct tiles), PR-root conversation as a vertical timeline with avatar rail + connecting line, the Review-files CTA + keyboard-hint footer.

Biggest user-visible delta in this roadmap. Overview is the first surface seen on every inbox-row click.

Side-by-side capture target: the Overview tab card grid.

### 4.4 PR4 — Files tab (CSS)

Module CSS for: `IterationTabStrip`, `CommitMultiSelectPicker`, `ComparePicker`, `FileTree`, `DiffPane`, `AiHunkAnnotation`, `ExistingCommentWidget`, `DiffTruncationBanner`, `MarkdownFileView`, `WordDiffOverlay`, `InlineCommentComposer`, `ReplyComposer`, `ComposerMarkdownPreview`.

Restores: iteration tab strip (chip cards with +/− counts, new-iteration dot), commit multi-select picker (low-quality clustering path), file tree (header + progress bar + rows with viewed checkbox + status badge + +/− counts + AI focus dot when `aiPreview` is on), diff toolbar, side-by-side AND unified diff bodies, hunk headers, comment thread anchoring with reply composers inline, AI hunk annotations (canned data, gated on `aiPreview`), word-diff overlay, markdown-file rendering.

**No-file-selected state.** On Files tab arrival with no file pre-selected (which is the production default — the handoff's prototype always pre-selects a file but the SPA does not), the diff pane shows a centered empty-state in `--text-3` text: "Select a file from the tree to view its diff." Styled via `.diff-pane-empty` in `DiffPane.module.css`. This is a small handoff-deviation flagged in the slice's deferrals sidecar — the handoff has no `.diff-pane-empty` rule, and this surface is unavoidable in production.

**Loading state.** While a diff chunk is fetching (a useFileDiff in-flight), the diff pane keeps the prior file's content visible with a `--text-3` "Loading…" overlay in the toolbar area. No skeleton blocks the prior content; the smaller signal in the toolbar matches the handoff's calm-loading posture.

**Split policy (per-slice judgment).** Default is a single PR4. If implementation surfaces >~600 LOC of CSS or >8 review-meaningful changes, the implementer splits into PR4a (left half: iteration strip + commit picker + file tree) and PR4b (right half: diff body + threads + composers + AI annotations + word overlay + markdown view). Decision lives in the PR4 work commit; not pre-committed in this spec.

Side-by-side capture targets: file tree zone, diff pane zone.

### 4.5 PR5 — Drafts tab + reconciliation surface (CSS)

Module CSS for: `DraftsTab`, `DraftListItem`, `DraftListEmpty`, `DraftsTabSkeleton`, `DraftsTabError`, `DiscardAllStaleButton`, `UnresolvedPanel`, `StaleDraftRow`, `ForeignPendingReviewModal`, `DiscardConfirmationSubModal`.

Restores: drafts-by-file grouping with file headings, stale-draft row presentation (severity chips, file:line anchors, body quote, "Show me / Edit / Discard / Keep anyway" actions, AI-suggestion chip when `aiPreview` is on), the unresolved-panel sticky-top reconciliation surface, the foreign-pending-review modal flow.

Side-by-side capture targets: Drafts tab zone, reconciliation-panel zone.

### 4.6 PR6 — Setup + Settings coherence (CSS)

**Setup half** — module CSS for: `SetupPage`, polish to `SetupForm.module.css`, new `FirstRunDisclosure.module.css`, `MaskedInput.module.css`, `ScopePill.module.css`.

Restores: centered card on the accent radial-gradient wash (per the handoff Setup spec), numbered-step pattern ("1. Generate a token" / "2. Paste it below"), required-permissions block, eye toggle on the textarea, fineprint with lock icon. Side-by-side comparison is direct against handoff Setup.

**Settings half** — polish to `SettingsPage.module.css`, `SettingsSections.module.css`, plus any new module CSS the section components need.

Restores: card surface, type scale, spacing alignment to the restored PR Detail. **No handoff reference** (Settings is a new surface that replaced the handoff's floating tweaks panel per S6). Bar is subjective: "feels like a sibling of the restored PR Detail." Maintainer's side-by-side judgment is the gate. Side-by-side comparison for review uses the restored PR Detail surface (e.g., Overview cards) as the implicit reference for what coherence looks like.

This is the only PR in the roadmap with subjective acceptance criteria. Reviewer should expect higher noise.

### 4.7 PR7 — Browser-style PR tab strip (behavior)

First behavior PR. Adds top-of-app Row 2 — the persistent browser-style PR tab strip from the handoff.

**State (App level).**
- `openTabs: PrReference[]` — array of currently-open PRs. Persisted to localStorage (key `prism.openTabs.v1`).
- `unreadTabs: Set<string>` — PRs with new activity since last focus. Cleared on tab focus.
- `overflowMenuOpen: boolean` — controls the `+ N more` chevron menu visibility past 6 tabs.

**Routing integration.**
- Inbox row click: adds reference to `openTabs` (no-op if already present), then `navigate(/pr/{owner}/{repo}/{number})`.
- Direct URL load to `/pr/...`: adds reference to `openTabs` if not present (so a deep link populates the strip).
- Tab click: `navigate(/pr/{owner}/{repo}/{number})`.
- Tab close: splice from `openTabs`. If the closed tab was active, focus the left neighbor; if there's no left neighbor, focus `/`.

**Interactions.**
- `⌘1`–`⌘9`: jump to the nth tab.
- `⌘W`: close the active tab.
- Middle-click on a tab: close it.
- Overflow: when `openTabs.length > 6`, show a `+ N more` chevron that opens a menu of the overflowed tabs.

**Visuals (per handoff).**
- Active tab gets top-edge accent + merges visually with page below via negative-margin.
- Unread tabs show a small accent dot before the `×` close button + bold title.
- Truncated title with `#NNNN` prefix.

**Closing the last open tab.** Navigates to `/` (Inbox) and hides Row 2 entirely. `Row 2 only renders when openTabs.length ≥ 1`. Matches the documented "focus /" fallback.

**Overflow menu close affordance.** Per the handoff (`.pr-tabbar-menu-close` exists in `screens.css`), each item in the `+ N more` menu carries its own close affordance — overflowed tabs can be closed without first navigating to them. PR7 carries this visual; the close button uses the same `--text-3` muted treatment as the in-strip close `×`.

**Persistence.** `openTabs` is JSON-serialized to localStorage under the versioned key `prism.openTabs.v1`. On load: parse, validate (each entry has `owner`, `repo`, `number` of correct types); on parse failure or shape mismatch (e.g., a future `v2` schema), silently discard the stored value and start fresh. Privacy classification: the persisted reference list contains org-level `owner/repo/number` triples — local-machine-only data, classified low-sensitivity (consistent with PRism's existing local-first threat model in `docs/spec/06-security-baseline.md`). No expiry; the close affordance is the user's pruning mechanism.

**Native-shell coupling — resolution.** PR7's brainstorm pass selected **route (b) visual-only**: NO `⌘W` (close tab), NO `⌘1-9` (jump to tab), NO localStorage persistence. Middle-click DOES ship (no OS reservation — every candidate shell passes mouse events through to the renderer; see [`D58`](2026-05-29-design-parity-recovery-deferrals.md#d58) for the OS-reservation rationale that differentiates `⌘W` from middle-click). Tabs survive only the current SPA session and are cleared on `identity-changed` via the existing `prism-identity-changed` window-event bridge. Keyboard bindings and persistence are revisited after the native-shell framework decision lands ([`D58`](2026-05-29-design-parity-recovery-deferrals.md#d58) keyboard, [`D59`](2026-05-29-design-parity-recovery-deferrals.md#d59) persistence). See § 1.3.

**Edge cases deferred to PR7's brainstorm pass — resolutions.**
- Closing a tab with an open composer: **allow.** Drafts auto-persist server-side per S4.
- Closing a tab with an in-flight submit: **block** while `useSubmitInFlight().inFlight && prRef === closing tab's prRef`. Tooltip: "Can't close — submit in progress." Wired via `useSubmitInFlight()` which tracks the single-slot SubmitLockRegistry.
- Stale `openTabs` entries on reload: **scope-narrowed but not fully N/A** — route (b) drops persistence which eliminates the reload-stale path; mid-session token rotation clears all tabs via `identity-changed`. PR-deleted / repo-archived / repo-visibility-changed mid-session paths remain — PR7 accepts the existing PrDetailPage error-fallback UX without a per-tab error chip. Stale-tab error chip visual spec **deferred** ([`D60`](2026-05-29-design-parity-recovery-deferrals.md#d60)).
- `openTabs.length > some-large-N`: **no cap**; the `+ N more` overflow menu past 6 inline tabs handles the visual. Narrow-viewport (1180px) verification is in the PR7 plan's manual smoke.
- Capture target deviation: **1-tab parity baseline** instead of the spec's 3-tab target — FakePrReader serves only one fixture and adding multi-fixture seeding is out of scope ([`D62`](2026-05-29-design-parity-recovery-deferrals.md#d62)).
- `overflowMenuOpen` is kept LOCAL to `PrTabStrip`, not exposed on `OpenTabsContext` ([`D61`](2026-05-29-design-parity-recovery-deferrals.md#d61)).
- Unread tab signals only deliver when a per-prRef subscription is active — this means the unread dot has narrow production coverage ([`D63`](2026-05-29-design-parity-recovery-deferrals.md#d63)).

Side-by-side capture target: `app-chrome-tabstrip` zone with three open PRs (two read, one unread).

### 4.8 PR8 — Ask AI drawer (behavior, working stub chat)

Second behavior PR. Replaces the existing `AskAiButton` → `AskAiEmptyState` inline-section flow with a right-side slide-in drawer that supports a working stub chat. Brainstorm pass completed 2026-05-30; resolutions captured below.

**Components.**
- `AskAiDrawer.tsx` + `AskAiDrawer.module.css` — the drawer surface.
- `AskAiDrawerProvider` (new context) — App-level state container. Exposes `useAskAiDrawer()` → `{ isOpen, toggle(), close(), getThread(prRefKey), sendMessage(prRefKey, body) }`.
- `lib/askAiUnavailableResponses.ts` — exports `AI_UNAVAILABLE_RESPONSES: readonly string[]` (5 entries) + `pickAiUnavailableResponse(cycleIndex)` helper. **Reused downstream**: any future AI-integration code path that needs an "AI is unavailable / not configured / unreachable" fallback imports the same constant. The strings are written to fit BOTH PR8's "AI hasn't been built yet" and v1.x+'s "AI exists but failed" states without rewording.

**Mount.** App-level fixed-position sibling of `<Routes>` in `App.tsx`, between `<PrTabStrip />` and `<Routes>`. NO `createPortal` (PRism has no portal infrastructure today; sibling pattern matches PR7's `<PrTabStrip />` placement). `position: fixed; right: 0; top: 0; bottom: 0` per handoff `.ai-drawer` (`screens.css:791-800`); z-index `50` per handoff. AskAiDrawerProvider wraps in App.tsx alongside `OpenTabsProvider` (siblings under `CheatsheetProvider`, outside `EventStreamProvider`).

**State (provider-held).** Provider holds `{ isOpen: boolean, cycleIndex: number, threads: Map<prRefKey, ChatThread> }` where `cycleIndex` is session-level (single counter incremented on every reply land) and `ChatThread = { messages: ChatMessage[], input: string, pendingAiReply: boolean }` and `ChatMessage = { role: 'user' | 'ai', body: string, ts: number }`. Threads are per-PR (`prRefKey` = `${owner}/${repo}/${number}` — slash-separated, matching `frontend/src/api/types.ts:82-84`'s `prRefKey()` helper output; NOT the `#`-separated format earlier draft used); selecting a different PR shows that PR's thread or an empty one. Threads persist across drawer close/reopen on the same PR AND across PR-to-PR navigation. Threads are wiped only by: hard page reload, `prism-identity-changed` event (matches `OpenTabsContext` pattern from PR7).

**Behavior.**
- **Trigger.** `AskAiButton` in `PrHeader` calls `useAskAiDrawer().toggle()` — click opens if closed, closes if open. Matches GitHub Copilot/Slack thread-button pattern.
- **Close.** X button or ESC key. Click-outside-to-close is **NOT** wired. There is NO backdrop element. The drawer coexists with the diff pane; PR Detail kbd shortcuts (`j`/`k`/`c`/`v`) remain functional when the textarea isn't focused.
- **Pathname-based auto-close.** Navigation away from a PR Detail route (`/pr/:owner/:repo/:number`) closes the drawer (`isOpen: false`). Thread state is preserved; navigation BACK to PR Detail does NOT auto-reopen — user must click `AskAiButton` again.
- **Composer.** Textarea + Send button. Plain Enter inserts a newline (multi-line composer). `Cmd/Ctrl+Enter` submits. Send button is `disabled` when input is empty-or-whitespace-only OR when `pendingAiReply === true`; `Cmd+Enter` is a no-op in the same conditions. Whitespace-only submits drop silently (no error chip). Input is hard-capped at 4000 chars (truncated at submit if exceeded — prevents diff-paste DoS on message-list rendering). Textarea grows up to ~4 rows then internal scrolls.
- **Submit flow.** On submit: append `{ role: 'user', body, ts: Date.now() }` to thread.messages, clear thread.input, set `thread.pendingAiReply = true`, schedule a `setTimeout(~600ms)` callback. The callback captures `prRefKey` AND a session-level `cycleIndex` snapshot at schedule time so it lands in the right thread even if user navigates to a different PR before the timer fires. On fire: append `{ role: 'ai', body: pickAiUnavailableResponse(snapshotCycleIndex), ts: Date.now() }` to thread.messages, increment the provider's session-level `cycleIndex`, set `thread.pendingAiReply = false`. The setTimeout is **not** cancelled on PR-to-PR nav — the user's mental model is "I sent it, I'll get a reply when I return."
- **Typing indicator.** While `pendingAiReply === true`, a three-dot typing indicator (`.ai-msg-typing` in `AskAiDrawer.module.css`) renders as the next message in the list to telegraph "thinking…".
- **Message rendering.** User and AI message bodies render as **plain text** (no Markdown). Avoids the `MarkdownRenderer` → `MermaidBlock` `dangerouslySetInnerHTML` seam. Markdown can be added in v1.x if real AI integration justifies it.
- **Empty state.** First open with no messages shows a single `--text-3` muted line in the drawer body: `Ask anything about this PR.` Plus a single keyboard hint chip at the bottom of the body area: `⌘ ⏎ to send`. No example-question chips.

**Canned response pool.** Five entries, cycle (not random), **session-level cycle index** (single counter on the provider increments on every reply land regardless of which PR; avoids the cross-PR "every first message gets response #1" repeat pattern that adversarial review flagged 2026-05-30):
1. "AI isn't available right now. When it is, it would summarize the diff per file and highlight risky areas."
2. "AI isn't available right now. When it is, it would surface tests that exercise the changed lines."
3. "AI isn't available right now. When it is, it would explain how a specific function got refactored."
4. "AI isn't available right now. When it is, it would compare the head SHA to the base and call out behavior changes."
5. "AI isn't available right now. When it is, it would flag drafts whose anchor lines moved in the latest iteration."

The "AI isn't available right now / when it is" phrasing avoids the false implication that AI EXISTS-but-is-DISCONNECTED that "AI is not connected" leaves room for. Honest in both PR8 today (no AI backend at all) and v1.x+ (AI exists but failed/disabled/unconfigured).

**Visuals (per handoff `.ai-drawer` — `screens.css:791-819`).**
- Right-side slide-in panel. Width `400px`. `transform: translateX(100%)` closed, `translateX(0)` open. Transition `transform 220ms var(--ease-out)`.
- `border-left: 1px solid var(--border-1)`, `box-shadow: var(--shadow-3)`, `background: var(--surface-1)`, `z-index: 50`.
- Header (`.ai-drawer-head` equivalent): sparkle icon + label + X close button. `padding: var(--s-3) var(--s-4)`, `border-bottom: 1px solid var(--border-1)`.
- Body (`.ai-drawer-body` equivalent): flex column, scrollable, `padding: var(--s-4)`, `gap: var(--s-3)`. User messages right-aligned (`background: var(--surface-2)`, `border-radius: var(--radius-3)`, `max-width: 85%`). AI messages left-aligned with sparkle icon.
- Composer (`.ai-drawer-input` equivalent): flex row, `padding: var(--s-3)`, `border-top: 1px solid var(--border-1)`. Textarea `min-height: 36px; resize: none`. Send button `btn btn-primary btn-sm`.
- **NO backdrop element.** Handoff has none; non-modal posture confirmed.

**Accessibility (true non-modal drawer).**
- `role="dialog"`, `aria-modal="false"` (or omitted — explicit false documents intent), `aria-labelledby` pointing at the header title.
- **NO focus trap.** Tab can move out of the drawer to the diff pane and back (handoff coexistence intent). Spec line 351's prior "focus trap inside the drawer while open" requirement is **rescinded** — it conflicted with the non-modal posture in spec line 336. PR9 a11y revisit adjudicates if N=3 cohort flags it.
- Initial focus on open: the composer textarea.
- ESC closes (don't break browser ESC defaults). **Modal-coexistence guard**: drawer's ESC handler skips when a `[aria-modal="true"]` element is open in the DOM (mirrors `Cheatsheet.tsx`'s capture-phase check at `useCheatsheetShortcut.ts:53`). Prevents single ESC keystroke from closing both an open Submit/Discard modal AND the drawer at once.
- Focus restoration on close: capture `document.activeElement` on `open()`, restore on `close()`. If the captured element is no longer in the DOM (e.g., navigated to a different PR and original AskAiButton unmounted), restoration silently fails to body — matches `Modal.tsx` behavior and is acceptable a11y posture.
- `aria-hidden={!isOpen}` **AND** `inert={!isOpen}` on the `<aside>` to hide from AT AND make the subtree non-focusable when closed. Per D81 amendment: the drawer is App-level-mounted and ALWAYS in the DOM (transform-translateX(100%) hides it visually). Focusable elements inside an `aria-hidden=true` subtree violate WCAG 2.1 SC 4.1.2 (`aria-hidden-focus`). The `inert` HTML attribute (React 19 native prop) makes the entire subtree non-focusable + non-interactive + removed from accessibility tree — covers the failure mode without unmounting the component or losing the slide-in/out animation.

**Header label.** The drawer header reads `Ask about this PR · AI unavailable` with `--text-2` muted treatment for the second clause. The shorter "AI unavailable" framing is honest in both states (today: no AI backend; v1.x+: AI exists but failed/disabled/unconfigured) without the misleading "currently disconnected" implication that earlier draft "AI not connected" wording carried.

**Removal of existing surface.**
- The static `AskAiEmptyState` component (currently rendered inline below PrHeader as a `<section>`) is deleted in PR8. The `askAiOpen` local state in `PrHeader.tsx` and the inline render are removed; `AskAiButton`'s `onClick` is rewired to `useAskAiDrawer().toggle()`. Between PR2 and PR7, `AskAiButton` continues to open the existing `AskAiEmptyState` unchanged. The wiring flips in PR8 only.

**v1-trial gating.** Per § 1.3's AI-during-trial signal-pollution concern, PR8 ships **gated on `aiPreview === true`** via the existing `AskAiButton` guard (`AskAiButton.tsx:11` already returns `null` when `aiPreview === false`). With the default `aiPreview: false` for the N=3 cohort, the button is invisible and the drawer is unreachable. N=3 reviewers who enable `aiPreview` in Settings see the drawer. The trial-signal pollution risk is symmetric with status quo — the gate is unchanged; only the surface behind the gate flips from a static `<section>` to a working stub chat.

**Side-by-side capture target.** `ask-ai-drawer` zone with two user messages + one canned AI reply visible.

**Deferrals introduced (D71–D80, full bodies in `2026-05-29-design-parity-recovery-deferrals.md`).**
- D71 — true non-modal dialog: `aria-modal="false"` + no focus trap (spec line 351 rescinded).
- D72 — App-level fixed-position sibling mount; portal pattern deferred.
- D73 — Per-PR thread state preserved across PR-to-PR nav; pathname-based auto-close on PR Detail exit.
- D74 — `setTimeout(~600ms)` canned-reply mechanism: captures `prRefKey` + session cycleIndex snapshot, fires regardless of route, no cancel-on-nav. Session-level cycle index (not per-PR) — adversarial-pass amendment 2026-05-30.
- D75 — Hard 4000-char input cap; whitespace-only drops silently; up-to-4-row textarea growth. Cmd+Enter silent-drop while pending accepted (disabled Send button IS the affordance).
- D76 — `askAiUnavailableResponses` (colocated under `components/AskAiDrawer/`, NOT `lib/`) dual-purpose: PR8 mock today + v1.x+ unavailable-fallback. "AI isn't available right now" framing — explicitly NOT "AI is not connected" (adversarial-pass rewording 2026-05-30).
- D77 — Identity-change wipes all threads + closes drawer (matches `OpenTabsContext` pattern). aiPreview-toggle-off mid-cycle: setTimeouts continue and land in state silently; reopening drawer later in same session shows the landed reply (accepted quirk).
- D78 — `AskAiButton` toggle behavior (open ↔ close) replaces simple-open.
- D79 — `parsePrRefFromPathname` colocated under `components/AskAiDrawer/`, NOT extracted to `frontend/src/lib/`. Single-consumer scope.
- D80 — z-index ordering: drawer 50 = PrTabStrip overflow menu 50; drawer renders later in App.tsx → wins paint-order tie. Modal at 1000 always wins. Documented to anchor the stacking decision.
- D81 — `inert` attribute on the closed drawer `<aside>`. WCAG 2.1 SC 4.1.2 fix discovered during Task 13 a11y-audit. `aria-hidden={!isOpen}` alone leaves focusable children (Close button, textarea, Send button) in the focus tree when the drawer is closed.
- D82 — `PrTabStrip` nested-interactive a11y violation (PR7-vintage). Surfaced after D81 unmasked layered a11y audits. Deferred to PR9 a11y revisit per § 4.9.
- D83 — `parity-baselines.spec.ts` `inbox` test Loading-vs-populated race (pre-existing D64 weakness). Out of PR8 scope.

### 4.9 PR9 — Revisit pass (audit + documentation)

No new visual work. Audits the restored state against handoff decisions and current product context (post-S6, pre-v1). Each candidate gets a kept / deferred / rejected verdict with one-line rationale.

**Likely candidates:**
- **Density modes** (comfortable / compact). Handoff supports both via `[data-density="compact"]` on `<html>` and `tokens.css:216-222` already wires the compact overrides. The SPA never sets the attribute. Decide whether to wire a toggle in Settings now, defer to v1.1, or reject.
- **Accent rotation** (indigo / amber / teal). Already shipped via `AccentPicker.tsx` (S6 PR #71); confirm parity is correct.
- **AI focus dots in file tree, AI hunk annotations, AI summary card data.** The styling lands in PR3-PR4 with canned data. Decide whether to gate visibility more aggressively on `aiPreview` flag, or surface only when annotations exist.
- **Floating tweaks panel** (handoff's bottom-right panel). S6 explicitly replaced this with the Settings page. PR9 documents the rationale formally so future readers don't try to revert.
- **Stale-row AI suggestion body.** Handoff's `StaleDraftPanel` shows an AI suggestion inline. We don't have an AI for this. Gate on `aiPreview` flag or hide entirely.
- **Global search bar** (the passive "Jump to PR or file… ⌘K" input in the header). Currently disabled / placeholder; handoff shows it as a primary chrome element. Decide: wire to a minimal palette in v1.1, leave as disabled placeholder, or remove.
- **Submit surface drift.** If PR5 surfaces drift between existing submit-surface styling and the restored PR Detail visual language, adjudicate here.

Each decision lands in this spec's deferrals sidecar (`docs/specs/2026-05-29-design-parity-recovery-deferrals.md`) with verdict + rationale. No code changes unless a restored rule actively harms current UX (rare).

---

## 5. Per-slice validation

Every parity PR (PR2-PR8) must include all of:

1. **Side-by-side screenshot in PR description** per [.ai/docs/design-handoff.md](../../.ai/docs/design-handoff.md) (after the PR1 update). Format: handoff prototype on left, implementation on right, same viewport, same fixture data. Captured via `compound-engineering:ce-demo-reel`.
2. **Updated viewport baseline** committed in the same PR for the zone(s) restored. The diff visualization is part of the review surface.
3. **All existing tests pass.** Vitest, dotnet test, Playwright. Renaming `className="pr-header"` → `className={styles.prHeader}` breaks tests asserting on `.pr-header`. Affected tests update in the same PR.
4. **Pre-push checklist** per [`.ai/docs/development-process.md`](../../.ai/docs/development-process.md): `npm run lint`, `npm run build`, `npm test`, `dotnet build --configuration Release`, `dotnet test --no-build --configuration Release`, Playwright where applicable.

PR9 (revisit) has different validation — it's a documentation PR. Requirement is "decisions are visible and rationaled in the deferrals sidecar."

PR1 (foundation) requires (3) and (4) but not (1) or (2) — there's no visual delta yet.

---

## 6. Cross-cutting risks

Called out so the spec doesn't pretend they don't exist. Each surfaces in multiple slices; mitigation is per-slice unless noted.

### 6.1 CSS module rename breaks selectors in tests and helpers

`frontend/e2e/no-layout-shift-on-banner.spec.ts` queries `h1.pr-title` directly. Three further Playwright specs query `.pr-tab-count` directly (confirmed via grep 2026-05-29):

- `frontend/e2e/s4-multi-tab-consistency.spec.ts`
- `frontend/e2e/s4-drafts-survive-restart.spec.ts`
- `frontend/e2e/s5-marker-prefix-collision.spec.ts`

PR2 must rename these selectors when the `.pr-tab-count` class moves into `PrSubTabStrip.module.css`. Other Playwright specs and Vitest unit tests may have additional className queries; mitigation per slice: before opening the PR, `Grep` the test suite for the className strings being renamed in that slice and update them in the same PR. The `data-testid` queries (the preferred selector form across the codebase) are unaffected.

### 6.2 State attributes drive visual differences

The handoff uses `[data-density="compact"]`, `[data-on="1"]`, `[data-theme]`, `[data-accent]`. Some are wired (`[data-theme]`, `[data-accent]`), some aren't (`[data-density]`). **Policy**: port the rules referencing unset attributes as-is — dormant but structurally complete CSS — so the rules are ready when (e.g.) a density toggle wires up in PR9. Don't comment-out, don't drop. Each slice's deferrals sidecar records the dormant-attribute set so reviewers can audit which classes are intentionally inert.

### 6.3 PR2 visually repositions verdict picker + Submit

Today `.pr-actions` has no flex rules; buttons end up wherever default layout puts them. Once PR2 ports the handoff's `.prActions` flex layout, button positions shift relative to the PR title. Reviewer's side-by-side catches this; flag in the PR2 description as *expected repositioning*, not a regression.

### 6.4 AI-dependent surfaces ship with canned data

AI summary card, AI hunk annotations, AI focus dots in file tree, AI suggestion in stale-draft rows. The handoff designs them as integral surfaces; we don't generate the AI data in v1 (no AI backend per the v1 completion roadmap). Per slice, the styling lands; the data path stays canned (existing `useAiSummary` pattern). PR9 revisit decides whether any need stricter gating on `aiPreview`.

### 6.5 PR7 composer-open interactions

Closing a tab with an open inline composer, an unresolved foreign-pending-review modal, an in-flight submit. The handoff doesn't specify. Resolved in PR7 brainstorm; defaults are documented in § 4.7. Drafts are already server-persisted (S4 work), so visual close is safe for the autosave path.

### 6.6 PR4 split risk

PR4 has the most components (~13) and the most cross-component CSS (`DiffPane` references styling from `ExistingCommentWidget`, `AiHunkAnnotation`, `InlineCommentComposer`, etc.). Per-slice judgment call to split into PR4a + PR4b if the diff crosses ~600 LOC of CSS or ~8 review-meaningful changes. Decision is the implementer's.

### 6.7 Build output sanity

~1500 lines of CSS across ~30 new `.module.css` files. Vite emits a chunk per module. Per slice, verify `npm run build` output size and chunk count don't regress materially. Quick eyeball in each slice's pre-push.

### 6.8 Settings coherence subjectivity

Already accepted (route i — see § 2.2). Reviewer's side-by-side judgment is the gate. Higher review noise in PR6 is expected.

### 6.9 PR7 invalidates Inbox viewport baseline

PR7's Row 2 chrome (the PR tab strip) renders above the main app content area whenever `openTabs.length ≥ 1`. Inbox's Y-position therefore shifts even though no Inbox file changes. Consequence: the Inbox baseline captured during PR2 (or whichever PR first commits an Inbox baseline) no longer matches the post-PR7 rendered Inbox. **PR7 explicitly re-captures `inbox` and `inbox-activity-rail` baselines as part of its scope**, even though Inbox component files are untouched. This is the single carve-out from § 2.2's "no Inbox changes" rule.

---

## 7. Open questions deferred to per-PR brainstorm

These need PR-level brainstorming, not roadmap-level decisions.

- **PR7 `openTabs` persistence policy.** localStorage is the default. Edge cases: stale references (PR no longer accessible), large tab counts. PR7 brainstorm finalizes.
- **PR7 closing-tab edge cases.** Composer-open, modal-open, submit-in-flight. § 6.5 defaults are working assumptions; PR7 brainstorm validates.
- ~~**PR8 canned Ask AI responses.**~~ Resolved 2026-05-30: 5 entries, cycle, per-PR index, "AI is not connected. When connected, it would…" framing reused as v1.x+ unavailable fallback. See § 4.8 + D76.
- ~~**PR8 drawer mount strategy.**~~ Resolved 2026-05-30: App-level fixed-position sibling of `<Routes>`. No portal. See § 4.8 + D72.
- **PR4 split decision.** Per-slice judgment per § 6.6. Implementer decides at work time.
- **PR9 revisit verdicts.** Whole purpose of PR9 — adjudicated there, not pre-committed here.

---

## 8. Explicitly NOT in scope

Each item carries a one-line "why not now."

- **Anything outside `design/handoff/screens.css` + the (d) chrome additions.** Why not now: scope discipline. New surfaces require their own brainstorm.
- **Re-architecting Settings into a floating tweaks panel.** Why not now: S6 explicitly replaced it; reverting would re-litigate a closed decision.
- **Real AI integration (model calls).** Why not now: v1 completion roadmap (`docs/specs/2026-05-28-v1-completion-roadmap-design.md`) explicitly excludes AI work. PR8 Ask AI drawer is a styled surface with canned responses.
- **Inbox changes.** Why not now: Inbox is the control. Changes during this roadmap signal a regression.
- **Density mode toggle wiring** (`[data-density="compact"]`). Why not now: deferred to PR9 revisit decision. The CSS rules port across; toggle wiring is a separate question.
- **Global search palette implementation.** Why not now: the search bar in the header is a passive disabled input today; PR9 revisit decides whether to wire it, leave as placeholder, or remove.
- **Bundle / chunking optimization.** Why not now: § 6.7 confirms output sanity but doesn't optimize. Vite defaults are acceptable for the PoC.
- **Submit-surface re-styling.** Why not now: shipped in S5 (`tokens.css:493-637`). Drift against the restored PR Detail visual language is a PR9 revisit input, not a PR5 scope item.
- **Validation suite Phases 2-5.** Why not now: visual gap is the user-visible blocker for the N=3 cohort's first impression and motivates this roadmap; validation suite scenarios cover correctness regressions during dogfood, a v1.x maturation concern. The trade is explicit: this roadmap prioritizes visual coherence over expanded journey-correctness verification for the same engineering window. If trial signal contradicts the ranking, the validation suite gets priority in the next slice. Cross-link: [`docs/specs/2026-05-28-manual-validation-test-plan-design.md`](2026-05-28-manual-validation-test-plan-design.md) (Phase 1 of 5 shipped 2026-05-28 via PR #85).

---

## 9. Glossary

- **Handoff** — `design/handoff/PRism.html` + the JSX/CSS files alongside it. The high-fidelity prototype that defines the visual + interaction spec for v1.
- **Handoff-parity fixture** — synthetic PR data matching the handoff's PR `#1842` deeply-mocked content. Defined in § 4.1.1.
- **Restoration** — porting a handoff-defined visual surface into production code. Used throughout this spec.
- **Parity gap** — the absence of CSS rules in production for handoff class names that ship in JSX today. Diagnosed in § 1.
- **Side-by-side review** — the per-PR review pattern defined in § 4.1.4: handoff prototype on left, implementation on right, captured at the same viewport.
- **Viewport baseline** — the per-PR-locked screenshot at narrow zone scope, stored under `frontend/e2e/__screenshots__/{platform}/`. Catches future drift; not the parity gate itself.
- **(d) scope** — the broadest of the four scope options reviewed in brainstorming:
  - (a) PR Detail only — header, sub-tab strip, Overview, Files (tree + diff + iteration strip), Drafts, reconciliation panel, stale rows, composers.
  - (b) PR Detail + Setup — also restore Setup's centered-card-with-accent-radial-gradient layout.
  - (c) PR Detail + Setup + Settings coherence — also align Settings (no handoff reference) to the restored PR Detail visual style.
  - (d) (chosen) — (c) plus the missing chrome behaviors (browser-style PR tab strip + Ask AI drawer).
  Chosen during brainstorm 2026-05-29 on the rationale that the post-v1 polish window is the right time to land all parity scope at once rather than slicing across multiple polish windows. § 1.3 documents the v1-ship timing tradeoff this choice creates.
- **Lift-on-second-use** — the rule for promoting a class from a module to `tokens.css` the second time another module needs it (§ 3.1).
