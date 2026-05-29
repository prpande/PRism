# PR3 — design-parity-recovery: Overview tab card grid

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the 7 OverviewTab components + `PrRootReplyComposer`'s composer-action-row into visual parity with `design/handoff/screens.css`. The Overview tab card grid renders by default on every PR Detail navigation (`App.tsx:72`), so PR3's restoration is the most user-visible delta of the design-parity-recovery roadmap.

**Architecture:** Port the relevant rules from `design/handoff/screens.css` (~28 rules across the `.ai-summary-*` / `.ai-risk` block at L82-102, the `.overview-*` / `.ov-*` block at L250-341, the `.pr-conv-*` block at L347-451, and `.composer-actions` at L776) into per-component CSS modules colocated with each `.tsx`. Composes with existing global primitives from `tokens.css` (`.btn`, `.btn-primary`, `.muted`, `.tnum`, `.ai-tint`, `.kbd`). Production JSX class names diverge from handoff naming in four components (`StatsTiles`, `PrRootConversation`, `AiSummaryCard`, `PrDescription`); per-component module CSS uses the production class names as the source of truth and ports the handoff *visual treatment*, rather than literal selector renaming (see D12). Vitest unit-test queries migrate from `.querySelector('.x')` to `getByTestId(...)` or to a module-imported `styles.x` assertion (see D16).

**Tech Stack:** React 19 + Vite + TypeScript + CSS Modules + Vitest + Playwright (parity baselines).

---

## Deviations from spec §4.3 (working assumptions — entered as D12-D17 in deferrals at Task 12)

These are PR3-discovered gaps. Each is a deliberate choice surfaced during plan-writing pre-flight; full rationale lands in the deferrals sidecar at Task 12. If Task 1 pre-flight surfaces a contradicting signal, the implementer stops and reports.

| # | Topic | Working assumption | Why it's a deviation |
|---|-------|---------------------|----------------------|
| **D12** | Production-vs-handoff naming divergence | Author module CSS under PRODUCTION class names; port handoff *visual treatments* into them. Do NOT rename JSX to match handoff selectors. | Spec §3.1 ("kebab-case from handoff → camelCase in module") assumes 1:1 selector mapping. Four components have divergent production names (`stats-tile` vs `ov-stat`, `pr-root-comment` vs `pr-conv-item`, `ai-summary-card` vs `pr-ai-summary`, `pr-description` has no handoff equivalent). Renaming JSX is a logic-shaped change (§2.2 says no logic changes) and breaks test selectors needlessly. |
| **D13** | `PrRootConversation` vertical timeline rail/line | CSS-only treatment via `::before` / `::after` pseudo-elements on `.prRootComment`. Do NOT restructure JSX into the handoff's `<ul>/<li>` + rail `<div>` shape. | Handoff structure is grid `28px 1fr` with a dedicated `.pr-conv-rail` child carrying the avatar + `.pr-conv-line`. Production renders `<article>` per comment with no rail child. Restructuring JSX is out of scope per §2.2; pseudo-elements achieve the same visual without touching component logic. |
| **D14** | `overview-card-hero-no-ai` modifier port | Author `.overviewCardHeroNoAi` in `PrDescription.module.css` as the hero treatment (`border-radius: var(--radius-4); padding: var(--s-5) var(--s-5)`) that activates when `aiPreview=false` and `PrDescription` takes the hero slot left empty by absent `AiSummaryCard`. The visual contrast is conditional: AI-ON path has `AiSummaryCard` as hero + `PrDescription` as a regular card; AI-OFF path has `PrDescription` as hero (no `AiSummaryCard`). | Spec §3.1 + S3 deferral B26 keep the modifier per "handoff is authoritative" — but the handoff `screens.css` has no exact `.overview-card-hero-no-ai` rule. Production wired the conditional class without a CSS rule. PR3 closes the gap. The modifier produces a real visual difference only because the AI-OFF path's `PrDescription` rendering is what occupies the hero slot. |
| **D15** | `PrRootReplyComposer` composer-class scope | Port the handoff's `.composer-actions` rule (L776: `display: flex; justify-content: space-between; margin-top: 8px;`) plus a `gap: var(--s-2)` + `align-items: center` extension for the multi-button row with badge into `PrRootReplyComposer.module.css`. Defer all other composer classes (`composer-textarea`, `composer-preview-toggle`, `composer-badge`, `composer-discard`, `composer-save`, `composer-closed-banner`) to **PR4** which owns all 3 composers (`InlineCommentComposer`, `ReplyComposer`, `PrRootReplyComposer`) and is the natural place to lift composer primitives into `tokens.css` per §3.1's lift-on-second-use rule. Per **D21**, PR3's parity baseline captures the composer-CLOSED state (Reply button visible). | Spec §4.3 names `PrRootReplyComposer` "the only composer surface visible on Overview" — implying full styling. But 6 of the 7 composer classes used in production JSX (textarea, preview-toggle, badge, discard, save, closed-banner) are NEW production conventions with no handoff source; styling them in PR3 forces a design call PR4 will revisit. Limiting PR3 to `.composer-actions` is honest about what the handoff actually provides. The minimal `gap` + `align-items` extension is required for the production JSX's badge sibling to render correctly between the toggle and the discard/save buttons. |
| **D16** | Test-selector migration via `data-testid` + literal-class retention | Add `data-testid` attributes to the 5 affected components (5 attributes total). Migrate 5 vitest unit-test files (`OverviewTab`, `PrDescription`, `StatsTiles`, `PrRootConversation`, `AiSummaryCard`) to use `getByTestId(...)` / `queryAllByTestId(...)` for element SELECTION. For class-PRESENCE assertions on `overview-card`, `overview-card-hero`, `overview-card-hero-no-ai` (3 classes), keep the literal strings in JSX — these classes have global rules in `tokens.css` after D22's lift, so the literal serves both as test seam AND as the styling hook. | Matches PR2's D10 resolution. Pure JSX className-→module-class rewrites would otherwise hash the classes and break every `querySelector('.x')` query. Literal-class retention is the right shape when the class is also a global styling hook lifted to `tokens.css` (D22); using the literal as the test seam + styling hook is one mechanism, not two. |
| **D17** | Dormant handoff AI-summary rules ported AS-IS | Port handoff `.ai-summary-head` / `.ai-summary-label` / `.ai-summary-bullets` + `li` / `.ai-risk` into `AiSummaryCard.module.css` as 5 camelCase rules (`.aiSummaryHead`, `.aiSummaryLabel`, `.aiSummaryBullets`, `.aiSummaryBullets li`, `.aiRisk`) even though current production JSX renders only `.ai-summary-chip`, `.ai-summary-body`, `.ai-summary-category`. | Spec §6.2 dormant-attribute policy literally addresses unset attributes; PR2 D9 narrowed it AWAY from dormant classes for the four PrHeader stub classes. PR3 D17 explicitly overrides D9 for these 5 because (a) they form a coherent richer surface (the handoff's AI summary head + label + bullets + risk chip is a designed multi-element layout, not four isolated stub names like PR2's `pr-meta`, `pr-meta-repo`, etc.), (b) the handoff's intent is the AI summary's near-term richer surface (PR9 revisit candidate), and (c) the rules are scoped to `AiSummaryCard.module.css` only — dormant locally, not globally. Reviewer concern that this is YAGNI is acknowledged; the trade is "5 dormant rules now" vs "second CSS pass on the same component for the same handoff source." |
| **D18** | New production-only rules for `overview-cta-empty` / `overview-cta-footer` | Author `.overviewCtaEmpty` + `.overviewCtaFooter` in `ReviewFilesCta.module.css` as new module CSS rules (small font-size + margin adjustments + flex layout for the keyboard-hint footer). Not bare globals. | Production JSX has these two child classes with no handoff source. Originally folded inline at Task 5; calling out here per scope-guardian feedback so PR9 revisit can adjudicate whether the rules align with the restored visual language. |
| **D19** | `is-you` author-distinguishing treatment dropped | The handoff's `.pr-conv-item.is-you .pr-conv-body { background: var(--accent-soft); border-color: ... }` rule that highlights "this comment is yours" with an accent-tinted bubble is NOT ported in PR3. Production `IssueCommentDto` has no `isCurrentUser` field and `PrRootConversation` JSX has no `data-current-user` attribute. | Wiring requires adding a `currentUserLogin` prop to `PrRootConversation` (sourced from useAuth) + a per-comment `comment.author === currentUserLogin` comparison + a conditional `data-author-is-self` attribute + the CSS rule. That's a logic-shaped change spec §2.2 says is out of scope. Defer to PR9 revisit alongside the other "who-said-what" affordance decisions. |
| **D20** | Handoff `overview-card-head` (top-of-card header with Conversation label + Mark-all-read) NOT reproduced | The handoff renders an `overview-card-head` element at the TOP of the conversation card containing a "Conversation" heading + the Mark-all-read button. Production renders the Mark-all-read button at the BOTTOM in `pr-root-conversation-actions-row` alongside the Reply button. PR3 ports the production structure as-is. | Restoring the top-of-card header requires moving `MarkAllReadButton` from `PrRootConversationActions` to a new sibling header element above the comment list — a JSX structural change per §2.2. The current bottom-placement preserves keyboard-flow ergonomics (Reply + Mark-all-read appear together at the natural footer position). Defer to PR9 revisit. |
| **D21** | PR3 parity baseline captures composer-CLOSED state only | Task 13.2's `pr-detail-overview.png` baseline is captured with the Reply composer in its closed state (the Reply button + MarkAllReadButton visible; the composer textarea + action buttons NOT mounted). The open-composer state is NOT covered by PR3's regression gate. | The open-composer state's 6 unported composer classes (per D15) render with default browser styling. Capturing the open-composer baseline would lock in a visually-broken state. The closed-composer baseline IS what the typical first-impression user sees (the composer opens only after Reply click). PR4 — which lifts the composer primitives — captures the open-composer baseline as part of its slice. |
| **D22** | Lift `.overview-card` + `.overview-card-hero` to `tokens.css` upfront (not deferred to Task 13.3) | At Task 6 (PrDescription module CSS), add `.overview-card` (background + border + border-radius + padding) and `.overview-card-hero` (extends with larger radius + padding) as global rules in `tokens.css`. Both classes have ≥2 immediate consumers in PR3 (PrDescription + AiSummaryCard + PrRootConversation), qualifying for spec §3.1's lift-on-second-use rule. | Originally deferred to Task 13.3 as "side-by-side review-time decision." Feasibility review surfaced this is structurally unsound — Task 13.2 captures the baseline BEFORE Task 13.3's review, so the baseline locks in a visually-unstyled state (AiSummaryCard renders without card surface; PrRootConversation card has no border/background). Pre-committing the lift at Task 6 (the first consumer) avoids that. |

---

## File structure

**New module CSS files (8):**

- Create: `frontend/src/components/PrDetail/OverviewTab/OverviewTab.module.css`
- Create: `frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.module.css`
- Create: `frontend/src/components/PrDetail/OverviewTab/PrDescription.module.css`
- Create: `frontend/src/components/PrDetail/OverviewTab/StatsTiles.module.css`
- Create: `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.module.css`
- Create: `frontend/src/components/PrDetail/OverviewTab/MarkAllReadButton.module.css`
- Create: `frontend/src/components/PrDetail/OverviewTab/ReviewFilesCta.module.css`
- Create: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.module.css`

**Modified JSX files (8):**

- Modify: `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx`
- Modify: `frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.tsx`
- Modify: `frontend/src/components/PrDetail/OverviewTab/PrDescription.tsx`
- Modify: `frontend/src/components/PrDetail/OverviewTab/StatsTiles.tsx`
- Modify: `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx`
- Modify: `frontend/src/components/PrDetail/OverviewTab/MarkAllReadButton.tsx`
- Modify: `frontend/src/components/PrDetail/OverviewTab/ReviewFilesCta.tsx`
- Modify: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx`

**Modified test files (5):**

- Modify: `frontend/__tests__/OverviewTab.test.tsx`
- Modify: `frontend/__tests__/PrDescription.test.tsx`
- Modify: `frontend/__tests__/StatsTiles.test.tsx`
- Modify: `frontend/__tests__/PrRootConversation.test.tsx`
- Modify: `frontend/__tests__/AiSummaryCard.test.tsx`

**Modified shared CSS (D22 lift):**

- Modify: `frontend/src/styles/tokens.css` (append `.overview-card` + `.overview-card-hero` global rules at Task 6 Step 6.1)

**Playwright spec un-fixme + baseline capture:**

- Modify: `frontend/e2e/parity-baselines.spec.ts` (remove `.fixme` on `pr-detail-overview`)
- Create: `frontend/e2e/__screenshots__/win32/pr-detail-overview.png` (first capture)

**Deferrals sidecar (append D12-D17):**

- Modify: `docs/specs/2026-05-29-design-parity-recovery-deferrals.md`

---

## Task 1: Pre-flight survey — confirm scope and surface any missing consumers

**Files:**
- Read-only scans across `frontend/src/` and `frontend/__tests__/` and `frontend/e2e/`.

- [ ] **Step 1.1: Verify the 9 production class strings PR3 will rewrite are limited to the 8 component files this plan lists**

Run from worktree root:

```bash
grep -rn --include="*.tsx" --include="*.ts" \
  -e "overview-tab" -e "overview-grid" -e "overview-card" -e "overview-cta" \
  -e "ai-summary-card" -e "ai-summary-chip" -e "ai-summary-body" -e "ai-summary-category" \
  -e "pr-description" \
  -e "stats-tiles" -e "stats-tile" \
  -e "pr-root-conversation" -e "pr-root-comment" -e "pr-root-reply-button" \
  -e "mark-all-read-button" \
  -e "overview-cta-empty" -e "overview-cta-footer" \
  -e "pr-root-reply-composer" \
  frontend/src/
```

Expected output: 8 files in PR3 scope (the 8 production JSX files this plan lists in the file structure section above) **plus one expected-out-of-scope match**:

- `frontend/src/components/Ai/AiComposerAssistant.tsx` — uses bare literal `ai-summary-chip` on line 25. AiComposerAssistant is a separate AI placeholder component gated behind `composerAssist && aiPreview` (both default-false), mounted inside all 3 composers via `<AiComposerAssistant />`. It renders `null` in the PoC default config. The `ai-summary-chip` literal here has **no rule today** in `tokens.css` or any module; Task 7 wires `styles.aiSummaryChip` only in `AiSummaryCard.tsx`. AiComposerAssistant continues to render the bare literal post-PR3 (it has no rule before or after) — no regression. Future composer-AI consolidation (PR4 or beyond) is the natural home for adjudicating the shared `ai-summary-chip` token.

If the grep returns a 10th file (a sibling test-helper or a stray import in `pages/`), **stop and report** the additional consumer. The plan amendment pattern (`feedback_document_plan_deviations.md`) applies: extend Task 5/7/8/10 to cover the extra file, or escalate if it indicates scope drift.

- [ ] **Step 1.2: Confirm Vitest test files querying PR3 classnames**

```bash
grep -rln --include="*.test.tsx" --include="*.test.ts" \
  -e "\.overview-card" -e "\.overview-grid" -e "\.overview-cta" \
  -e "\.ai-summary" -e "\.pr-description" -e "\.pr-root-comment" -e "\.pr-root-conversation" \
  -e "\.stats-tile" -e "\.mark-all-read" -e "overview-card-hero" \
  frontend/__tests__/ frontend/src/
```

Expected output: the 5 files this plan lists (`OverviewTab.test.tsx`, `PrDescription.test.tsx`, `StatsTiles.test.tsx`, `PrRootConversation.test.tsx`, `AiSummaryCard.test.tsx`).

If a 6th unit test surfaces, **stop and report**. Apply the same plan amendment pattern — extend Task 4 to migrate the extra file's selectors.

- [ ] **Step 1.3: Confirm Playwright specs DO NOT use PR3 classnames as selectors**

```bash
grep -rln --include="*.spec.ts" \
  -e "\.overview-card" -e "\.overview-grid" -e "\.overview-cta" \
  -e "\.ai-summary" -e "\.pr-description" -e "\.pr-root-comment" -e "\.pr-root-conversation" \
  -e "\.stats-tile" -e "\.mark-all-read" -e "overview-card-hero" \
  frontend/e2e/
```

Expected output: empty (no matches). Playwright uses `data-testid` + role/text selectors.

If matches surface, **stop and report**.

- [ ] **Step 1.4: Commit pre-flight notes (or proceed if nothing changed)**

No code changes from Task 1. If steps 1.1-1.3 all match expectations, proceed to Task 2 with no commit. If a discrepancy was reported and the plan was amended in conversation, commit the plan amendment before proceeding:

```bash
git add docs/plans/2026-05-30-design-parity-recovery-pr3-overview-tab.md
git commit -m "docs(pr3): amend plan after Task 1 pre-flight surfaced <discrepancy>"
```

---

## Task 2: Add `data-testid` attributes to PR3 components

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx:86`
- Modify: `frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.tsx:11`
- Modify: `frontend/src/components/PrDetail/OverviewTab/PrDescription.tsx:16`
- Modify: `frontend/src/components/PrDetail/OverviewTab/StatsTiles.tsx:15,26`
- Modify: `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx:32`

Five attributes added in production JSX. These are the selectors for the parity-baselines `pr-detail-overview` zone (Step 11) plus the Vitest selector migration (Task 4).

- [ ] **Step 2.1: Add `data-testid="overview-tab"` to OverviewTab root**

In `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx`, change line 86 from:

```tsx
    <div className="overview-tab overview-grid">
```

to:

```tsx
    <div className="overview-tab overview-grid" data-testid="overview-tab">
```

- [ ] **Step 2.2: Add `data-testid="ai-summary-card"` to AiSummaryCard root**

In `frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.tsx`, change line 11 from:

```tsx
    <section className="ai-summary-card overview-card overview-card-hero ai-tint">
```

to:

```tsx
    <section
      className="ai-summary-card overview-card overview-card-hero ai-tint"
      data-testid="ai-summary-card"
    >
```

- [ ] **Step 2.3: Add `data-testid="pr-description"` to PrDescription root**

In `frontend/src/components/PrDetail/OverviewTab/PrDescription.tsx`, change line 16 from:

```tsx
    <section className={cardClass}>
```

to:

```tsx
    <section className={cardClass} data-testid="pr-description">
```

- [ ] **Step 2.4: Add `data-testid="stats-tile"` to each tile in StatsTiles**

In `frontend/src/components/PrDetail/OverviewTab/StatsTiles.tsx`, change lines 25-30 from:

```tsx
function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stats-tile">
      <dt className="stats-tile-label">{label}</dt>
      <dd className="stats-tile-value">{value}</dd>
    </div>
  );
}
```

to:

```tsx
function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stats-tile" data-testid="stats-tile">
      <dt className="stats-tile-label">{label}</dt>
      <dd className="stats-tile-value">{value}</dd>
    </div>
  );
}
```

- [ ] **Step 2.5: Add `data-testid="pr-root-comment"` to each PrRootConversation comment**

In `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx`, change line 32 from:

```tsx
        <article key={comment.id} className="pr-root-comment">
```

to:

```tsx
        <article key={comment.id} className="pr-root-comment" data-testid="pr-root-comment">
```

- [ ] **Step 2.6: Run prettier on the 5 touched files (avoids CI prettier mismatch)**

Per `feedback_prettier_check_in_ci.md` — local `npm run lint` can miss line-length drift that CI's `prettier --check` flags.

```bash
cd frontend
npx prettier --write \
  src/components/PrDetail/OverviewTab/OverviewTab.tsx \
  src/components/PrDetail/OverviewTab/AiSummaryCard.tsx \
  src/components/PrDetail/OverviewTab/PrDescription.tsx \
  src/components/PrDetail/OverviewTab/StatsTiles.tsx \
  src/components/PrDetail/OverviewTab/PrRootConversation.tsx
```

Expected: prettier writes 0-5 files (no errors).

- [ ] **Step 2.7: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx \
        frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.tsx \
        frontend/src/components/PrDetail/OverviewTab/PrDescription.tsx \
        frontend/src/components/PrDetail/OverviewTab/StatsTiles.tsx \
        frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx
git commit -m "feat(pr3): add data-testid hooks to 5 Overview components"
```

---

## Task 3: Migrate Vitest selectors from class queries to `data-testid`

**Files:**
- Modify: `frontend/__tests__/OverviewTab.test.tsx:222-223,409,432-433`
- Modify: `frontend/__tests__/PrDescription.test.tsx:23,31,38`
- Modify: `frontend/__tests__/StatsTiles.test.tsx:7`
- Modify: `frontend/__tests__/PrRootConversation.test.tsx:55,85,91`
- Modify: `frontend/__tests__/AiSummaryCard.test.tsx:30`

The plain class queries break once CSS modules hash the class names. Migrate selection (not class-presence assertions) to `getByTestId(...)`.

- [ ] **Step 3.1: Write the test queries' first new form, then run the existing suite to confirm baseline**

Before edits, run:

```bash
cd frontend && npm test -- --run OverviewTab PrDescription StatsTiles PrRootConversation AiSummaryCard
```

Expected: all tests pass (current state — classes still bare strings).

- [ ] **Step 3.2: Migrate `OverviewTab.test.tsx` (4 query sites)**

In `frontend/__tests__/OverviewTab.test.tsx`, change line 223 from:

```tsx
expect(container.querySelector('.pr-description')).toHaveClass('overview-card-hero-no-ai');
```

to:

```tsx
expect(within(container).getByTestId('pr-description')).toHaveClass('overview-card-hero-no-ai');
```

Change line 409 from:

```tsx
expect(container.querySelector('.ai-summary-card')).toBeNull();
```

to:

```tsx
expect(within(container).queryByTestId('ai-summary-card')).toBeNull();
```

Change lines 432-433 from:

```tsx
expect(container.querySelector('.pr-description')).not.toHaveClass('overview-card-hero-no-ai');
expect(container.querySelector('.ai-summary-card')).toHaveClass('overview-card-hero');
```

to:

```tsx
expect(within(container).getByTestId('pr-description')).not.toHaveClass('overview-card-hero-no-ai');
expect(within(container).getByTestId('ai-summary-card')).toHaveClass('overview-card-hero');
```

Confirm `within` is imported at the top of the file. If not, add it to the existing `@testing-library/react` import line.

Note on `toHaveClass(...)`: these assertions still use the LITERAL class name as a string (not a hashed module class). That's correct — `overview-card-hero` and `overview-card-hero-no-ai` remain on the JSX as bare class strings AFTER Task 6 (PrDescription) and Task 7 (AiSummaryCard) port their module CSS. The bare class strings stay because `OverviewTab.test.tsx` exercises behavior visible to consumers (the AI-off vs AI-on hero treatment). See D14 / D16.

- [ ] **Step 3.3: Migrate `PrDescription.test.tsx` (3 query sites)**

In `frontend/__tests__/PrDescription.test.tsx`, change line 23 from:

```tsx
const card = container.querySelector('.pr-description');
```

to:

```tsx
const card = within(container).getByTestId('pr-description');
```

Change line 31 from:

```tsx
expect(titleEl.closest('.pr-description-title')).toBeTruthy();
```

to:

```tsx
expect(titleEl.closest(`.${styles.prDescriptionTitle}`)).toBeTruthy();
```

Then at the top of the test file, add the CSS module import:

```tsx
import styles from '../src/components/PrDetail/OverviewTab/PrDescription.module.css';
```

(Importing the module gives the test the same hashed class name Vite generated for the component. Substring/attribute-pattern matching is brittle if a sibling class adopts a similar name; the module-import is the canonical pattern.)

Change line 38 from:

```tsx
const card = container.querySelector('.pr-description');
```

to:

```tsx
const card = within(container).getByTestId('pr-description');
```

Confirm `within` is imported at the top.

- [ ] **Step 3.4: Migrate `StatsTiles.test.tsx` (1 query site)**

In `frontend/__tests__/StatsTiles.test.tsx`, change line 7 from:

```tsx
return heading.closest('.stats-tile') as HTMLElement;
```

to:

```tsx
return heading.closest('[data-testid="stats-tile"]') as HTMLElement;
```

- [ ] **Step 3.5: Migrate `PrRootConversation.test.tsx` (3 query sites)**

In `frontend/__tests__/PrRootConversation.test.tsx`, change lines 55, 85, 91 — replace all 3 occurrences of `container.querySelectorAll('.pr-root-comment')` with:

```tsx
within(container).queryAllByTestId('pr-root-comment')
```

Confirm `within` is imported at the top. Note: `queryAllByTestId` returns `[]` for zero matches (no throw), matching `querySelectorAll`'s semantics — required for the line 55 case that asserts `toHaveLength(0)`.

- [ ] **Step 3.6: Migrate `AiSummaryCard.test.tsx` (1 query site)**

In `frontend/__tests__/AiSummaryCard.test.tsx`, change line 30 from:

```tsx
const card = container.querySelector('.ai-summary-card');
```

to:

```tsx
const card = within(container).getByTestId('ai-summary-card');
```

Confirm `within` is imported.

- [ ] **Step 3.7: Run the 5 migrated tests to confirm they still pass**

```bash
cd frontend && npm test -- --run OverviewTab PrDescription StatsTiles PrRootConversation AiSummaryCard
```

Expected: all 5 test files pass. If `getByTestId`-based queries fail with `Unable to find an element by: [data-testid="..."]`, the JSX hook from Task 2 didn't land — revisit Task 2.

- [ ] **Step 3.8: Run prettier on the 5 test files**

```bash
cd frontend
npx prettier --write \
  __tests__/OverviewTab.test.tsx \
  __tests__/PrDescription.test.tsx \
  __tests__/StatsTiles.test.tsx \
  __tests__/PrRootConversation.test.tsx \
  __tests__/AiSummaryCard.test.tsx
```

- [ ] **Step 3.9: Commit**

```bash
git add frontend/__tests__/OverviewTab.test.tsx \
        frontend/__tests__/PrDescription.test.tsx \
        frontend/__tests__/StatsTiles.test.tsx \
        frontend/__tests__/PrRootConversation.test.tsx \
        frontend/__tests__/AiSummaryCard.test.tsx
git commit -m "test(pr3): migrate Overview unit tests to data-testid selectors"
```

---

## Task 4: Port `OverviewTab` module CSS — outer grid container

**Files:**
- Create: `frontend/src/components/PrDetail/OverviewTab/OverviewTab.module.css`
- Modify: `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx`

Port the outermost `.overview-tab` + `.overview-grid` rules (handoff `screens.css:250-256`).

- [ ] **Step 4.1: Write the module CSS file**

Create `frontend/src/components/PrDetail/OverviewTab/OverviewTab.module.css` with:

```css
.overviewTab {
  flex: 1;
  overflow: auto;
  background: var(--surface-0);
}

.overviewGrid {
  max-width: 920px;
  margin: 0 auto;
  padding: var(--s-6);
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
}
```

- [ ] **Step 4.2: Wire the module into OverviewTab.tsx**

In `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx`, add the import near the top (alongside the existing component imports):

```tsx
import styles from './OverviewTab.module.css';
```

Then change the outermost `<div>` (currently line 86 after Task 2):

```tsx
<div className="overview-tab overview-grid" data-testid="overview-tab">
```

to:

```tsx
<div className={`${styles.overviewTab} ${styles.overviewGrid}`} data-testid="overview-tab">
```

- [ ] **Step 4.3: Run the OverviewTab unit tests to confirm no regression**

```bash
cd frontend && npm test -- --run OverviewTab
```

Expected: PASS (the `getByTestId('overview-tab')` selector is unaffected by the className change).

- [ ] **Step 4.4: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/OverviewTab.module.css \
        frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx
git commit -m "feat(pr3): port OverviewTab outer grid CSS to module"
```

---

## Task 5: Port `ReviewFilesCta` module CSS

**Files:**
- Create: `frontend/src/components/PrDetail/OverviewTab/ReviewFilesCta.module.css`
- Modify: `frontend/src/components/PrDetail/OverviewTab/ReviewFilesCta.tsx`

Port `.overview-cta` + production-only `.overview-cta-empty` + `.overview-cta-footer` rules. Handoff `screens.css:335-341` provides the parent layout; the two production-specific muted-text variants are new production conventions with no handoff equivalent (kept as bare globals composing with `.muted`).

- [ ] **Step 5.1: Write the module CSS file**

Create `frontend/src/components/PrDetail/OverviewTab/ReviewFilesCta.module.css` with:

```css
.overviewCta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--s-3) var(--s-2);
  margin-top: var(--s-2);
}

.overviewCtaEmpty {
  font-size: var(--text-xs);
  margin: 0 var(--s-3) 0 0;
}

.overviewCtaFooter {
  font-size: var(--text-xs);
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
```

Note on the two production-only rules: `.overviewCtaEmpty` lives BETWEEN the button and the footer; `.overviewCtaFooter` carries the keyboard hints. Per the JSX, `.overview-cta` (parent) uses `justify-content: space-between` — without the layout breaking when the empty-help paragraph is also a flex child, we give the empty-help its own font size and the footer its own gap so the keyboard hints (`<kbd>` children) align horizontally inside the footer paragraph.

- [ ] **Step 5.2: Wire the module into ReviewFilesCta.tsx**

In `frontend/src/components/PrDetail/OverviewTab/ReviewFilesCta.tsx`, add the import:

```tsx
import styles from './ReviewFilesCta.module.css';
```

Then change the 3 className strings as follows.

Line 10 — from:

```tsx
<div className="overview-cta">
```

to:

```tsx
<div className={styles.overviewCta}>
```

Line 21 — from:

```tsx
<p id={EMPTY_HELP_ID} className="overview-cta-empty muted">
```

to:

```tsx
<p id={EMPTY_HELP_ID} className={`${styles.overviewCtaEmpty} muted`}>
```

Line 25 — from:

```tsx
<p className="overview-cta-footer muted">
```

to:

```tsx
<p className={`${styles.overviewCtaFooter} muted`}>
```

- [ ] **Step 5.3: Add unit test confirming the CTA still wires the button and renders the keyboard hints**

If `frontend/__tests__/ReviewFilesCta.test.tsx` does not exist, skip this step (the integration coverage from `OverviewTab.test.tsx` is sufficient for the CSS-port slice). If it exists, run it to confirm no regression:

```bash
cd frontend && npm test -- --run ReviewFilesCta
```

Expected: PASS or "no tests found" (acceptable).

- [ ] **Step 5.4: Run OverviewTab integration test (consumer)**

```bash
cd frontend && npm test -- --run OverviewTab
```

Expected: PASS.

- [ ] **Step 5.5: Run prettier and commit**

```bash
cd frontend
npx prettier --write \
  src/components/PrDetail/OverviewTab/ReviewFilesCta.tsx
cd ..
git add frontend/src/components/PrDetail/OverviewTab/ReviewFilesCta.module.css \
        frontend/src/components/PrDetail/OverviewTab/ReviewFilesCta.tsx
git commit -m "feat(pr3): port ReviewFilesCta CSS to module"
```

---

## Task 6: Lift `.overview-card` + `.overview-card-hero` to `tokens.css` (D22); port `PrDescription` module CSS

**Files:**
- Modify: `frontend/src/styles/tokens.css` (append `.overview-card` + `.overview-card-hero` global rules)
- Create: `frontend/src/components/PrDetail/OverviewTab/PrDescription.module.css`
- Modify: `frontend/src/components/PrDetail/OverviewTab/PrDescription.tsx`

Per D22: lift `.overview-card` (handoff L257-262) + `.overview-card-hero` (L263-266) to `tokens.css` as global rules at Task 6 — the first consumer. These classes have ≥2 immediate consumers in PR3 (PrDescription + AiSummaryCard + PrRootConversation), qualifying for spec §3.1's lift-on-second-use rule.

`PrDescription.module.css` then authors only the description-specific layout (`.prDescriptionTitle`, `.prDescriptionBody`, `.prDescriptionEmpty`) and the AI-OFF hero modifier `.overviewCardHeroNoAi` (D14).

- [ ] **Step 6.1: Lift `.overview-card` + `.overview-card-hero` to `tokens.css`**

Open `frontend/src/styles/tokens.css` and append below the existing `.ai-tint` block (around line 493, before the S5 submit-surface rules):

```css
.overview-card {
  background: var(--surface-1);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-3);
  padding: var(--s-4) var(--s-5);
}

.overview-card-hero {
  border-radius: var(--radius-4);
  padding: var(--s-5) var(--s-5);
}
```

The hero class extends the base card with larger radius + padding — matches the handoff. Consumers in PR3: `PrDescription` (Task 6.2), `AiSummaryCard` (Task 7), `PrRootConversation` (Task 10). All three use bare literal class strings `overview-card` / `overview-card-hero` that fire these global rules.

- [ ] **Step 6.2: Write the PrDescription module CSS file**

Create `frontend/src/components/PrDetail/OverviewTab/PrDescription.module.css` with:

```css
.overviewCardHeroNoAi {
  border-radius: var(--radius-4);
  padding: var(--s-5) var(--s-5);
}

.prDescription {
  /* Production-specific layout container; surface treatment via global .overview-card. */
}

.prDescriptionTitle {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 var(--s-3);
  text-wrap: pretty;
}

.prDescriptionBody {
  font-size: var(--text-sm);
  color: var(--text-2);
  line-height: 1.6;
}

.prDescriptionBody p {
  margin: 0 0 var(--s-3);
  text-wrap: pretty;
}

.prDescriptionBody p:last-child {
  margin: 0;
}

.prDescriptionBody code {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 1px 5px;
  background: var(--surface-3);
  border-radius: 3px;
  color: var(--text-1);
}

.prDescriptionEmpty {
  font-size: var(--text-sm);
  margin: 0;
}
```

Rationale on `.overviewCardHeroNoAi` (D14): production conditional class is applied when `aiPreview=false` and `PrDescription` takes the hero slot left empty by absent `AiSummaryCard`. The rule activates the hero treatment (`border-radius: var(--radius-4); padding: var(--s-5) var(--s-5)`) — the base card surface (`background`, `border`) comes from the global `.overview-card` rule via the bare literal class string. No explicit `background` needed here; it's inherited.

Why NOT also author hashed `.overviewCard` + `.overviewCardHero` rules: the literal `overview-card` and `overview-card-hero` class strings in JSX hit the global `tokens.css` rules from Step 6.1. Authoring hashed copies in the module would be dead code (the JSX uses literals, not module-imported names for these two classes). This is the test-seam-and-styling-hook unification per D16.

- [ ] **Step 6.3: Wire the module into PrDescription.tsx**

In `frontend/src/components/PrDetail/OverviewTab/PrDescription.tsx`, add the import:

```tsx
import styles from './PrDescription.module.css';
```

Replace the `cardClass` computation and the JSX. The current file (lines 9-25) has:

```tsx
export function PrDescription({ title, body, aiPreview }: PrDescriptionProps) {
  const isEmptyBody = body.trim().length === 0;
  const cardClass = aiPreview
    ? 'overview-card pr-description'
    : 'overview-card pr-description overview-card-hero-no-ai';

  return (
    <section className={cardClass} data-testid="pr-description">
      {!aiPreview && <div className="pr-description-title">{title}</div>}
      {isEmptyBody ? (
        <p className="pr-description-empty muted">No description provided</p>
      ) : (
        <MarkdownRenderer source={body} className="pr-description-body" />
      )}
    </section>
  );
}
```

Replace with:

```tsx
export function PrDescription({ title, body, aiPreview }: PrDescriptionProps) {
  const isEmptyBody = body.trim().length === 0;
  // `overview-card` is a literal class hitting the global tokens.css rule from
  // Step 6.1. `pr-description` is a literal placeholder for future reach (no
  // rule today). `overview-card-hero-no-ai` is a literal hitting the hashed
  // .overviewCardHeroNoAi module rule via the test-seam-and-styling-hook
  // unification (D16). The hashed module class is appended in the AI-OFF path
  // to actually paint the hero treatment.
  const cardClass = aiPreview
    ? `overview-card ${styles.prDescription} pr-description`
    : `overview-card ${styles.prDescription} pr-description ${styles.overviewCardHeroNoAi} overview-card-hero-no-ai`;

  return (
    <section className={cardClass} data-testid="pr-description">
      {!aiPreview && <div className={styles.prDescriptionTitle}>{title}</div>}
      {isEmptyBody ? (
        <p className={`${styles.prDescriptionEmpty} muted`}>No description provided</p>
      ) : (
        <MarkdownRenderer source={body} className={styles.prDescriptionBody} />
      )}
    </section>
  );
}
```

Note on the class composition (D14 + D16):
- AI-ON path: literal `overview-card` fires global card surface rule; the section sits as a regular card (no hero treatment) below the AI summary hero.
- AI-OFF path: literal `overview-card` fires global card surface rule + hashed `styles.overviewCardHeroNoAi` adds hero treatment (larger radius + padding) + literal `overview-card-hero-no-ai` is the test seam for `OverviewTab.test.tsx`'s `toHaveClass('overview-card-hero-no-ai')` assertions.
- Existing `PrDescription.test.tsx` lines 25 + 40 (`toHaveClass('overview-card')`) continue to hold because the literal stays on the section. No additional test migration required for these two lines beyond Task 3.

- [ ] **Step 6.4: Run PrDescription and OverviewTab tests**

```bash
cd frontend && npm test -- --run PrDescription OverviewTab
```

Expected: PASS. The `getByTestId('pr-description')` queries hit; the `toHaveClass('overview-card-hero-no-ai')` assertion holds (literal class still on the section); `toHaveClass('overview-card')` holds for both paths.

Note for the AI-ON path's `OverviewTab.test.tsx` assertion `toHaveClass('overview-card-hero')`: per the current OverviewTab.test.tsx line 433, the assertion is `expect(container.querySelector('.ai-summary-card')).toHaveClass('overview-card-hero')` — i.e., it checks the AI summary card, NOT PrDescription. PrDescription's AI-ON path does NOT carry `overview-card-hero` after this revision (the spec intent is that AiSummaryCard is the hero on AI-ON; PrDescription is a regular card below it). The assertion holds because Task 7 retains the literal `overview-card-hero` on AiSummaryCard's section.

- [ ] **Step 6.5: Run prettier and commit**

```bash
cd frontend
npx prettier --write \
  src/components/PrDetail/OverviewTab/PrDescription.tsx
cd ..
git add frontend/src/styles/tokens.css \
        frontend/src/components/PrDetail/OverviewTab/PrDescription.module.css \
        frontend/src/components/PrDetail/OverviewTab/PrDescription.tsx
git commit -m "feat(pr3): lift .overview-card to tokens.css + port PrDescription CSS"
```

---

## Task 7: Port `AiSummaryCard` module CSS — including dormant handoff structure (D17)

**Files:**
- Create: `frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.module.css`
- Modify: `frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.tsx`

Port the AI summary block. Production JSX renders only 3 of the handoff's child elements (`.ai-summary-chip`, `.ai-summary-body`, `.ai-summary-category`); the rest (handoff L82-102 — `.pr-ai-summary`, `.ai-summary-head`, `.ai-summary-label`, `.ai-summary-bullets`, `.ai-risk`) get ported AS-IS as dormant rules per D17.

- [ ] **Step 7.1: Write the module CSS file**

Create `frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.module.css` with:

```css
.aiSummaryCard {
  margin-top: var(--s-4);
  padding: var(--s-3) var(--s-4);
  border-radius: var(--radius-3);
  font-size: var(--text-sm);
}

.aiSummaryChip {
  font-size: var(--text-xs);
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--accent);
  font-weight: 600;
  margin-bottom: var(--s-3);
}

.aiSummaryBody {
  color: var(--text-1);
  margin-bottom: 6px;
  line-height: 1.55;
}

.aiSummaryCategory {
  font-size: var(--text-xs);
  color: var(--text-2);
  margin-top: var(--s-2);
}

/* Dormant: not yet rendered by production JSX. See D17 in deferrals. */
.aiSummaryHead {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  margin-bottom: 4px;
}

.aiSummaryLabel {
  font-weight: 600;
  font-size: var(--text-xs);
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--accent);
}

.aiSummaryBullets {
  margin: 4px 0 6px 0;
  padding-left: var(--s-4);
  color: var(--text-2);
  list-style: none;
}

.aiSummaryBullets li {
  margin: 2px 0;
  display: flex;
  gap: 10px;
  line-height: 1.5;
  align-items: baseline;
}

.aiRisk {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: var(--radius-2);
  font-size: var(--text-xs);
  margin-top: 4px;
  background: var(--warning-soft);
  color: var(--warning-fg);
}
```

- [ ] **Step 7.2: Wire the module into AiSummaryCard.tsx**

In `frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.tsx`, replace the full body:

```tsx
import type { PrSummary } from '../../../api/types';
import styles from './AiSummaryCard.module.css';

interface AiSummaryCardProps {
  summary: PrSummary | null;
}

export function AiSummaryCard({ summary }: AiSummaryCardProps) {
  if (!summary) return null;

  return (
    <section
      className={`ai-summary-card ${styles.aiSummaryCard} overview-card overview-card-hero ai-tint`}
      data-testid="ai-summary-card"
    >
      <div className={`${styles.aiSummaryChip} muted`}>
        AI preview — sample content, not generated from this PR
      </div>
      <div className={styles.aiSummaryBody}>{summary.body}</div>
      <div className={styles.aiSummaryCategory}>{summary.category}</div>
    </section>
  );
}
```

Note on class composition: the literal class strings `ai-summary-card`, `overview-card`, `overview-card-hero`, and `ai-tint` all stay bare on the section. After D22's lift at Task 6.1, `overview-card` + `overview-card-hero` fire global rules in `tokens.css` (card surface + hero treatment). `ai-tint` fires the existing global rule in `tokens.css:490-493` (accent-soft background). `ai-summary-card` is a literal placeholder (test seam for `OverviewTab.test.tsx`'s `getByTestId('ai-summary-card')` migration). The hashed `styles.aiSummaryCard` rule supplies AI-specific layout (`margin-top` to sit below the header gap; AI-specific font-size). Tests asserting `toHaveClass('overview-card-hero')` continue to hold (the literal stays).

- [ ] **Step 7.3: Run AiSummaryCard + OverviewTab tests**

```bash
cd frontend && npm test -- --run AiSummaryCard OverviewTab
```

Expected: PASS.

- [ ] **Step 7.4: Run prettier and commit**

```bash
cd frontend
npx prettier --write \
  src/components/PrDetail/OverviewTab/AiSummaryCard.tsx
cd ..
git add frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.module.css \
        frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.tsx
git commit -m "feat(pr3): port AiSummaryCard CSS to module incl. dormant handoff rules"
```

---

## Task 8: Port `StatsTiles` module CSS

**Files:**
- Create: `frontend/src/components/PrDetail/OverviewTab/StatsTiles.module.css`
- Modify: `frontend/src/components/PrDetail/OverviewTab/StatsTiles.tsx`

Port handoff's `.overview-stats` grid + `.ov-stat` + `.ov-stat-num` + `.ov-stat-label` (handoff L304-326) under production class names `.stats-tiles` / `.stats-tile` / `.stats-tile-label` / `.stats-tile-value` per D12.

The handoff's `.ov-stat-sub` (L327-333 — small monospace secondary line, e.g., "+214 / -61") is OUT of PR3 scope. Production `Tile` component has no `sub` prop. Restoring it would require adding a `sub?: string` prop + passing data from `OverviewTab.tsx` (e.g., `+adds/-deletes` diff counts) — a logic + data-flow change per §2.2. Note in deferrals D23 for PR9 revisit.

- [ ] **Step 8.1: Write the module CSS file**

Create `frontend/src/components/PrDetail/OverviewTab/StatsTiles.module.css` with:

```css
.statsTiles {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--s-3);
  margin: 0;
  padding: 0;
}

.statsTile {
  background: var(--surface-1);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-3);
  padding: var(--s-3) var(--s-4);
  display: flex;
  flex-direction: column-reverse;
}

.statsTileLabel {
  font-size: var(--text-xs);
  color: var(--text-2);
  margin: 4px 0 0;
}

.statsTileValue {
  font-size: var(--text-2xl);
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.1;
  color: var(--text-1);
  margin: 0;
  font-variant-numeric: tabular-nums;
}
```

Note on visual order (value-above-label) vs DOM order (`<dt>`/`<dd>`):

Production JSX renders `<dt>` (label) first, `<dd>` (value) second — semantic HTML for the definition-list pattern. The handoff renders `.ov-stat-num` (value) visually first, `.ov-stat-label` (label) visually second.

`display: flex; flex-direction: column-reverse` on `.statsTile` reverses the visual order without touching the DOM. Accessibility tools (screen readers, search bots) walk document order; `<dt>` is still announced before `<dd>`. The reverse is paint-only — large value at top, small label below. Matches the handoff's typographic hierarchy (the metric is the lede; the label is the kicker).

The label's `margin` is `4px 0 0` (top margin only) to match the handoff `.ov-stat-label`'s `margin-top: 4px` semantics — when reversed, this becomes the gap between value and label.

- [ ] **Step 8.2: Wire the module into StatsTiles.tsx**

Replace the full body of `frontend/src/components/PrDetail/OverviewTab/StatsTiles.tsx` with:

```tsx
import styles from './StatsTiles.module.css';

interface StatsTilesProps {
  filesCount: number;
  draftsCount: number;
  threadsCount: number;
  viewedCount: number;
}

export function StatsTiles({
  filesCount,
  draftsCount,
  threadsCount,
  viewedCount,
}: StatsTilesProps) {
  return (
    <dl className={styles.statsTiles}>
      <Tile label="Files" value={filesCount} />
      <Tile label="Drafts" value={draftsCount} />
      <Tile label="Threads" value={threadsCount} />
      <Tile label="Viewed" value={`${viewedCount}/${filesCount}`} />
    </dl>
  );
}

function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className={styles.statsTile} data-testid="stats-tile">
      <dt className={styles.statsTileLabel}>{label}</dt>
      <dd className={styles.statsTileValue}>{value}</dd>
    </div>
  );
}
```

- [ ] **Step 8.3: Run StatsTiles + OverviewTab tests**

```bash
cd frontend && npm test -- --run StatsTiles OverviewTab
```

Expected: PASS. The `data-testid="stats-tile"` query and `<dt>` `getByRole('term')` selectors hit; styles are applied as hashed module classes.

- [ ] **Step 8.4: Run prettier and commit**

```bash
cd frontend
npx prettier --write \
  src/components/PrDetail/OverviewTab/StatsTiles.tsx
cd ..
git add frontend/src/components/PrDetail/OverviewTab/StatsTiles.module.css \
        frontend/src/components/PrDetail/OverviewTab/StatsTiles.tsx
git commit -m "feat(pr3): port StatsTiles CSS to module (4-tile grid)"
```

---

## Task 9: Port `MarkAllReadButton` module CSS

**Files:**
- Create: `frontend/src/components/PrDetail/OverviewTab/MarkAllReadButton.module.css`
- Modify: `frontend/src/components/PrDetail/OverviewTab/MarkAllReadButton.tsx`

The handoff has no `.mark-all-read-button` rule; this is a production button that composes with the existing `.btn` / `.btn-ghost` (or `.btn-secondary`) primitive from `tokens.css`. Per D12, author a minimal module rule for placement (right-aligned within the conversation actions row) and rely on the global button primitive for visual treatment.

- [ ] **Step 9.1: Write the module CSS file**

Create `frontend/src/components/PrDetail/OverviewTab/MarkAllReadButton.module.css` with:

```css
.markAllReadButton {
  margin-left: auto;
}
```

Note: the rule places the button at the right end of its flex parent (`.prRootConversationActionsRow` from Task 10). Visual treatment (background, border, color) comes from composing with `.btn` / `.btn-ghost` in JSX.

- [ ] **Step 9.2: Wire the module into MarkAllReadButton.tsx**

In `frontend/src/components/PrDetail/OverviewTab/MarkAllReadButton.tsx`, add the import:

```tsx
import styles from './MarkAllReadButton.module.css';
```

Then change line 70 from:

```tsx
className="mark-all-read-button"
```

to:

```tsx
className={`btn btn-ghost btn-sm ${styles.markAllReadButton}`}
```

Note on global classes added: `btn`, `btn-ghost`, and `btn-sm` come from `tokens.css` and supply the button's visual treatment (background, hover, padding, font size). Production previously rendered with default browser `<button>` styling because no rule existed for `mark-all-read-button`. This is the same composition pattern PR2 applied to the `Dismiss` button in `CrossTabPresenceBanner` (`btn btn-link` per D8).

If side-by-side review shows `btn-ghost` doesn't match the handoff's "mark all read" treatment (the handoff renders it as a tertiary action in the conversation footer), the resolution is to swap `btn-ghost` for `btn-link` (the underline variant added in PR2's D8). Document in deferrals if the swap is needed.

- [ ] **Step 9.3: Confirm MarkAllReadButton tests pass**

```bash
cd frontend && npm test -- --run MarkAllReadButton
```

Expected: PASS or "no tests found" (acceptable — coverage comes from the `MarkAllReadButton.test.tsx` if present; if absent, the slice-level OverviewTab integration covers it).

- [ ] **Step 9.4: Run prettier and commit**

```bash
cd frontend
npx prettier --write \
  src/components/PrDetail/OverviewTab/MarkAllReadButton.tsx
cd ..
git add frontend/src/components/PrDetail/OverviewTab/MarkAllReadButton.module.css \
        frontend/src/components/PrDetail/OverviewTab/MarkAllReadButton.tsx
git commit -m "feat(pr3): port MarkAllReadButton CSS to module (btn-ghost composition)"
```

---

## Task 10: Port `PrRootConversation` module CSS — including timeline rail/line (D13)

**Files:**
- Create: `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.module.css`
- Modify: `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx`

Port handoff `.pr-conv-*` rules (L347-451) under production class names. The vertical timeline rail/line (handoff renders as dedicated `.pr-conv-rail` + `.pr-conv-line` children) is approximated via `::before` pseudo-element on each `.prRootComment` per D13.

- [ ] **Step 10.1: Write the module CSS file**

Create `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.module.css` with:

```css
.prRootConversation {
  display: flex;
  flex-direction: column;
  gap: 0;
}

/*
 * Per D13, comments form a vertical timeline. The 28px padding-left reserves
 * a "rail" gutter column matching the handoff's `grid-template-columns: 28px 1fr`
 * shape. The ::before line and ::after dot live inside this gutter; the comment
 * body sits to the right of it.
 */
.prRootComment {
  position: relative;
  padding: 0 0 var(--s-4) 28px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.prRootComment:last-of-type {
  padding-bottom: 0;
}

.prRootComment::before {
  content: '';
  position: absolute;
  left: 14px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border-1);
}

.prRootComment:last-of-type::before {
  bottom: 50%;
}

.prRootComment::after {
  content: '';
  position: absolute;
  left: 11px;
  top: 6px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}

.prRootCommentMeta {
  display: flex;
  align-items: baseline;
  gap: var(--s-2);
  font-size: var(--text-xs);
  flex-wrap: wrap;
}

.prRootCommentAuthor {
  font-weight: 600;
  color: var(--text-1);
}

.prRootCommentTime {
  color: var(--text-3);
}

.prRootCommentBody {
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-3);
  padding: var(--s-3) var(--s-4);
  font-size: var(--text-sm);
  color: var(--text-1);
  line-height: 1.55;
}

.prRootCommentBody p {
  margin: 0 0 8px;
  text-wrap: pretty;
  white-space: pre-wrap;
}

.prRootCommentBody p:last-child {
  margin: 0;
}

.prRootCommentBody code {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 1px 5px;
  background: var(--surface-3);
  border-radius: 3px;
  color: var(--text-1);
}

.prRootConversationActions {
  margin-top: var(--s-3);
  padding-top: var(--s-3);
  border-top: 1px solid var(--border-1);
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}

.prRootConversationActionsRow {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}

.prRootReplyButton {
  display: inline-flex;
  align-items: center;
  text-align: left;
  font-size: var(--text-sm);
  color: var(--text-3);
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  padding: 8px 12px;
  cursor: text;
  transition: all var(--t-fast);
}

.prRootReplyButton:hover {
  border-color: var(--border-strong);
  color: var(--text-2);
}

.prRootConversationFooter {
  font-size: var(--text-xs);
  margin-top: var(--s-3);
  padding-top: var(--s-3);
  border-top: 1px solid var(--border-1);
}
```

Rationale on the `::before` + `::after` rail/line treatment (D13): the handoff renders `<li>` → `<div class="pr-conv-rail">` (containing the avatar) + `<div class="pr-conv-body">` (containing the comment). Production renders `<article>` with no rail child. The CSS-only treatment uses `::before` as a thin vertical line (1px wide, full height, on the left edge with `left: 0`) and `::after` as a small accent-colored dot positioned where an avatar would sit (`left: -3px; top: 6px`). The last comment's line stops at `50%` so the timeline ends mid-way through the last comment (matching the handoff's behavior where the rail has no `pr-conv-line` after the last item). Avatars are NOT rendered (out of scope per §2.2 — no JSX structural changes).

If the side-by-side review shows the dot+line is materially worse than the handoff's avatar+line, the resolution is to add an `<img>` avatar element to JSX in a follow-up PR (the JSX would then take a `comment.authorAvatar` prop and add structural complexity). That's a behavior change PR3 declines.

- [ ] **Step 10.2: Wire the module into PrRootConversation.tsx**

In `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx`, add the import:

```tsx
import styles from './PrRootConversation.module.css';
```

Replace the className strings as follows.

Line 30 — from:

```tsx
<section className="overview-card pr-root-conversation">
```

to:

```tsx
<section className={`overview-card ${styles.prRootConversation}`}>
```

Line 32 — from:

```tsx
<article key={comment.id} className="pr-root-comment" data-testid="pr-root-comment">
```

to:

```tsx
<article
  key={comment.id}
  className={styles.prRootComment}
  data-testid="pr-root-comment"
>
```

Line 33 — from:

```tsx
<header className="pr-root-comment-meta">
```

to:

```tsx
<header className={styles.prRootCommentMeta}>
```

Line 34 — from:

```tsx
<span className="pr-root-comment-author">{comment.author}</span>
```

to:

```tsx
<span className={styles.prRootCommentAuthor}>{comment.author}</span>
```

Line 35-37 — from:

```tsx
<time className="pr-root-comment-time" dateTime={comment.createdAt}>
  {new Date(comment.createdAt).toLocaleDateString()}
</time>
```

to:

```tsx
<time className={styles.prRootCommentTime} dateTime={comment.createdAt}>
  {new Date(comment.createdAt).toLocaleDateString()}
</time>
```

Line 39-41 — from:

```tsx
<div className="pr-root-comment-body">
  <MarkdownRenderer source={comment.body} />
</div>
```

to:

```tsx
<div className={styles.prRootCommentBody}>
  <MarkdownRenderer source={comment.body} />
</div>
```

Line 52 — from:

```tsx
<p className="pr-root-conversation-footer muted">Composer not available in this context.</p>
```

to:

```tsx
<p className={`${styles.prRootConversationFooter} muted`}>
  Composer not available in this context.
</p>
```

Then in the `PrRootConversationActions` function, lines 86-91 — from:

```tsx
return (
  <div className="pr-root-conversation-actions">
    <div className="pr-root-conversation-actions-row">
      {!composerOpen && (
        <button type="button" className="pr-root-reply-button" onClick={handleReplyClick}>
          Reply
        </button>
      )}
```

to:

```tsx
return (
  <div className={styles.prRootConversationActions}>
    <div className={styles.prRootConversationActionsRow}>
      {!composerOpen && (
        <button
          type="button"
          className={styles.prRootReplyButton}
          onClick={handleReplyClick}
        >
          Reply
        </button>
      )}
```

- [ ] **Step 10.3: Run PrRootConversation tests**

```bash
cd frontend && npm test -- --run PrRootConversation
```

Expected: PASS. The `getByTestId('pr-root-comment')` queries hit.

- [ ] **Step 10.4: Run OverviewTab integration tests**

```bash
cd frontend && npm test -- --run OverviewTab
```

Expected: PASS.

- [ ] **Step 10.5: Run prettier and commit**

```bash
cd frontend
npx prettier --write \
  src/components/PrDetail/OverviewTab/PrRootConversation.tsx
cd ..
git add frontend/src/components/PrDetail/OverviewTab/PrRootConversation.module.css \
        frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx
git commit -m "feat(pr3): port PrRootConversation CSS to module incl. CSS-only timeline rail"
```

---

## Task 11: Port `PrRootReplyComposer` module CSS — scope to `composer-actions` only (D15)

**Files:**
- Create: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.module.css`
- Modify: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx`

Per D15, scope is the parent layout container (`.pr-root-reply-composer`) and the action-button row (`.composer-actions`). The 6 inner composer classes (`composer-textarea`, `composer-preview-toggle`, `composer-badge`, `composer-discard`, `composer-save`, `composer-closed-banner`) stay as bare global strings in the JSX and are styled when PR4 lifts them to `tokens.css`.

- [ ] **Step 11.1: Write the module CSS file**

Create `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.module.css` with:

```css
.prRootReplyComposer {
  padding: var(--s-2);
  background: var(--surface-2);
  border-radius: var(--radius-2);
  border: 1px solid var(--border-1);
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}

.composerActions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--s-2);
  margin-top: 8px;
}
```

Faithful port of handoff `.reply-composer` (L754-759) and `.composer-actions` (L776). The remaining 6 composer-child rules from handoff (`.composer-tabs`, `.composer-tabs .tab`, `.composer-preview`, etc.) are NOT ported here because production JSX uses a different class scheme (per D15).

- [ ] **Step 11.2: Wire the module into PrRootReplyComposer.tsx**

In `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx`, add the import:

```tsx
import styles from './PrRootReplyComposer.module.css';
```

Line 163 — from:

```tsx
className="pr-root-reply-composer"
```

to:

```tsx
className={styles.prRootReplyComposer}
```

Line 187 — from:

```tsx
<div className="composer-actions">
```

to:

```tsx
<div className={styles.composerActions}>
```

The 6 remaining `composer-*` classes (`composer-textarea` line 176, `composer-closed-banner` line 166, `composer-preview-toggle` line 190, `composer-badge` line 197, `composer-discard` line 205, `composer-save` line 215) stay as bare global strings and are NOT modified in PR3 per D15.

- [ ] **Step 11.3: Run PrRootReplyComposer tests**

If `frontend/__tests__/PrRootReplyComposer.test.tsx` exists, run it:

```bash
cd frontend && npm test -- --run PrRootReplyComposer
```

Expected: PASS or "no tests found" (acceptable — integration coverage from OverviewTab covers the wiring).

Also run the broader Overview integration:

```bash
cd frontend && npm test -- --run OverviewTab
```

Expected: PASS.

- [ ] **Step 11.4: Run prettier and commit**

```bash
cd frontend
npx prettier --write \
  src/components/PrDetail/Composer/PrRootReplyComposer.tsx
cd ..
git add frontend/src/components/PrDetail/Composer/PrRootReplyComposer.module.css \
        frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx
git commit -m "feat(pr3): port PrRootReplyComposer outer + actions CSS (composer inners deferred to PR4)"
```

---

## Task 12: Append PR3 deferrals (D12-D17) to the design-parity sidecar

**Files:**
- Modify: `docs/specs/2026-05-29-design-parity-recovery-deferrals.md`

- [ ] **Step 12.1: Append the PR3 section**

Open `docs/specs/2026-05-29-design-parity-recovery-deferrals.md` and append below the existing PR2 D11 entry:

```markdown

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

**Reality:** Production wired the conditional class to PrDescription (line 13 of `PrDescription.tsx`) without a CSS rule. The visual intent is "the hero slot when AI is off" — a wider card that fills the position normally occupied by `AiSummaryCard`.

**Plan resolution:** Author `.overviewCardHeroNoAi` in `PrDescription.module.css` with the handoff's `.overview-card-hero` declarations (wider radius, larger padding) plus explicit `background: var(--surface-1)` (no AI tint overlay). The literal class string `overview-card-hero-no-ai` stays in JSX as the test seam alongside the hashed module class.

**Status:** Applied in PR3.

### D15 — PrRootReplyComposer scope limited to `.composer-actions`

**Spec position:** §4.3 names `PrRootReplyComposer` as scope item for PR3.

**Reality:** Production JSX uses 7 composer-* classes (`composer-textarea`, `composer-preview-toggle`, `composer-badge`, `composer-discard`, `composer-save`, `composer-closed-banner`, `composer-actions`), but the handoff `screens.css` has rules for only 4 (`composer-tabs`, `composer-tabs .tab`, `composer-preview`, `composer-actions`) — and 3 of those (`composer-tabs`, `composer-tabs .tab`, `composer-preview`) reference a tabs-based composer structure production doesn't use. The only composer-class in both handoff and production is `.composer-actions`.

The remaining 6 production composer-classes are shared across all 3 composers (`InlineCommentComposer`, `ReplyComposer`, `PrRootReplyComposer`). Per spec §3.1's lift-on-second-use rule, they should live in `tokens.css`. PR4 owns all 3 composers and is the natural slice to author the lift.

**Plan resolution:** PR3 ports only `.pr-root-reply-composer` (outer container) + `.composer-actions` (button-row layout) into `PrRootReplyComposer.module.css`. The 6 inner composer classes stay as bare global strings, awaiting PR4's lift to `tokens.css`. The composer will render with default-button styling for buttons inside the actions row, but the overall layout will be correct (button row is right-aligned and spaced per the handoff).

**Reversible:** Yes. If side-by-side review of PR3 shows the bare-default button styling materially harms the Overview tab's restored visual coherence, the 6 composer-class rules can be added as bare global rules to `tokens.css` in a PR3 follow-up — the natural lift-target — rather than waiting for PR4.

**Status:** Partially applied (composer-actions ported); inner-class lift deferred to PR4.

### D16 — Test-selector migration via data-testid + module-imported class

**Spec position:** §6.1 names PR2-specific selector renames; PR3 inherits the same risk for 5 vitest unit-test files (`OverviewTab.test.tsx`, `PrDescription.test.tsx`, `StatsTiles.test.tsx`, `PrRootConversation.test.tsx`, `AiSummaryCard.test.tsx`).

**Reality:** Vitest queries fail once CSS Modules hash the class names. Module-import + literal-class assertion is the canonical pattern.

**Plan resolution:** Add 5 `data-testid` attributes to PR3 components (Task 2). Migrate 4 unit-test files to `getByTestId(...)` / `queryAllByTestId(...)`. For `toHaveClass(...)` assertions on `.overview-card-hero` / `.overview-card-hero-no-ai`, keep the literal class string in JSX as the test seam (compose alongside the hashed module class — the same dual-class pattern PR3 uses for `.ai-summary-card`, `.overview-card`, `.overview-card-hero`).

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

**Plan resolution:** Task 13.2 captures the composer-CLOSED state (Reply button + MarkAllReadButton visible; textarea + action buttons NOT mounted). The open-composer state's bare-default rendering is NOT covered by PR3's regression gate.

**Reversible:** Yes. PR4 lifts the composer primitives to `tokens.css` and captures the open-composer baseline as part of its slice. Until then, opening the composer on Overview is a known temporary visual gap — not a regression PR3's baseline gate is responsible for.

**Status:** Applied in PR3 (closed-state baseline locks in); open-composer baseline deferred to PR4.

### D22 — Lift `.overview-card` + `.overview-card-hero` to `tokens.css` upfront at Task 6

**Spec position:** §3.1 lift-on-second-use rule.

**Reality:** Both classes have ≥2 immediate consumers within PR3 (`PrDescription` + `AiSummaryCard` + `PrRootConversation` all use bare literal `overview-card` and/or `overview-card-hero` strings). Without the lift, the literals fire no rule, leaving each card visually unstyled.

**Plan resolution:** At Task 6 Step 6.1, append `.overview-card` (background + border + radius + padding) + `.overview-card-hero` (extends with larger radius + padding) to `tokens.css` as global rules. PrDescription / AiSummaryCard / PrRootConversation JSX compose these literals alongside their module-imported component-specific rules. `PrDescription.module.css` no longer authors hashed `.overviewCard` or `.overviewCardHero` (would be dead — JSX uses literals).

Originally flagged in the pre-revision plan as a "side-by-side review-time decision" at Task 13.3. That was structurally unsound (the baseline is captured before the decision), so promoted to upfront commit.

**Status:** Applied in PR3.

### D23 — Handoff `.ov-stat-sub` secondary-line slot NOT wired

**Spec position:** §4.3 names `StatsTiles` scope.

**Reality:** Handoff `.ov-stat-sub` (L327-333, small monospace) renders a secondary line on each tile (e.g., "+214 / -61" line counts, "73% reviewed" progress). Production `Tile` component takes only `label` + `value` props.

**Plan resolution:** Skip in PR3. Restoring requires (a) adding a `sub?: string` prop to `Tile`, (b) passing data from `OverviewTab.tsx` (e.g., diff `+adds/-deletes` from `diff.data.files`), (c) authoring a `.statsTileSub` module rule. Steps (a) and (b) are logic-and-data-flow changes per §2.2.

**Reversible:** Yes. PR9 revisit or a follow-up slice can wire the prop + data + rule in one pass.

**Status:** Deferred to PR9 revisit.
```

- [ ] **Step 12.2: Commit**

```bash
git add docs/specs/2026-05-29-design-parity-recovery-deferrals.md
git commit -m "docs(pr3): append PR3 deferrals (D12-D17)"
```

---

## Task 13: Un-fixme parity baseline + capture `pr-detail-overview.png`

**Files:**
- Modify: `frontend/e2e/parity-baselines.spec.ts:137`
- Create: `frontend/e2e/__screenshots__/win32/pr-detail-overview.png`

- [ ] **Step 13.1: Remove `.fixme` from the `pr-detail-overview` test**

In `frontend/e2e/parity-baselines.spec.ts`, change line 137 from:

```ts
test.fixme('pr-detail-overview', async ({ page }) => {
```

to:

```ts
test('pr-detail-overview', async ({ page }) => {
```

- [ ] **Step 13.2: Capture the first parity baseline (composer-CLOSED state per D21)**

From the worktree's `frontend/` directory:

```bash
cd frontend
npx playwright test parity-baselines.spec.ts --grep "pr-detail-overview" --update-snapshots
```

The `--grep "pr-detail-overview"` filter is critical — without it, `--update-snapshots` regenerates EVERY non-`.fixme`'d parity-baseline test, including PR2's `pr-detail-header.png`, silently masking unrelated drift.

- [ ] **Step 13.3: Verify only `pr-detail-overview.png` was written/modified**

After the capture, run:

```bash
git status -- frontend/e2e/__screenshots__/
```

Expected output: exactly one untracked file (the new `pr-detail-overview.png`) under `__screenshots__/<platform>/`. NO modifications to `pr-detail-header.png` or any other existing baseline.

If `pr-detail-header.png` or any other existing baseline is also dirty, the capture command was wrong (likely missing `--grep`). Reset the wrong-baseline changes immediately:

```bash
git checkout -- frontend/e2e/__screenshots__/<platform>/pr-detail-header.png
# Repeat for any other accidentally-modified baseline.
```

Then re-run Step 13.2 with the correct `--grep` filter.

- [ ] **Step 13.4: Verify the test passes on a clean second run**

```bash
cd frontend
npx playwright test parity-baselines.spec.ts --grep "pr-detail-overview"
```

Expected: PASS (the baseline now exists; the captured screenshot matches itself).

- [ ] **Step 13.5: Side-by-side review preparation**

Per spec §4.1.4, prepare a side-by-side capture for the PR description:
- Left: `design/handoff/PRism.html` rendered locally at the same viewport, on the Overview tab.
- Right: the Playwright-captured `pr-detail-overview.png`.

The composer is in its closed state (Reply button + MarkAllReadButton visible per D21). The open-composer baseline is PR4's responsibility.

If the implementer notes a meaningful visual delta not predicted by D12-D23 (e.g., an unanticipated tokens.css gap; an `is-you` treatment that's more disruptive than D19 anticipated; a structural mismatch the deferrals don't cover), the resolution is to document the gap as a new deferral entry (D24+) and surface it in the PR description. PR3 does NOT add new `tokens.css` or module CSS rules at this step — D22 already covered the upfront lifts that PR3 needs. Any new visual rule introduced at side-by-side review time is scope creep and should be deferred to PR9.

- [ ] **Step 13.6: Commit the baseline + un-fixme**

```bash
git add frontend/e2e/parity-baselines.spec.ts \
        frontend/e2e/__screenshots__/win32/pr-detail-overview.png
git commit -m "test(pr3): un-fixme + capture pr-detail-overview parity baseline"
```

---

## Task 14: Pre-push verification

**Files:**
- (read-only) entire worktree

Per `.ai/docs/development-process.md` pre-push checklist.

- [ ] **Step 14.1: Frontend lint**

```bash
cd frontend && npm run lint
```

Expected: PASS. (If prettier fails: per memory `feedback_prettier_check_in_ci.md`, run `npx prettier --write` on the flagged files, re-stage, re-lint, then commit the fixup as a separate step.)

- [ ] **Step 14.2: Frontend build**

```bash
cd frontend && npm run build
```

Expected: PASS. Confirm the output chunk count doesn't regress materially per spec §6.7.

- [ ] **Step 14.3: Frontend unit tests**

```bash
cd frontend && npm test -- --run
```

Expected: full vitest suite PASS.

- [ ] **Step 14.4: Backend build (Release)**

```bash
dotnet build --configuration Release
```

Timeout: 300000ms (5 min). Expected: PASS.

- [ ] **Step 14.5: Backend tests (Release, no-build)**

```bash
dotnet test --no-build --configuration Release
```

Timeout: 300000ms (5 min). Expected: PASS.

- [ ] **Step 14.6: Playwright smoke**

Restrict to the parity-baselines spec since PR3 doesn't touch behavior:

```bash
cd frontend && npx playwright test parity-baselines.spec.ts
```

Expected: PASS for `pr-detail-overview`; all other parity-baselines tests remain `.fixme`'d.

Optionally run the broader Playwright smoke to catch incidental regressions:

```bash
cd frontend && npx playwright test --grep "cold-start|overview|inbox"
```

Expected: PASS (or absorbed retry-1 flakes — same `retries: 1` semantics as PR1's D5).

- [ ] **Step 14.7: Verify no uncommitted changes**

```bash
git status
```

Expected: clean working tree (all PR3 work committed across 12+ slice commits per Tasks 2-13).

---

## Self-review

(Inline check after writing the plan — fix issues by editing the plan, no re-review pass.)

**Spec coverage:** §4.3 names 7 OverviewTab components + `PrRootReplyComposer`. Plan covers all 8 (Tasks 4-11). §6.1 test-selector risk addressed (D16 + Task 3). §4.1.3 baseline harness un-fixme covered (Task 13). §3.1 module-CSS-with-handoff-tokens convention followed throughout, with explicit lift to `tokens.css` (D22) for the `.overview-card` + `.overview-card-hero` primitives that have ≥2 PR3 consumers. §6.2 dormant-class policy extended to the AI summary stack (D17) with explicit reconciliation against PR2 D9's narrower interpretation.

**Placeholder scan:** Searched for "TBD", "TODO", "implement later", "add appropriate", "similar to". No matches. Earlier draft had "If side-by-side review shows..." conditional language at three points; revised plan promotes those to upfront commits (Task 8 `column-reverse`, D22's `tokens.css` lift, D15's full `.composer-actions` rule including extras). Task 13.5 now narrows side-by-side decisions to "document as new deferral entry only" — no new rules introduced at review time.

**Type/method consistency:** No method signatures cross tasks (this is a CSS slice). CSS class names are consistent across tasks and deferrals: `.overview-card` / `.overview-card-hero` (literal globals from `tokens.css` per D22), `.overviewCardHeroNoAi` (hashed module class per D14), `.statsTiles` / `.statsTile` / `.statsTileLabel` / `.statsTileValue` (Task 8), `.prRootConversation` / `.prRootComment` / etc. (Task 10), `.composerActions` (Task 11). The literal + hashed composition pattern (D16) is consistently described in each task that uses it.

**Bite-size discipline:** Tasks have 3-9 steps each. No step longer than ~30 lines of code. Each step has exact file path + exact command + exact expected output.

**No commits in CSS-only tasks except after the slice is wired:** Each task commits after the test re-run confirms the wired state holds.

**Plan structure matches PR2's cadence:** 14 tasks (PR2 had 11); the extra 3 are (a) splitting the 8 components across more tasks (PR3 has 8 vs PR2's 5 — more parallelism), (b) PR3's parity-baseline capture (Task 13) is structurally identical to PR2's Task 9 + adds a snapshot-scope guard step, and (c) the deferrals + pre-push verification tasks (12-14) match PR2's 10-11. No structural drift from project convention.

**ce-doc-review revision pass (2026-05-30):** Reviewed by ce-coherence + ce-feasibility + ce-design-lens + ce-scope-guardian in headless mode. 16 unique findings synthesized; revisions applied above. See the chat-summary disposition table accompanying this plan for per-finding action records.

---

## Implementer notes

- This is the **biggest user-visible delta** of the design-parity-recovery roadmap (spec §4.3). Side-by-side review during Task 13.3 is the parity gate; baseline screenshot regression in `parity-baselines.spec.ts` is the future-drift gate.
- `feedback_prettier_check_in_ci.md`: run `npx prettier --write` proactively on every JSX/test file touched, before staging. Steps 2.6, 3.8, 4.X, 5.5, 6.4, 7.4, 8.4, 9.4, 10.5, 11.4 include this in-line.
- `feedback_sweep_deferrals_for_slice.md`: completed during plan-writing pre-flight. Three prior deferrals matched PR3 scope (S3 B26 on `overview-card-hero-no-ai` modifier kept-per-handoff; S3 SG5 on PrRootConversation deferred-from-S3 and now restored in PR3; PR2 D11 on `prTabCountWarn` referenced PR3-shape work — but PR2 D11 is the warn-variant on the Sub-tab strip, not on Overview, so no carry-forward).
- Task 1 pre-flight is the "stop and report" gate. If a 9th JSX consumer or 6th test file surfaces, amend the plan in conversation per `feedback_document_plan_deviations.md`.
- `feedback_use_pr_autopilot.md`: after Task 14 passes, hand off to `pr-autopilot` for PR open + follow-up loop. Use `@claude review` (not `/code-review`) per `feedback_claude_review_trigger.md`.
