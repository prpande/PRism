# Design parity recovery — PR5 Drafts tab + reconciliation surface (CSS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the 10 components in spec §4.5 to CSS modules, lift the `chip-status-*` + `chip-override` chip family to `tokens.css`, close PR1 D2 (UnresolvedPanel `data-testid` + un-fixme + capture `pr-detail-reconciliation-panel` baseline), and capture the `pr-detail-drafts` parity baseline. No behavior changes.

**Architecture:** Component-specific layouts → colocated `.module.css` per spec §3.1. Production class names are authoritative (handoff `.stale-panel*` / `.stale-row*` rules port under production `.unresolvedPanel*` / `.staleDraftRow*` names). The chip family is lifted to `tokens.css` because four production components consume it (lift-on-second-use clears). `DraftsTab`, `DraftListItem`, `DraftListEmpty`, `DraftsTabSkeleton`, `DraftsTabError`, `DiscardAllStaleButton`, `ForeignPendingReviewModal`, `DiscardConfirmationSubModal` are production-only — no handoff source. Stale-row AI suggestion span deferred to PR9 (no production `aiPreview` data path).

**Tech Stack:** React 18 + TypeScript + Vite + CSS Modules (`localsConvention: 'camelCaseOnly'`, default). Vitest + Playwright for tests. dotnet 10 for backend test hooks (`/test/advance-head` already exists from S4).

**Worktree:** `D:/src/PRism-design-parity-pr5/` on branch `design-parity-recovery-pr5-drafts-tab` (already created).

---

## Plan-time decisions (deferrals to log)

These are documented upfront so the implementer doesn't re-litigate them at review time. Each becomes a deferrals-sidecar entry (D46+) during ce-doc-review or first-touch implementation.

| # | Decision | Rationale | Action |
|---|----------|-----------|--------|
| **D46** | UnresolvedPanel and StaleDraftRow are the only handoff-derived PR5 components; the rest are production-only. | Handoff prototype has no Drafts-tab content surface (`pr-detail.jsx:127-135` declares the tab button but no tab-body rendering switch). `StaleDraftPanel` is the only handoff equivalent of the production reconciliation family. | Port handoff `.stale-panel*` + `.stale-row*` visual treatment under production names. Derive production-only treatments from surrounding visual language (PR3/PR4 surface tokens, `.muted` global, `.banner-warning` global). |
| **D47** | `chip-status-stale` + `chip-override` lifted to `tokens.css`. `chip-status-moved` + `chip-status-draft` stay LOCAL to `DraftListItem.module.css`. | `chip-status-stale` has 5 consumers (StaleDraftRow + UnresolvedPanel summary chip + UnresolvedPanel verdict-reconfirm-row chip at L155 + DraftsTab header + DraftListItem dynamic interpolation) — clears lift-on-second-use. `chip-override` has 1 module consumer + 1 Playwright literal consumer (`s4-keep-anyway-survives-reload.spec.ts:82` asserts on the literal class) — the test-seam requirement makes the global-namespace placement load-bearing. `chip-status-moved` + `chip-status-draft` are emitted ONLY via `chip-status-${status.modifier}` interpolation in `DraftListItem.tsx:81` — single consumer file each, fails lift-on-second-use. Coherent-family argument was insufficient (would re-litigate D52's correct single-consumer rejection on identical evidence). | Append 2 global rules to `tokens.css` at Task 4. Author `.chip-status-moved` + `.chip-status-draft` rules INSIDE `DraftListItem.module.css` at Task 8 alongside the literal-class-and-module pattern (literal stays on JSX for the dynamic interpolation; hashed module class wins the paint via Vite injection order). |
| **D48** | Stale-row AI suggestion span (handoff `.stale-ai`) DEFERRED to PR9. | Production `StaleDraftRow.tsx` has no `aiPreview` consumption, no `aiSuggestion` data field on `DraftCommentDto`/`DraftReplyDto`. Restoring the visual requires a JSX touch + data extension — out of §2.2 scope. Same shape as PR4 D32a (FileTree AI dot). | Do NOT author `.staleDraftRowAi` rule. Document deferral as D48 sidecar entry. Spec §4.5 line 263 ("AI-suggestion chip when `aiPreview` is on") + §6.4 ("Per slice, the styling lands; the data path stays canned") is honored at PR9 wire-up. |
| **D49** | PR5 closes PR1 D2: add `data-testid="unresolved-panel"` to the `<section>` container in UnresolvedPanel, add `pr-detail-reconciliation-panel` test in `parity-baselines.spec.ts`, capture the baseline in the stale-draft fixture state. | PR1 D2 explicitly deferred to PR5. | Tasks 3 + 18 + 20. |
| **D50** | BEM-shaped class names (`foreign-prr-modal__body`, `discard-confirmation-sub-modal__footer`) author camelCase rules under `.foreignPrrModalBody` / `.discardConfirmationSubModalFooter` in their .module.css. Production JSX keeps the literal BEM kebab classes as test seams; CSS modules supply the hashed styling alongside. Matches PR4 D16 literal-class-and-module pattern. | The repo's `frontend/vite.config.ts` does NOT set `css.modules.localsConvention`, so the Vite/postcss-modules default `camelCase` applies (both `styles['kebab-name']` and `styles.kebabName` exist on the exports). The reason to author camelCase rules is **project convention** — every existing `.module.css` under `frontend/src/components/PrDetail/**` (~26 files across PR2-PR4) uses camelCase keys — not a strict Vite requirement. Keeping production BEM literals in JSX preserves test selectors and a11y hooks. | Apply to both modal components (Tasks 13 + 14). |
| **D51** | DiscardAllStaleButton.module.css authors ONLY the modal-content rules (`.discardAllPreviewList`, `.discardAllPreviewBody`, `.discardAllError`). The trigger button itself uses `.btn .btn-danger .btn-sm` globals already in tokens.css — no extra rule needed. | The component file is named after the trigger button but most of its rendered DOM lives inside a `<Modal>` confirming the destructive action. Adding speculative trigger-button rules would be dead code. | Author 3 module rules (preview list ul, preview body pre, error paragraph). |
| **D52** | `.verdictReconfirmRow` lives in `UnresolvedPanel.module.css` (single consumer). NOT lifted to tokens.css. | Single consumer; no second consumer planned. Lift would be speculative. | Author one module rule with row layout. |
| **D55** | StaleDraftRow port deviates from handoff's `.stale-row { flex-direction: column; gap: 8px }` (screens.css:473-476) — production renders horizontally with `flex-wrap`. | Production JSX (`StaleDraftRow.tsx:103`) already uses `row gap-2` global on the `<li>`, which conflicts with `flex-direction: column`. Forcing column would either drop the global compose (JSX restructuring beyond §2.2) or override the global from the module rule (cascade complexity). Hybrid: keep the row direction, push the preview onto its own line via `.staleDraftRowPreview { flex: 1 1 100% }` so the body quote still reads as visually subordinate. Spec §2.2 says deviations need a sidecar entry; logging here. | Apply visual treatment as Task 6 prescribes. Side-by-side review will see the row-layout delta from handoff; flag in the PR description as expected. |
| **D56** | StaleDraftRow's "Delete" button stays "Delete" (NOT renamed to handoff's "Discard"). | Spec §2.2: "Class names, layout, and small JSX restructuring are in scope; state, routing, and data fetching are out." Button label is JSX text content, not a class/layout/structural restructure. Renaming would also touch all 5 callers of the same delete action across PRism (StaleDraftRow + DraftListItem + composers + …) where the production verb has been "Delete" since S4. The handoff prototype reads "Discard" but `DraftListItem.tsx:103` ships "Delete" and existing tests assert on `/delete/i`. PR9 revisit owns the copy adjudication if uniform "Discard" is preferred. | No code change; document deviation. |
| **D57** | UnresolvedPanel's "sticky-top" behavior (spec §4.5) is implemented by `position: sticky; top: 0; z-index: 1` on `.unresolvedPanel`. | No existing CSS rule authors this; `PrDetailPage.tsx` has no module CSS file. The parent `<div className="pr-detail-page">` wrapper has no explicit `overflow` declaration today, so `position: sticky` may sticky-against the viewport rather than against an inner scroll container. That matches the spec's intent ("sticky-top reconciliation surface" reads as "stays pinned to the visible top of PR Detail while the user scrolls"). If a future PrDetailPage layout introduces an inner scroll container, the sticky rule continues to work against the nearest ancestor with non-`visible` overflow. | Add `position: sticky; top: 0; z-index: 1` to `.unresolvedPanel` at Task 5 Step 5.2. If side-by-side review shows the panel scrolling off, flag for PR9 to add an inner-scroll container at PrDetailPage. |
| **D53** | The PR5 parity baselines need a non-empty Drafts state and a non-empty Reconciliation state. The simplest path uses the existing `advanceHead()` + composer-driven draft-save pattern (`s4-keep-anyway-survives-reload.spec.ts:24-50` is the template). A `setupAndOpenHandoffParityFixtureWithStaleDraft(page)` helper is authored in `frontend/e2e/helpers/parity-fixture.ts` to keep the spec body compact. | Mirrors PR4's `setupAndOpenHandoffParityFixture` factoring decision; one helper used by both PR5 baselines. The helper's selector for Calc.cs file row uses `[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]` (the PR4 D41 selector); the diff-pane comment trigger uses `getByRole('button', { name: /add comment on line 3/i })` matching the `aria-label="Add comment on line 3"` real on `DiffPane.tsx:288`. Both selectors verified live in the PR5 worktree base. | Task 18, with the helper authored BEFORE Task 2.3 un-fixmes `pr-detail-drafts` so the test body uses the populated-state helper from the first un-fixme commit. See sequencing-correction note above the task list. |
| **D54** | Single-PR5 default; split-checkpoint at end of Task 12. Estimated total ~700-900 LOC of CSS across 10 module files + 2 tokens.css globals. If measured ≥ 600 LOC OR ≥ 8 review-meaningful changes at Task 12, split into PR5a (handoff-derived: UnresolvedPanel + StaleDraftRow + tokens.css lift + test-ids + reconciliation-panel baseline) and PR5b (production-only: 7 remaining components + Drafts-tab baseline). | Mirrors PR4 D42 split policy (spec §4.4 line 255 carve-out). "Review-meaningful change" = one of: a module file ported / a global rule lifted / a test-selector migration / a baseline captured / a deferral newly added during implementation. PR4 measured 6 at Task 9.5 (below threshold). | Implementer judges at Task 12. If the split fires, the un-fixme of `pr-detail-drafts` (Task 2.3) and its baseline capture (Task 19) BOTH move to PR5b — leaving PR5a to ship only the reconciliation half (Tasks 3 + 18 + 20). |

---

## Sequencing correction — Task 2.3, Task 18, Task 19

The original draft of this plan un-fixmed `pr-detail-drafts` in Task 2.3 with the old `setupAndOpenHandoffParityFixture` (empty-drafts) helper, then planned a separate helper swap in Task 18.4 before Task 19 captured the baseline. ce-doc-review caught the gap: between Task 2.3 and Task 18, the un-fixmed test ran against the empty-state DOM; if Task 19 ran `--update-snapshots` before Task 18.4 landed (e.g., the implementer ran the baseline capture out of sequence, or a CI workflow_dispatch reached `Task 19` before the helper-swap commit was pushed), the baseline would capture an unstyled empty-state instead of the populated stale-draft state.

**Resolution:** the helper authoring at Task 18 moves UP. The actual ordering is:

1. **Task 18 ships FIRST** (author `setupAndOpenHandoffParityFixtureWithStaleDraft` helper + finalize the `pr-detail-reconciliation-panel` test definition that references it; un-fixme + swap the helper on `pr-detail-drafts` test body in the SAME edit).
2. **Tasks 2 + 3** (testid additions) follow.
3. **Tasks 4-17** (CSS module ports + lifts + audits).
4. **Tasks 19 + 20** (baseline captures) close at the end.

The task numbering in the body is preserved (renumbering would break the subagent dispatch instructions and cross-references throughout), but the implementer / orchestrator MUST run Task 18 before Task 2 in the actual commit sequence. Each affected task carries a one-line note at its head reminding of the dependency.

---

## File structure

**New CSS module files (10):**

```
frontend/src/components/PrDetail/
  DraftsTab/
    DraftsTab.module.css            (new — Task 7)
    DraftListItem.module.css        (new — Task 8)
    DraftListEmpty.module.css       (new — Task 9)
    DraftsTabSkeleton.module.css    (new — Task 10)
    DraftsTabError.module.css       (new — Task 11)
    DiscardAllStaleButton.module.css (new — Task 12)
  Reconciliation/
    UnresolvedPanel.module.css      (new — Task 5)
    StaleDraftRow.module.css        (new — Task 6)
  ForeignPendingReviewModal/
    ForeignPendingReviewModal.module.css      (new — Task 13)
    DiscardConfirmationSubModal.module.css    (new — Task 14)
```

**Modified files:**

```
frontend/src/styles/tokens.css     (+~30 lines — 4 chip globals at Task 4)
frontend/src/components/PrDetail/DraftsTab/DraftsTab.tsx                       (testid + module import at Task 2 + Task 7)
frontend/src/components/PrDetail/DraftsTab/DraftListItem.tsx                   (module import at Task 8)
frontend/src/components/PrDetail/DraftsTab/DraftListEmpty.tsx                  (module import at Task 9)
frontend/src/components/PrDetail/DraftsTab/DraftsTabSkeleton.tsx               (module import at Task 10)
frontend/src/components/PrDetail/DraftsTab/DraftsTabError.tsx                  (module import at Task 11)
frontend/src/components/PrDetail/DraftsTab/DiscardAllStaleButton.tsx           (module import at Task 12)
frontend/src/components/PrDetail/Reconciliation/UnresolvedPanel.tsx            (testid + module import at Task 3 + Task 5)
frontend/src/components/PrDetail/Reconciliation/StaleDraftRow.tsx              (module import at Task 6)
frontend/src/components/PrDetail/ForeignPendingReviewModal/ForeignPendingReviewModal.tsx       (module import at Task 13)
frontend/src/components/PrDetail/ForeignPendingReviewModal/DiscardConfirmationSubModal.tsx     (module import at Task 14)
frontend/e2e/parity-baselines.spec.ts                                          (un-fixme + add reconciliation test at Tasks 2 + 3)
frontend/e2e/helpers/parity-fixture.ts                                         (add stale-draft helper at Task 18)
docs/specs/2026-05-29-design-parity-recovery-deferrals.md                      (append D46-D54 at Task 21)
```

**Vitest test files audited (no CSS class assertions found in spot-check; Task 15 full sweep confirms):**

- `frontend/__tests__/DraftsTab.test.tsx` — uses Testing Library `getByRole`/`getByText`. No `.className` queries observed at first 90 lines.
- `frontend/__tests__/UnresolvedPanel.test.tsx` — same shape.
- `frontend/__tests__/StaleDraftRow.test.tsx`, `frontend/__tests__/DraftListItem.test.tsx`, `frontend/__tests__/DiscardAllStaleButton.test.tsx`, `frontend/__tests__/ForeignPendingReviewModal.test.tsx`, `frontend/__tests__/DiscardConfirmationSubModal.test.tsx` — verified at Task 15.

**Playwright spec consumers:**

- `frontend/e2e/s4-keep-anyway-survives-reload.spec.ts:82` uses `.chip.chip-override` literal — STAYS as a literal because tokens.css lift preserves the kebab name (no migration needed; the rule moves into tokens.css under the same name).
- `frontend/e2e/parity-baselines.spec.ts:169-184` — un-fixme `pr-detail-drafts` test (Task 2); add `pr-detail-reconciliation-panel` test (Task 3); baselines captured at Tasks 19+20.

---

## Tasks

### Task 1: Pre-flight grep + fixture-state audit

**Files:**
- Read-only.

- [ ] **Step 1.1: Grep production className strings for PR5 components**

Run from worktree root:

```bash
grep -rn "drafts-tab\|drafts-tab-header\|drafts-tab-header-title\|drafts-tab-body\|drafts-tab-file-group\|drafts-tab-file-heading\|drafts-tab-empty\|drafts-tab-skeleton\|drafts-tab-skeleton-header\|drafts-tab-error\|draft-list-item\|draft-list-item-header\|draft-list-item-preview\|draft-list-item-actions\|chip-status-stale\|chip-status-moved\|chip-status-draft\|chip-override\|stale-draft-row\|stale-draft-row-anchor\|stale-draft-row-preview\|unresolved-panel\|unresolved-panel-summary\|unresolved-panel-announce\|unresolved-panel-rows\|verdict-reconfirm-row\|foreign-prr-modal\|discard-confirmation-sub-modal\|discard-all-preview-list\|discard-all-preview-body\|discard-all-error" frontend/src frontend/__tests__ frontend/e2e
```

Catalog the producer + every consumer (test files, sibling components). The catalog is the source of truth for Tasks 5-14 implementer prompts.

Expected (verified at plan-time): 14 files total; 11 JSX producers; 1 vitest skeleton testid use; 1 Playwright literal-class consumer (`.chip.chip-override` in `s4-keep-anyway-survives-reload.spec.ts:82`).

- [ ] **Step 1.2: Confirm `tokens.css` has none of the four chip rules**

```bash
grep -n "chip-status-stale\|chip-status-moved\|chip-status-draft\|chip-override" frontend/src/styles/tokens.css
```

Expected: zero matches. Confirms D47's premise (no existing rules; PR5 is authoring fresh).

- [ ] **Step 1.3: Audit existing `data-testid` attributes on PR5 components**

```bash
grep -rn "data-testid" frontend/src/components/PrDetail/DraftsTab frontend/src/components/PrDetail/Reconciliation frontend/src/components/PrDetail/ForeignPendingReviewModal
```

Expected: only `data-testid="drafts-tab-skeleton"` on DraftsTabSkeleton and `data-testid="unresolved-panel-announce"` on UnresolvedPanel's announce-only div. PR5 ADDS `drafts-tab` (Task 2) + `unresolved-panel` (Task 3) — both on visible containers.

- [ ] **Step 1.4: Verify the handoff source classes exist**

```bash
grep -n "\.stale-panel\|\.stale-head\|\.stale-title\|\.stale-list\|\.stale-row\|\.stale-row-meta\|\.stale-anchor\|\.stale-note\|\.stale-body\|\.stale-ai\|\.stale-actions" design/handoff/screens.css
```

Expected: rules at lines 343-495. These are the handoff source for Tasks 5 + 6.

- [ ] **Step 1.5: Re-confirm spec §4.5 zone scope**

Read `docs/specs/2026-05-29-design-parity-recovery-design.md:259-265` (PR5 scope) and `docs/specs/2026-05-29-design-parity-recovery-deferrals.md` D2 entry to refresh exact scope before authoring.

- [ ] **Step 1.6: Audit existing /test/* hooks for stale-draft fixture prep**

```bash
grep -rn "/test/" PRism.Web/TestHooks frontend/e2e/helpers
```

Expected: `/test/advance-head` exists (`s5-submit.ts:174` + `s4-setup.ts:85-92`). Document the composer-driven save flow from `s4-keep-anyway-survives-reload.spec.ts:24-50` as the template the parity-fixture helper (Task 18) builds on.

- [ ] **Step 1.7: Commit pre-flight notes**

No code changes; commit the implementer's pre-flight catalog as a doc-only commit if convenient (or fold into Task 2's commit message).

---

### Task 2: Add `data-testid="drafts-tab"` + un-fixme `pr-detail-drafts` test

> **Sequencing note**: Task 18 ships FIRST (parity-fixture helper). This task's Step 2.3 imports `setupAndOpenHandoffParityFixtureWithStaleDraft` — a name that won't exist until Task 18 commits. Confirm Task 18 has landed before starting Task 2.

**Files:**
- Modify: `frontend/src/components/PrDetail/DraftsTab/DraftsTab.tsx` (lines 124 and 134 — both `<div className="drafts-tab">` returns)
- Modify: `frontend/e2e/parity-baselines.spec.ts:169-177` (drop `test.fixme` → `test` AND swap the helper to the populated-state variant)

- [ ] **Step 2.1: Add testid to both render branches**

In both the empty-state branch (~line 124) and the populated branch (~line 134), the outer `<div className="drafts-tab">` gains `data-testid="drafts-tab"`:

```tsx
<div className="drafts-tab" data-testid="drafts-tab">
```

- [ ] **Step 2.2: Vitest covers both render branches**

Add a one-liner assertion in `frontend/__tests__/DraftsTab.test.tsx` under each existing render branch (empty-state and populated branches) that the testid is present:

```tsx
expect(screen.getByTestId('drafts-tab')).toBeInTheDocument();
```

If the test file's existing structure already covers both branches (e.g., "RendersEmptyState_WhenNoDrafts" + "RendersDraftsList_WhenSessionHasDrafts" or similar), append the assertion inside each. Don't add a new top-level describe block.

- [ ] **Step 2.3: Un-fixme the parity-baselines spec for drafts AND swap helper to populated-state variant**

Edit `frontend/e2e/parity-baselines.spec.ts:169-177`:

```tsx
// Before:
test.fixme('pr-detail-drafts', async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await setupAndOpenHandoffParityFixture(page);
  await page.goto('/pr/acme/api/123/drafts');
  // ...

// After:
test('pr-detail-drafts', async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await setupAndOpenHandoffParityFixtureWithStaleDraft(page);
  await page.goto('/pr/acme/api/123/drafts');
  // ... (rest unchanged)
```

Update the `parity-fixture` import at the top of the file to bring in the populated-state helper authored by Task 18:

```tsx
import {
  setupAndOpenHandoffParityFixture,
  setupAndOpenHandoffParityFixtureWithStaleDraft,
} from './helpers/parity-fixture';
```

The test will FAIL at the locator-wait until Task 19 runs `--update-snapshots` — that's expected. The helper itself (Task 18) must be merged before this step runs.

- [ ] **Step 2.4: Run vitest for the DraftsTab file**

```bash
cd frontend && npm run test -- DraftsTab.test.tsx
```

Expected: all existing tests + the new testid assertions PASS.

- [ ] **Step 2.5: Commit**

```bash
git add frontend/src/components/PrDetail/DraftsTab/DraftsTab.tsx frontend/__tests__/DraftsTab.test.tsx frontend/e2e/parity-baselines.spec.ts
git commit -m "feat(pr5): add drafts-tab testid + un-fixme parity baseline"
```

---

### Task 3: Add `data-testid="unresolved-panel"` (PR1 D2 close — part 1)

> **Sequencing note**: This task NO LONGER authors the `pr-detail-reconciliation-panel` Playwright test definition. That moved into Task 18 (Step 18.3) where the helper and test definition are committed together, avoiding the non-compiling-state window the original Task 3.3 had.

**Files:**
- Modify: `frontend/src/components/PrDetail/Reconciliation/UnresolvedPanel.tsx:137-143` (the visible `<section>` container)

- [ ] **Step 3.1: Add testid to the visible `<section>`**

```tsx
<section
  ref={containerRef}
  role="region"
  aria-label="Unresolved drafts"
  tabIndex={-1}
  className="unresolved-panel"
  data-testid="unresolved-panel"
>
```

DO NOT change the `data-testid="unresolved-panel-announce"` on the announce-only `<div>` (lines 122-129) — that testid is used by `__tests__/UnresolvedPanel.test.tsx` for the polite-live-region announcement check.

- [ ] **Step 3.2: Vitest covers the new testid**

Add an assertion in `__tests__/UnresolvedPanel.test.tsx` inside the existing "RendersOnEveryTab_WhenStaleCountGtZero" test (~line 71) to confirm the testid is exposed alongside the existing `getByRole('region', ...)` query:

```tsx
expect(screen.getByTestId('unresolved-panel')).toBeInTheDocument();
```

- [ ] **Step 3.3: Run vitest**

```bash
cd frontend && npm run test -- UnresolvedPanel.test.tsx
```

Expected: all existing tests + the new testid assertion PASS.

- [ ] **Step 3.4: Commit (testid + vitest changes — Playwright test definition is in Task 18)**

```bash
git add frontend/src/components/PrDetail/Reconciliation/UnresolvedPanel.tsx frontend/__tests__/UnresolvedPanel.test.tsx
git commit -m "feat(pr5): add unresolved-panel testid (closes PR1 D2 part 1)"
```

---

### Task 4: Lift `chip-status-stale` + `chip-override` to `tokens.css` (D47)

> **Note**: D47 was tightened during plan-review. Only `chip-status-stale` (5 consumers) and `chip-override` (Playwright literal-test consumer) lift here. `chip-status-moved` and `chip-status-draft` (single consumer each via dynamic interpolation in `DraftListItem.tsx:81`) get authored as LOCAL rules in `DraftListItem.module.css` at Task 8.

**Files:**
- Modify: `frontend/src/styles/tokens.css` (append 2 global rules near the existing `.chip-success`/`.chip-warning`/`.chip-danger`/`.chip-info`/`.chip-accent` block at lines 387-392)

- [ ] **Step 4.1: Write the failing test (visual via parity-baselines later; here, a unit sanity test)**

`tokens.css` doesn't have direct unit-test coverage; the regression gate is per-component vitest + parity baselines. Skip a unit test at this step and document the visual check happens at Tasks 19+20.

- [ ] **Step 4.2: Append the two rules**

After the existing chip-variant block (after `.chip-accent { ... }` at line 392 of `tokens.css`), append:

```css
/* Status chips for draft / reconciliation rows.
   Consumers (lift-justifying):
   - .chip-status-stale: 5 producers —
       * StaleDraftRow ("Stale" anchor chip),
       * UnresolvedPanel summary chip ("1 draft needs attention"),
       * UnresolvedPanel verdict-reconfirm row chip ("Verdict"),
       * DraftsTab header chip ("N stale"),
       * DraftListItem dynamic interpolation `chip-status-${status.modifier}`
   - .chip-override: 1 module producer (DraftListItem) + 1 Playwright literal-test consumer
     (s4-keep-anyway-survives-reload.spec.ts:82 asserts on the literal class).
   The other two `chip-status-*` variants (.chip-status-moved, .chip-status-draft) stay local
   to DraftListItem.module.css per D47 — single consumer file each, fails lift-on-second-use.
*/
.chip-status-stale { background: var(--danger-soft); color: var(--danger-fg); }
.chip-override     { background: var(--surface-3); color: var(--text-2); border: 1px dashed var(--border-strong); }
```

Color mapping rationale:
- **stale** → `danger-soft/danger-fg` — matches handoff `pr-detail.jsx:325` (`chip-${d.severity === "stale" ? "danger" : "warning"}`) and the typical "needs urgent attention" semantic.
- **override** → `surface-3/text-2` with dashed border — visually distinct from the active status states (production-only; D47 documents the absence of handoff source). Dashed border signals "user-asserted state override" without competing with the status chips it sits alongside.

The `moved` + `draft` chip colors are documented inline in Task 8's `DraftListItem.module.css` rule set.

- [ ] **Step 4.3: Sanity check via grep**

```bash
grep -n "chip-status-stale\|chip-override" frontend/src/styles/tokens.css
```

Expected: 2 lines (one each). `chip-status-moved` and `chip-status-draft` are intentionally absent from tokens.css per D47 — they land in `DraftListItem.module.css` at Task 8.

- [ ] **Step 4.4: Run lint + prettier**

```bash
cd frontend && npm run prettier --write src/styles/tokens.css && npm run lint
```

- [ ] **Step 4.5: Commit**

```bash
git add frontend/src/styles/tokens.css
git commit -m "feat(pr5): lift chip-status-stale + chip-override to tokens.css (D47)"
```

---

### Task 5: Author `UnresolvedPanel.module.css` (handoff `.stale-panel*` port)

**Files:**
- Create: `frontend/src/components/PrDetail/Reconciliation/UnresolvedPanel.module.css`
- Modify: `frontend/src/components/PrDetail/Reconciliation/UnresolvedPanel.tsx` (import + `styles.x` composition)

- [ ] **Step 5.1: Write the failing vitest test (verifies the new className lands)**

In `frontend/__tests__/UnresolvedPanel.test.tsx`, add a test that asserts both the literal class and the hashed module class are present on the visible section. Following the PR3 D16 literal-class-and-module precedent:

```tsx
import styles from '../src/components/PrDetail/Reconciliation/UnresolvedPanel.module.css';

it('AppliesBothLiteralAndModuleClasses_OnVisibleSection', () => {
  const session = mkSession({ draftComments: [mkComment({ id: 'a', status: 'stale' })] });
  renderPanel(session);
  const section = screen.getByTestId('unresolved-panel');
  expect(section).toHaveClass('unresolved-panel');
  expect(section).toHaveClass(styles.unresolvedPanel);
});
```

Run: `npm run test -- UnresolvedPanel.test.tsx` — expected to FAIL (module file missing).

- [ ] **Step 5.2: Author the module CSS**

Create `frontend/src/components/PrDetail/Reconciliation/UnresolvedPanel.module.css`:

```css
/* Ports handoff `.stale-panel*` (screens.css:457-471) under production
   class names. Sticky-top reconciliation surface mounted at PrDetailPage
   layout root, visible across Overview / Files / Drafts tabs.
   D57: position: sticky + top:0 + z-index:1 implements spec §4.5's
   "sticky-top reconciliation surface" intent. No PrDetailPage module
   CSS exists today; the sticky positions against the viewport (the
   nearest ancestor with non-`visible` overflow), which matches the
   spec language. If a future PrDetailPage layout introduces an inner
   scroll container, the sticky behavior continues to work against
   the new ancestor without change here. */

.unresolvedPanel {
  position: sticky;
  top: 0;
  z-index: 1;
  margin: var(--s-4) var(--s-6) 0;
  background: var(--surface-1);
  border: 1px solid var(--warning);
  border-left-width: 3px;
  border-radius: var(--radius-3);
  overflow: hidden;
}

.unresolvedPanelSummary {
  padding: var(--s-3) var(--s-4);
  background: var(--warning-soft);
  border-bottom: 1px solid var(--border-1);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.unresolvedPanelAnnounce {
  font-weight: 600;
  color: var(--warning-fg);
  font-size: var(--text-sm);
}

.unresolvedPanelRows {
  display: flex;
  flex-direction: column;
  list-style: none;
  margin: 0;
  padding: 0;
}

/* D52: single-consumer rule; not lifted to tokens.css. */
.verdictReconfirmRow {
  padding: var(--s-3) var(--s-4);
  border-bottom: 1px solid var(--border-1);
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
}

.verdictReconfirmRow:last-child { border-bottom: 0; }

/* Used when the panel transitions to staleCount = 0 and the announce-only
   div takes over (UnresolvedPanel.tsx:120-130). Visually hidden, but kept
   in the document for screen readers. */
.unresolvedPanelAnnounceOnly {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

- [ ] **Step 5.3: Wire the module classes in `UnresolvedPanel.tsx`**

> **Disambiguation note**: two similar-looking class keys map to different render branches.
> - `styles.unresolvedPanelAnnounce` → the visible `<span aria-live="polite">` inside the populated panel `<header>` (the polite live region that announces the summary line as it changes).
> - `styles.unresolvedPanelAnnounceOnly` → the screen-reader-only `<div>` rendered when the panel transitions to staleCount=0 ("All drafts reconciled.") in lieu of the full visible panel.
> Do not swap them; the announce-only class is the visually-hidden one.

```tsx
import styles from './UnresolvedPanel.module.css';

// ... inside the component, on the visible <section> ~line 137:
<section
  ref={containerRef}
  role="region"
  aria-label="Unresolved drafts"
  tabIndex={-1}
  className={`unresolved-panel ${styles.unresolvedPanel}`}
  data-testid="unresolved-panel"
>
  <header className={`unresolved-panel-summary ${styles.unresolvedPanelSummary}`}>
    <span aria-live="polite" className={`unresolved-panel-announce ${styles.unresolvedPanelAnnounce}`}>
      {summary}
    </span>
  </header>
  <ul className={`unresolved-panel-rows ${styles.unresolvedPanelRows}`}>
    {counts.stale.map((d) => (
      <StaleDraftRow key={d.data.id} prRef={prRef} draft={d} onMutated={onMutated} />
    ))}
    {counts.needsReconfirm && (
      <li className={`verdict-reconfirm-row row gap-2 ${styles.verdictReconfirmRow}`}>
        {/* … existing children unchanged … */}
      </li>
    )}
  </ul>
</section>

// ... on the announce-only branch ~line 122:
<div
  aria-live="polite"
  className={`unresolved-panel-announce-only ${styles.unresolvedPanelAnnounceOnly}`}
  data-testid="unresolved-panel-announce"
>
  All drafts reconciled.
</div>
```

Literal classes stay on JSX as test seams + styling hooks (PR4 D16). Module classes win the cascade per Vite's CSS-modules injection order, so the hashed-rule paint applies.

- [ ] **Step 5.4: Run vitest**

```bash
cd frontend && npm run test -- UnresolvedPanel.test.tsx
```

Expected: PASS (Step 5.1's failing test now passes; pre-existing tests stay green).

- [ ] **Step 5.5: Run prettier + lint**

```bash
cd frontend && npm run prettier --write src/components/PrDetail/Reconciliation && npm run lint
```

- [ ] **Step 5.6: Commit**

```bash
git add frontend/src/components/PrDetail/Reconciliation/UnresolvedPanel.module.css frontend/src/components/PrDetail/Reconciliation/UnresolvedPanel.tsx frontend/__tests__/UnresolvedPanel.test.tsx
git commit -m "feat(pr5): port UnresolvedPanel to CSS module (handoff .stale-panel)"
```

---

### Task 6: Author `StaleDraftRow.module.css` (handoff `.stale-row*` port)

> **Test-file note**: `StaleDraftRow.test.tsx` does NOT exist in the repo (verified by ce-doc-review). The component's behavior is covered by `__tests__/UnresolvedPanel.test.tsx` via integration — UnresolvedPanel renders StaleDraftRow children. Add the new assertion in `UnresolvedPanel.test.tsx` inside the existing "RendersOnEveryTab_WhenStaleCountGtZero" test (or the closest stale-rendering test). Do NOT author a standalone StaleDraftRow.test.tsx file.

> **D55 ref**: This task's `.staleDraftRow` rule deliberately deviates from handoff's `flex-direction: column` to keep the production `row gap-2` global compose intact. The body quote gets `flex: 1 1 100%` to push it onto its own line, approximating the handoff blockquote effect. Side-by-side review will see the row-layout delta; flag in the PR description as expected.

**Files:**
- Create: `frontend/src/components/PrDetail/Reconciliation/StaleDraftRow.module.css`
- Modify: `frontend/src/components/PrDetail/Reconciliation/StaleDraftRow.tsx`
- Modify: `frontend/__tests__/UnresolvedPanel.test.tsx` (the new module-class assertion)

- [ ] **Step 6.1: Write the failing vitest test**

In `frontend/__tests__/UnresolvedPanel.test.tsx`, inside the existing "RendersOnEveryTab_WhenStaleCountGtZero" test, after the existing `getByRole('region', ...)` check add:

```tsx
import staleStyles from '../src/components/PrDetail/Reconciliation/StaleDraftRow.module.css';

// inside RendersOnEveryTab_WhenStaleCountGtZero:
const li = screen.getByRole('region', { name: /unresolved drafts/i }).querySelector('li.stale-draft-row');
expect(li).not.toBeNull();
expect(li).toHaveClass(staleStyles.staleDraftRow);
```

Run: `npm run test -- UnresolvedPanel.test.tsx` — expected FAIL (module file missing).

- [ ] **Step 6.2: Author the module CSS**

```css
/* Ports handoff `.stale-row*` (screens.css:473-495) under production
   class names. Mounted as <li> children of UnresolvedPanel's .unresolvedPanelRows ul.
   D48: .stale-ai (handoff AI suggestion span) NOT ported — production has no
   aiPreview data path on draft DTOs; deferred to PR9. */

.staleDraftRow {
  padding: var(--s-3) var(--s-4);
  border-bottom: 1px solid var(--border-1);
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
}

.staleDraftRow:last-child { border-bottom: 0; }

.staleDraftRowAnchor {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-2);
}

.staleDraftRowPreview {
  font-size: var(--text-sm);
  color: var(--text-1);
  font-style: italic;
  padding-left: 10px;
  border-left: 2px solid var(--border-2);
  flex: 1 1 100%;
  margin: 4px 0 0;
}
```

Notes:
- Handoff's `.stale-row` uses `flex-direction: column; gap: 8px` (vertically stacked). Production renders chips + anchor + preview + 4 buttons in a single horizontal row with `flex-wrap: wrap` (the `row gap-2` global on the JSX `<li>` already does this). The hybrid: align row layout in the module class for consistency with the production JSX, and let `.staleDraftRowPreview { flex: 1 1 100% }` push the preview onto its own line below the meta+actions row.
- `.staleDraftRow` does NOT compose the `.row` global at the JSX layer because the JSX already includes `row gap-2`. Module rule provides padding, border, and child-flex behavior the global doesn't supply.

- [ ] **Step 6.3: Wire the module classes in `StaleDraftRow.tsx`**

```tsx
import styles from './StaleDraftRow.module.css';

// …
<li className={`stale-draft-row row gap-2 ${styles.staleDraftRow}`}>
  <span className="chip chip-status-stale">Stale</span>
  <span className={`muted-2 stale-draft-row-anchor ${styles.staleDraftRowAnchor}`}>{anchorLabel}</span>
  <span className={`stale-draft-row-preview ${styles.staleDraftRowPreview}`}>{previewBody(body)}</span>
  {/* 4 buttons unchanged */}
</li>
```

- [ ] **Step 6.4: Run vitest + prettier + lint**

```bash
cd frontend && npm run test -- UnresolvedPanel.test.tsx && npm run prettier --write src/components/PrDetail/Reconciliation && npm run lint
```

- [ ] **Step 6.5: Commit**

```bash
git add frontend/src/components/PrDetail/Reconciliation/StaleDraftRow.module.css frontend/src/components/PrDetail/Reconciliation/StaleDraftRow.tsx frontend/__tests__/UnresolvedPanel.test.tsx
git commit -m "feat(pr5): port StaleDraftRow to CSS module (handoff .stale-row)"
```

---

### Task 7: Author `DraftsTab.module.css` (production-only)

**Files:**
- Create: `frontend/src/components/PrDetail/DraftsTab/DraftsTab.module.css`
- Modify: `frontend/src/components/PrDetail/DraftsTab/DraftsTab.tsx`

- [ ] **Step 7.1: Write the failing vitest test**

```tsx
import styles from '../src/components/PrDetail/DraftsTab/DraftsTab.module.css';

it('AppliesBothLiteralAndModuleClasses_OnDraftsTabRoot', () => {
  renderDraftsTab({ session: mkSession(/*…*/), status: 'loaded' });
  const root = screen.getByTestId('drafts-tab');
  expect(root).toHaveClass('drafts-tab');
  expect(root).toHaveClass(styles.draftsTab);
});
```

- [ ] **Step 7.2: Author the module CSS**

```css
/* DraftsTab — production-only surface (handoff has no Drafts-tab body
   rendering). Layout derived from PR3's overview-card visual language:
   surface-1 background, surface-2 file-group sub-surfaces, comfortable
   vertical rhythm matching Inbox sections. */

.draftsTab {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  padding: var(--s-4) var(--s-6);
}

.draftsTabHeader {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
}

.draftsTabHeaderTitle {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--text-1);
}

.draftsTabBody {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
}

.draftsTabFileGroup {
  background: var(--surface-1);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-3);
  padding: var(--s-3) var(--s-4);
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}

.draftsTabFileHeading {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-2);
  margin: 0 0 var(--s-2);
}
```

- [ ] **Step 7.3: Wire the module classes in `DraftsTab.tsx`**

Both render branches (empty + populated) gain `styles.draftsTab` on the outer `<div>`, and the populated branch's header + body + file-group + file-heading get their `styles.x` composed alongside the existing literal classes. Code:

```tsx
import styles from './DraftsTab.module.css';

// empty branch:
<div className={`drafts-tab ${styles.draftsTab}`} data-testid="drafts-tab">
  <div className={`drafts-tab-header ${styles.draftsTabHeader}`}>
    <span className={`drafts-tab-header-title ${styles.draftsTabHeaderTitle}`}>0 drafts</span>
  </div>
  <DraftListEmpty />
</div>

// populated branch — header:
<div className={`drafts-tab-header row gap-2 ${styles.draftsTabHeader}`}>
  <span className={`drafts-tab-header-title ${styles.draftsTabHeaderTitle}`}>{/* … */}</span>
  {/* chip + DiscardAllStaleButton unchanged */}
</div>

// populated branch — body:
<div className={`drafts-tab-body ${styles.draftsTabBody}`}>
  {groups.map((g) => (<FileGroupSection /*…*/ />))}
</div>

// FileGroupSection (helper inside DraftsTab.tsx):
<section className={`drafts-tab-file-group ${styles.draftsTabFileGroup}`}>
  <h3 className={`drafts-tab-file-heading ${styles.draftsTabFileHeading}`}>{heading}</h3>
  {/* … */}
</section>
```

- [ ] **Step 7.4: Run vitest + prettier + lint + commit**

```bash
cd frontend && npm run test -- DraftsTab.test.tsx && npm run prettier --write src/components/PrDetail/DraftsTab && npm run lint
git add frontend/src/components/PrDetail/DraftsTab/DraftsTab.module.css frontend/src/components/PrDetail/DraftsTab/DraftsTab.tsx frontend/__tests__/DraftsTab.test.tsx
git commit -m "feat(pr5): port DraftsTab outer shell to CSS module"
```

---

### Task 8: Author `DraftListItem.module.css` (production-only, handoff-stale-row visual language; ALSO authors `.chip-status-moved` + `.chip-status-draft` local rules per D47)

> **Test-file note**: `DraftListItem.test.tsx` does NOT exist. Behavior covered by `__tests__/DraftsTab.test.tsx` integration. Add the new assertion inside the existing "RendersDraftsList_WhenSessionHasDrafts" (or equivalent populated-state) test in DraftsTab.test.tsx.

**Files:**
- Create: `frontend/src/components/PrDetail/DraftsTab/DraftListItem.module.css`
- Modify: `frontend/src/components/PrDetail/DraftsTab/DraftListItem.tsx`
- Modify: `frontend/__tests__/DraftsTab.test.tsx`

- [ ] **Step 8.1: Write the failing vitest test**

In `frontend/__tests__/DraftsTab.test.tsx`, inside the existing populated-state test:

```tsx
import itemStyles from '../src/components/PrDetail/DraftsTab/DraftListItem.module.css';

// inside the populated-state render test:
const items = document.querySelectorAll('.draft-list-item');
expect(items.length).toBeGreaterThan(0);
expect(items[0]).toHaveClass(itemStyles.draftListItem);
```

- [ ] **Step 8.2: Author the module CSS**

```css
/* DraftListItem — production-only card-row. Visual language derived from
   handoff `.stale-row` (chips at top, body in middle, actions at bottom).
   Mounted as children of .draftsTabFileGroup.

   Also authors the two single-consumer chip variants per D47 (the literal
   classes are emitted via dynamic interpolation `chip-status-${status.modifier}`
   at DraftListItem.tsx:81; literal-class-and-module pattern means the literal
   in JSX continues to compose AND the .module.css rule applies via Vite's
   CSS-modules injection order). */

.draftListItem {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-3) var(--s-4);
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
}

.draftListItemHeader {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
  font-size: var(--text-xs);
}

.draftListItemPreview {
  font-size: var(--text-sm);
  color: var(--text-1);
  line-height: 1.55;
}

.draftListItemPreview p { margin: 0 0 var(--s-2); }

.draftListItemPreview p:last-child { margin: 0; }

.draftListItemPreview code {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 1px 5px;
  background: var(--surface-3);
  border-radius: 3px;
  color: var(--text-1);
}

.draftListItemActions {
  display: flex;
  gap: var(--s-2);
  justify-content: flex-end;
  flex-wrap: wrap;
}

/* D47: single-consumer chip variants stay LOCAL.
   - moved → warning-soft/warning-fg (matches handoff `pr-detail.jsx:325`).
   - draft → info-soft/info-fg (in-progress state with no urgency). */
:global(.chip-status-moved) { background: var(--warning-soft); color: var(--warning-fg); }
:global(.chip-status-draft) { background: var(--info-soft); color: var(--info-fg); }
```

The `:global(...)` selector wrapping bypasses CSS Modules' hashing for the two literal class names, which is the canonical way to register a global rule from inside a module. The literal `chip-status-moved` / `chip-status-draft` strings in JSX (`DraftListItem.tsx:81` interpolation) match these global rules directly. No styles import needed for these.

- [ ] **Step 8.3: Wire JSX**

```tsx
import styles from './DraftListItem.module.css';

<div className={`draft-list-item ${styles.draftListItem}`}>
  <div className={`draft-list-item-header row gap-2 ${styles.draftListItemHeader}`}>
    {/* chips unchanged */}
  </div>
  <div className={`draft-list-item-preview ${styles.draftListItemPreview}`}>
    <MarkdownRenderer source={previewBody(body)} />
  </div>
  <div className={`draft-list-item-actions row gap-2 ${styles.draftListItemActions}`}>
    {/* buttons unchanged */}
  </div>
  {/* Modal unchanged */}
</div>
```

- [ ] **Step 8.4: Run vitest + prettier + lint + commit**

```bash
cd frontend && npm run test -- DraftsTab.test.tsx && npm run prettier --write src/components/PrDetail/DraftsTab && npm run lint
git add frontend/src/components/PrDetail/DraftsTab/DraftListItem.module.css frontend/src/components/PrDetail/DraftsTab/DraftListItem.tsx frontend/__tests__/DraftsTab.test.tsx
git commit -m "feat(pr5): port DraftListItem to CSS module + local chip-status-moved/-draft"
```

---

### Task 9: Author `DraftListEmpty.module.css` (production-only, mirrors PR4 `.diffPaneEmpty`)

**Files:**
- Create: `frontend/src/components/PrDetail/DraftsTab/DraftListEmpty.module.css`
- Modify: `frontend/src/components/PrDetail/DraftsTab/DraftListEmpty.tsx`

- [ ] **Step 9.1: Write the failing vitest test (if test file exists; otherwise smoke test in DraftsTab.test.tsx)**

```tsx
// in DraftsTab.test.tsx empty-state branch:
import emptyStyles from '../src/components/PrDetail/DraftsTab/DraftListEmpty.module.css';
expect(screen.getByText(/No drafts on this PR yet/i)).toHaveClass(emptyStyles.draftsTabEmpty);
```

- [ ] **Step 9.2: Author the module CSS**

```css
/* DraftListEmpty — production-only. Mirrors PR4 `.diffPaneEmpty` empty-state
   pattern: centered muted text with comfortable min-height. */

.draftsTabEmpty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
  padding: var(--s-4) var(--s-6);
  font-size: var(--text-sm);
  text-align: center;
  text-wrap: pretty;
}
```

- [ ] **Step 9.3: Wire JSX**

```tsx
import styles from './DraftListEmpty.module.css';

export function DraftListEmpty() {
  return (
    <div className={`drafts-tab-empty muted ${styles.draftsTabEmpty}`}>
      No drafts on this PR yet. Open any line in the Files tab to start one.
    </div>
  );
}
```

- [ ] **Step 9.4: Run vitest + prettier + lint + commit**

```bash
cd frontend && npm run test -- DraftsTab.test.tsx && npm run prettier --write src/components/PrDetail/DraftsTab && npm run lint
git add frontend/src/components/PrDetail/DraftsTab/DraftListEmpty.module.css frontend/src/components/PrDetail/DraftsTab/DraftListEmpty.tsx frontend/__tests__/DraftsTab.test.tsx
git commit -m "feat(pr5): port DraftListEmpty to CSS module"
```

---

### Task 10: Author `DraftsTabSkeleton.module.css`

> **Test-file note**: `DraftsTabSkeleton.test.tsx` does NOT exist. Fold the assertion into `DraftsTab.test.tsx`'s existing "RendersLoadingSkeleton_WhilePending" test (line ~89 per the harness peek at plan-time).

**Files:**
- Create: `frontend/src/components/PrDetail/DraftsTab/DraftsTabSkeleton.module.css`
- Modify: `frontend/src/components/PrDetail/DraftsTab/DraftsTabSkeleton.tsx`
- Modify: `frontend/__tests__/DraftsTab.test.tsx`

- [ ] **Step 10.1: Failing test**

In `frontend/__tests__/DraftsTab.test.tsx`, augment the "RendersLoadingSkeleton_WhilePending" test:

```tsx
import skelStyles from '../src/components/PrDetail/DraftsTab/DraftsTabSkeleton.module.css';

// inside RendersLoadingSkeleton_WhilePending:
expect(screen.getByTestId('drafts-tab-skeleton')).toHaveClass(skelStyles.draftsTabSkeleton);
```

- [ ] **Step 10.2: Author the module CSS**

```css
/* DraftsTabSkeleton — production-only loading placeholder. Mirrors PR4
   FilesTab skeleton pattern. The `.skeleton-row` global already lives in
   tokens.css from an earlier slice; this module only supplies layout. */

.draftsTabSkeleton {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding: var(--s-4) var(--s-6);
}

.draftsTabSkeletonHeader {
  width: 240px;
  max-width: 50%;
  height: 24px;
}
```

- [ ] **Step 10.3: Wire JSX**

```tsx
import styles from './DraftsTabSkeleton.module.css';

export function DraftsTabSkeleton() {
  return (
    <div
      className={`drafts-tab-skeleton ${styles.draftsTabSkeleton}`}
      data-testid="drafts-tab-skeleton"
      aria-busy="true"
    >
      <div className={`drafts-tab-skeleton-header skeleton-row ${styles.draftsTabSkeletonHeader}`} />
      <div className="skeleton-row" />
      <div className="skeleton-row" />
      <div className="skeleton-row" />
    </div>
  );
}
```

- [ ] **Step 10.4: Run vitest + prettier + lint + commit**

```bash
cd frontend && npm run test -- DraftsTab.test.tsx && npm run prettier --write src/components/PrDetail/DraftsTab && npm run lint
git add frontend/src/components/PrDetail/DraftsTab/DraftsTabSkeleton.module.css frontend/src/components/PrDetail/DraftsTab/DraftsTabSkeleton.tsx frontend/__tests__/DraftsTab.test.tsx
git commit -m "feat(pr5): port DraftsTabSkeleton to CSS module"
```

---

### Task 11: Author `DraftsTabError.module.css`

> **Test-file note**: `DraftsTabError.test.tsx` does NOT exist. Fold the assertion into `DraftsTab.test.tsx`'s existing error-branch test (likely "RendersError_WhenStatusIsError" or similar — confirm in Task 1 pre-flight).

**Files:**
- Create: `frontend/src/components/PrDetail/DraftsTab/DraftsTabError.module.css`
- Modify: `frontend/src/components/PrDetail/DraftsTab/DraftsTabError.tsx`
- Modify: `frontend/__tests__/DraftsTab.test.tsx`

- [ ] **Step 11.1: Failing test**

In `frontend/__tests__/DraftsTab.test.tsx`, augment the error-branch test:

```tsx
import errStyles from '../src/components/PrDetail/DraftsTab/DraftsTabError.module.css';

// inside the error-branch test:
expect(screen.getByRole('alert')).toHaveClass(errStyles.draftsTabError);
```

- [ ] **Step 11.2: Author the module CSS**

```css
/* DraftsTabError — production-only error state. Mirrors DraftListEmpty
   spacing and adds a centered Retry button. */

.draftsTabError {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--s-3);
  min-height: 160px;
  padding: var(--s-4) var(--s-6);
  font-size: var(--text-sm);
  color: var(--text-2);
  text-align: center;
}
```

- [ ] **Step 11.3: Wire JSX**

```tsx
import styles from './DraftsTabError.module.css';

export function DraftsTabError({ onRetry }: DraftsTabErrorProps) {
  return (
    <div className={`drafts-tab-error ${styles.draftsTabError}`} role="alert">
      <p>Couldn't load drafts.</p>
      <button type="button" className="btn btn-secondary" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
```

- [ ] **Step 11.4: Run vitest + prettier + lint + commit**

```bash
cd frontend && npm run test -- DraftsTab.test.tsx && npm run prettier --write src/components/PrDetail/DraftsTab && npm run lint
git add frontend/src/components/PrDetail/DraftsTab/DraftsTabError.module.css frontend/src/components/PrDetail/DraftsTab/DraftsTabError.tsx frontend/__tests__/DraftsTab.test.tsx
git commit -m "feat(pr5): port DraftsTabError to CSS module"
```

---

### Task 12: Author `DiscardAllStaleButton.module.css` (modal-content rules only, per D51)

> **Test-file note**: `DiscardAllStaleButton.test.tsx` does NOT exist (the repo has `DiscardAllDraftsButton.test.tsx` for a different component). Component behavior is integration-covered by `DraftsTab.test.tsx`. Fold the assertion into a DraftsTab.test.tsx test that mounts populated stale drafts and clicks "Discard all stale" to open the modal.

**Files:**
- Create: `frontend/src/components/PrDetail/DraftsTab/DiscardAllStaleButton.module.css`
- Modify: `frontend/src/components/PrDetail/DraftsTab/DiscardAllStaleButton.tsx`
- Modify: `frontend/__tests__/DraftsTab.test.tsx`

- [ ] **Step 12.1: Failing test**

In `frontend/__tests__/DraftsTab.test.tsx`, add a new test (or augment an existing populated-state test) that opens the Discard-all modal and asserts the preview list's class:

```tsx
import discardStyles from '../src/components/PrDetail/DraftsTab/DiscardAllStaleButton.module.css';
import userEvent from '@testing-library/user-event';

it('DiscardAllStaleModal_AppliesModuleClasses_OnPreviewList', async () => {
  // render DraftsTab with ≥1 stale draft in session
  renderDraftsTab({
    session: mkSession({ draftComments: [mkComment({ status: 'stale' })] }),
    status: 'loaded',
  });
  await userEvent.click(screen.getByRole('button', { name: /Discard all stale/i }));
  // Modal mounts a single <ul> inside the dialog — getByRole('list') resolves to it.
  expect(screen.getByRole('list')).toHaveClass(discardStyles.discardAllPreviewList);
});
```

The `userEvent.click()` is the critical step — without opening the modal, the `<ul>` doesn't render. Task 12 step 12.1 in the original draft missed this prerequisite.

- [ ] **Step 12.2: Author the module CSS**

```css
/* DiscardAllStaleButton modal-content rules. Trigger button uses
   .btn .btn-danger .btn-sm globals — no extra rule (D51). */

.discardAllPreviewList {
  list-style: none;
  margin: var(--s-3) 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}

.discardAllPreviewList li {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.discardAllPreviewBody {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  margin: 0;
  padding: var(--s-2) var(--s-3);
  background: var(--surface-3);
  border-radius: var(--radius-2);
  color: var(--text-1);
  white-space: pre-wrap;
}

.discardAllError {
  color: var(--danger-fg);
  background: var(--danger-soft);
  border-radius: var(--radius-2);
  padding: var(--s-2) var(--s-3);
  margin: 0;
  font-size: var(--text-sm);
}
```

- [ ] **Step 12.3: Wire JSX**

```tsx
import styles from './DiscardAllStaleButton.module.css';

// inside the Modal:
{failedCount > 0 && (
  <p role="alert" className={`discard-all-error ${styles.discardAllError}`}>
    {/* … */}
  </p>
)}
<ul className={`discard-all-preview-list ${styles.discardAllPreviewList}`}>
  {previews.map((p) => (
    <li key={p.id}>
      <span className="muted-2">{p.label}</span>
      <pre className={`discard-all-preview-body ${styles.discardAllPreviewBody}`}>{p.body}</pre>
    </li>
  ))}
</ul>
```

- [ ] **Step 12.4: Run vitest + prettier + lint + commit**

```bash
cd frontend && npm run test -- DraftsTab.test.tsx && npm run prettier --write src/components/PrDetail/DraftsTab && npm run lint
git add frontend/src/components/PrDetail/DraftsTab/DiscardAllStaleButton.module.css frontend/src/components/PrDetail/DraftsTab/DiscardAllStaleButton.tsx frontend/__tests__/DraftsTab.test.tsx
git commit -m "feat(pr5): port DiscardAllStaleButton modal content to CSS module"
```

---

### Task 12.5: Split-checkpoint (per D54 / PR4 D42 precedent)

**Files:**
- Read-only / decision step.

- [ ] **Step 12.5.1: Measure current CSS LOC**

```bash
cd D:/src/PRism-design-parity-pr5
git diff $(git merge-base HEAD main) --stat -- "*.module.css" "frontend/src/styles/tokens.css"
```

`git merge-base HEAD main` resolves to the actual divergence point so the count isn't sensitive to local `main` drift (e.g., sibling PRs merged after the worktree was created). Sum the lines-added column for module.css files + tokens.css.

- [ ] **Step 12.5.2: Count review-meaningful changes**

Tally per Tasks 1-12: tokens.css lift (1), UnresolvedPanel + StaleDraftRow (handoff-derived, 2), DraftsTab + DraftListItem + DraftListEmpty + DraftsTabSkeleton + DraftsTabError + DiscardAllStaleButton (production-only, 6). Total ≈ 9.

- [ ] **Step 12.5.3: Decide**

- If CSS LOC ≥ 600 AND review-meaningful ≥ 8 → SPLIT into PR5a (Tasks 1-6 + 15-21 baseline + checklist) + PR5b (Tasks 7-14 + their baselines).
- Otherwise → continue SINGLE-PR5.
- Document the decision as a deferrals-sidecar entry (D54 closure) at Task 21 Step 21.1.

If SPLIT: stop here, finish PR5a tasks (skip 7-14, run 15-21 with PR5a scope only), then start PR5b in a new worktree branched from PR5a.

If SINGLE: continue with Task 13.

---

### Task 13: Author `ForeignPendingReviewModal.module.css` (production-only BEM, D50)

**Files:**
- Create: `frontend/src/components/PrDetail/ForeignPendingReviewModal/ForeignPendingReviewModal.module.css`
- Modify: `frontend/src/components/PrDetail/ForeignPendingReviewModal/ForeignPendingReviewModal.tsx`

- [ ] **Step 13.1: Failing test**

In `frontend/__tests__/ForeignPendingReviewModal.test.tsx`, assert both literal `.foreign-prr-modal` and `styles.foreignPrrModal` land on the outer div:

```tsx
import styles from '../src/components/PrDetail/ForeignPendingReviewModal/ForeignPendingReviewModal.module.css';

it('AppliesBothLiteralAndModuleClasses_OnModalBody', () => {
  render(<ForeignPendingReviewModal /*…*/ />);
  const body = document.querySelector('.foreign-prr-modal');
  expect(body).toHaveClass(styles.foreignPrrModal);
});
```

- [ ] **Step 13.2: Author the module CSS**

```css
/* ForeignPendingReviewModal — production-only. The shared <Modal>
   component supplies backdrop + focus trap. This module supplies the
   body + footer layout for the foreign-pending-review prompt. */

.foreignPrrModal {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}

.foreignPrrModalBody {
  font-size: var(--text-sm);
  color: var(--text-1);
  line-height: 1.55;
  text-wrap: pretty;
  margin: 0;
}

.foreignPrrModalBody strong { color: var(--text-1); font-weight: 600; }

.foreignPrrModalFooter {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  flex-wrap: wrap;
}
```

- [ ] **Step 13.3: Wire JSX**

```tsx
import styles from './ForeignPendingReviewModal.module.css';

<div className={`foreign-prr-modal ${styles.foreignPrrModal}`}>
  <p className={`foreign-prr-modal__body ${styles.foreignPrrModalBody}`}>
    {/* unchanged */}
  </p>
  <footer className={`foreign-prr-modal__footer ${styles.foreignPrrModalFooter}`}>
    {/* unchanged */}
  </footer>
</div>
```

- [ ] **Step 13.4: Run vitest + prettier + lint + commit**

```bash
cd frontend && npm run test -- ForeignPendingReviewModal && npm run prettier --write src/components/PrDetail/ForeignPendingReviewModal && npm run lint
git add frontend/src/components/PrDetail/ForeignPendingReviewModal/ForeignPendingReviewModal.module.css frontend/src/components/PrDetail/ForeignPendingReviewModal/ForeignPendingReviewModal.tsx frontend/__tests__/ForeignPendingReviewModal.test.tsx
git commit -m "feat(pr5): port ForeignPendingReviewModal to CSS module"
```

---

### Task 14: Author `DiscardConfirmationSubModal.module.css` (production-only BEM, D50)

> **Test-file note**: `DiscardConfirmationSubModal.test.tsx` does NOT exist. The sub-modal is mounted from inside `ForeignPendingReviewModal`. Fold the assertion into `ForeignPendingReviewModal.test.tsx`'s existing test that clicks "Discard…" to open the sub-modal.

**Files:**
- Create: `frontend/src/components/PrDetail/ForeignPendingReviewModal/DiscardConfirmationSubModal.module.css`
- Modify: `frontend/src/components/PrDetail/ForeignPendingReviewModal/DiscardConfirmationSubModal.tsx`
- Modify: `frontend/__tests__/ForeignPendingReviewModal.test.tsx`

- [ ] **Step 14.1: Failing test**

In `frontend/__tests__/ForeignPendingReviewModal.test.tsx`, augment (or add) a test that opens the discard sub-modal:

```tsx
import subStyles from '../src/components/PrDetail/ForeignPendingReviewModal/DiscardConfirmationSubModal.module.css';
import userEvent from '@testing-library/user-event';

it('DiscardSubModal_AppliesBothLiteralAndModuleClasses', async () => {
  // render ForeignPendingReviewModal with open=true
  // click "Discard…" → sub-modal mounts
  await userEvent.click(screen.getByRole('button', { name: /Discard…/i }));
  const subModalBody = document.querySelector('.discard-confirmation-sub-modal');
  expect(subModalBody).toHaveClass(subStyles.discardConfirmationSubModal);
});
```

- [ ] **Step 14.2: Author the module CSS**

```css
/* DiscardConfirmationSubModal — production-only. Destructive second-tier
   confirmation. Mounted by ForeignPendingReviewModal when Discard is chosen. */

.discardConfirmationSubModal {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}

.discardConfirmationSubModal p {
  font-size: var(--text-sm);
  color: var(--text-1);
  line-height: 1.55;
  margin: 0;
}

.discardConfirmationSubModalFooter {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  flex-wrap: wrap;
}
```

- [ ] **Step 14.3: Wire JSX**

```tsx
import styles from './DiscardConfirmationSubModal.module.css';

<div className={`discard-confirmation-sub-modal ${styles.discardConfirmationSubModal}`}>
  <p>{/* unchanged */}</p>
  <footer className={`discard-confirmation-sub-modal__footer ${styles.discardConfirmationSubModalFooter}`}>
    {/* unchanged */}
  </footer>
</div>
```

- [ ] **Step 14.4: Run vitest + prettier + lint + commit**

```bash
cd frontend && npm run test -- ForeignPendingReviewModal.test.tsx && npm run prettier --write src/components/PrDetail/ForeignPendingReviewModal && npm run lint
git add frontend/src/components/PrDetail/ForeignPendingReviewModal/DiscardConfirmationSubModal.module.css frontend/src/components/PrDetail/ForeignPendingReviewModal/DiscardConfirmationSubModal.tsx frontend/__tests__/ForeignPendingReviewModal.test.tsx
git commit -m "feat(pr5): port DiscardConfirmationSubModal to CSS module"
```

---

### Task 15: Test-selector audit (skip-if-empty)

Task 1 Step 1.1's pre-flight grep already enumerates every literal-class consumer; if that grep surfaced nothing requiring migration, **skip this task entirely** and proceed to Task 16. Only execute the steps below if Task 1.1's catalog identified a hit whose semantics PR5 actually changed (i.e., a class that's now hashed and has no compensating literal-class-and-module pattern in the JSX).

- [ ] **Step 15.1: Decision check**

Review Task 1.1's pre-flight catalog. If only the expected `s4-keep-anyway-survives-reload.spec.ts:82` (`.chip.chip-override` literal) appears and stays as-is per D47, this task closes with no work. Document the no-op in the Task 21 deferrals sidecar append as a one-line note.

- [ ] **Step 15.2: If migrations are required**

For each affected file, migrate to `data-testid` queries or `styles.x` imports. Commit:

```bash
git add <migrated files>
git commit -m "test(pr5): migrate <N> test selectors for module-CSS rename"
```

---

### Task 16: Local validation pass — vitest + dotnet test + build

**Files:**
- No edits; verification only.

- [ ] **Step 16.1: Run full vitest**

```bash
cd frontend && npm test
```

Expected: all PASS. Capture pass count for the final report.

- [ ] **Step 16.2: Run frontend build**

```bash
cd frontend && npm run build
```

Expected: zero errors. Verify bundle size + chunk count don't materially regress (spec §6.7 sanity).

- [ ] **Step 16.3: Run frontend lint**

```bash
cd frontend && npm run lint
```

Expected: zero errors / zero new warnings.

- [ ] **Step 16.4: Run dotnet build (Release) + dotnet test**

```bash
dotnet build --configuration Release
dotnet test --no-build --configuration Release
```

Expected: PR5 makes no backend changes, so dotnet test should pass unchanged. Capture pass count.

Note: per the user's standing rule, run only one long-running build/test at a time, foreground, ≥300000ms timeout.

- [ ] **Step 16.5: If any step fails, fix in place and re-run before moving on**

Do NOT proceed to Task 17 until all four steps pass.

---

### Task 17: Local Playwright spec sanity — drafts tab + reconciliation panel render under PR5 module styles

**Files:**
- No edits; verification only.

- [ ] **Step 17.1: Boot dev backend**

```bash
$env:PRISM_E2E_FAKE_REVIEW=1; dotnet run --project PRism.Web --launch-profile dev-test
```

Run in background; wait for "Now listening on http://localhost:5180" line.

- [ ] **Step 17.2: Run the four most representative Playwright specs that exercise PR5 surfaces**

```bash
cd frontend && npx playwright test s4-keep-anyway-survives-reload s4-drafts-survive-restart s5-submit-foreign-pending-review --reporter=line
```

Expected: PASS. The `chip-override` literal lookup at `s4-keep-anyway-survives-reload.spec.ts:82` exercises the tokens.css lift; pre-existing literal class assertions stay green because the JSX still composes the literal.

- [ ] **Step 17.3: If any flake, retry per project convention**

Windows CI flakes on retry-0 setup-form-fill are documented in PR1 D5. Local retry-1 typically clears. Document any failure that doesn't clear under D44+1 (new deferral entry).

- [ ] **Step 17.4: Tear down backend, no commit**

---

### Task 18: Author `setupAndOpenHandoffParityFixtureWithStaleDraft` helper (D53) + add `pr-detail-reconciliation-panel` test definition

> **Sequencing note**: this task ships FIRST per the sequencing-correction note (above the task list). The helper's name is referenced by Task 2.3 (drafts-test helper swap) and Task 3.3-erstwhile (now folded here). Without Task 18 first, Tasks 2 and 3's Playwright references won't compile.

**Files:**
- Modify: `frontend/e2e/helpers/parity-fixture.ts` (add the new exported helper alongside the existing `setupAndOpenHandoffParityFixture`)
- Modify: `frontend/e2e/parity-baselines.spec.ts` (replace the comment block at lines 179-184 with the new reconciliation-panel test definition; import the new helper)

- [ ] **Step 18.1: Read the existing helper file to follow its shape**

```bash
cat frontend/e2e/helpers/parity-fixture.ts
```

- [ ] **Step 18.2: Author the new helper**

```typescript
// frontend/e2e/helpers/parity-fixture.ts (append)
import type { Page } from '@playwright/test';
import { setupAndOpenScenarioPr, advanceHead, reloadPr } from './s4-setup';

/**
 * Loads the scenario PR (acme/api/123 per PR1 D1), saves a draft on Calc.cs
 * line 3 via the composer, then advances head to invalidate the anchor →
 * draft re-classifies Stale → UnresolvedPanel mounts with one row.
 *
 * Used by the pr-detail-reconciliation-panel + pr-detail-drafts parity
 * baselines (PR5).
 */
export async function setupAndOpenHandoffParityFixtureWithStaleDraft(page: Page): Promise<void> {
  await setupAndOpenScenarioPr(page);
  // Navigate to the Files tab and the canonical scenario file.
  await page.goto('/pr/acme/api/123/files');
  await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();
  await page.getByRole('button', { name: /add comment on line 3/i }).click();

  const savePromise = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/pr/acme/api/123/draft') &&
      r.request().method() === 'PUT' &&
      r.status() === 200,
    { timeout: 10_000 },
  );
  await page.getByRole('textbox', { name: /comment body/i }).fill('parity baseline draft');
  await savePromise;

  // Advance head to invalidate the anchor line → draft becomes Stale.
  const newHeadSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  await advanceHead(page, newHeadSha, [
    {
      path: 'src/Calc.cs',
      content:
        'namespace Acme;\npublic static class Calc {\n  public static int Sub(int a, int b) => a - b;\n}\n',
    },
  ]);
  await reloadPr(page, { owner: 'acme', repo: 'api', number: 123 }, newHeadSha);
  await page.reload();
}
```

- [ ] **Step 18.3: Add the `pr-detail-reconciliation-panel` test definition**

Replace the comment block at `parity-baselines.spec.ts:179-184` with:

```tsx
test('pr-detail-reconciliation-panel', async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await setupAndOpenHandoffParityFixtureWithStaleDraft(page);
  const panel = page.locator('[data-testid="unresolved-panel"]');
  await panel.waitFor();
  await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
  await expect(panel).toHaveScreenshot('pr-detail-reconciliation-panel.png', SCREENSHOT_OPTS);
});
```

Update the import line at the top of the file to:

```tsx
import {
  setupAndOpenHandoffParityFixture,
  setupAndOpenHandoffParityFixtureWithStaleDraft,
} from './helpers/parity-fixture';
```

(Note: `setupAndOpenHandoffParityFixture` is still used by the four pre-PR5 PR Detail tests at lines 127, 137, 147, 158.)

The test will FAIL at the locator-wait against `[data-testid="unresolved-panel"]` until Task 3 lands that testid. That's expected; Task 3 commits before the test runs greenly.

- [ ] **Step 18.4: Run prettier + commit**

```bash
cd frontend && npm run prettier --write e2e/helpers/parity-fixture.ts e2e/parity-baselines.spec.ts
git add frontend/e2e/helpers/parity-fixture.ts frontend/e2e/parity-baselines.spec.ts
git commit -m "test(pr5): add stale-draft parity helper + reconciliation-panel test definition"
```

---

### Task 19: Capture `pr-detail-drafts` baseline

**Files:**
- Modify: `frontend/e2e/__screenshots__/win32/pr-detail-drafts.png` (NEW binary asset).

- [ ] **Step 19.1: Boot dev backend (if not already)**

```bash
$env:PRISM_E2E_FAKE_REVIEW=1; dotnet run --project PRism.Web --launch-profile dev-test
```

- [ ] **Step 19.2: Capture the baseline**

```bash
cd frontend && npx playwright test parity-baselines.spec.ts --grep "pr-detail-drafts" --update-snapshots --reporter=line
```

Expected: the PNG lands at `frontend/e2e/__screenshots__/win32/parity-baselines.spec.ts/pr-detail-drafts.png`. Inspect visually — the Drafts tab should show: header chip ("1 draft on 1 file" + "1 stale" chip + "Discard all stale (1)" button), one DraftsTabFileGroup ("src/Calc.cs" heading), one DraftListItem (stale chip + line 3 + preview "parity baseline draft" + Edit/Delete buttons).

- [ ] **Step 19.3: Verify reproducibility**

Re-run without `--update-snapshots`:

```bash
cd frontend && npx playwright test parity-baselines.spec.ts --grep "pr-detail-drafts" --reporter=line
```

Expected: PASS (no diff).

- [ ] **Step 19.4: Commit**

```bash
git add frontend/e2e/__screenshots__/win32/parity-baselines.spec.ts/pr-detail-drafts.png
git commit -m "test(pr5): capture pr-detail-drafts parity baseline"
```

---

### Task 20: Capture `pr-detail-reconciliation-panel` baseline (PR1 D2 close — part 2)

**Files:**
- Modify: `frontend/e2e/__screenshots__/win32/parity-baselines.spec.ts/pr-detail-reconciliation-panel.png` (NEW binary asset).

- [ ] **Step 20.1: Capture**

```bash
cd frontend && npx playwright test parity-baselines.spec.ts --grep "pr-detail-reconciliation-panel" --update-snapshots --reporter=line
```

Expected: PNG of the warning-tinted UnresolvedPanel with the summary header ("1 draft needs attention") + one StaleDraftRow (Stale chip + "src/Calc.cs:3" anchor + preview "parity baseline draft" + 4 action buttons).

- [ ] **Step 20.2: Verify reproducibility**

```bash
cd frontend && npx playwright test parity-baselines.spec.ts --grep "pr-detail-reconciliation-panel" --reporter=line
```

Expected: PASS.

- [ ] **Step 20.3: Commit**

```bash
git add frontend/e2e/__screenshots__/win32/parity-baselines.spec.ts/pr-detail-reconciliation-panel.png
git commit -m "test(pr5): capture pr-detail-reconciliation-panel baseline (closes PR1 D2)"
```

---

### Task 21: Append deferrals (D46-D54) + pre-push checklist

**Files:**
- Modify: `docs/specs/2026-05-29-design-parity-recovery-deferrals.md` (append PR5 section + D46-D54)

- [ ] **Step 21.1: Append PR5 section + deferrals**

Append after the PR4 section. Each deferral mirrors the existing entry shape (Date / Spec position / Reality / Plan resolution / Status / Cross-refs). Use the plan-time decisions table at the top of THIS plan as the canonical source.

D46 — UnresolvedPanel + StaleDraftRow are the only handoff-derived PR5 components.
D47 — `chip-status-stale` + `chip-override` lifted to tokens.css; `chip-status-moved` + `chip-status-draft` stay local to DraftListItem.module.css via `:global(...)`.
D48 — Stale-row AI suggestion deferred to PR9.
D49 — PR1 D2 closed (testid + reconciliation-panel baseline captured).
D50 — BEM-shaped class names port as literal-class-and-module.
D51 — DiscardAllStaleButton.module.css authors modal-content rules only.
D52 — `.verdictReconfirmRow` stays in UnresolvedPanel.module.css (single consumer).
D53 — `setupAndOpenHandoffParityFixtureWithStaleDraft` helper authored in parity-fixture.ts.
D54 — PR5 split-checkpoint decision (record SINGLE or SPLIT outcome from Task 12.5).
D55 — StaleDraftRow row-vs-column layout deviation from handoff (production keeps `row gap-2` global; preview pushed to next line via `flex: 1 1 100%`).
D56 — StaleDraftRow's "Delete" button label stays "Delete" (NOT "Discard" per handoff); §2.2 forbids text content rename for parity slices; PR9 revisit owns the copy adjudication.
D57 — UnresolvedPanel sticky-top implemented via `position: sticky; top: 0; z-index: 1` on `.unresolvedPanel`; sticky against the viewport since no inner scroll container exists at PrDetailPage today; future layout changes carry the rule forward against whatever ancestor with non-`visible` overflow emerges.

- [ ] **Step 21.2: Pre-push checklist verbatim per `.ai/docs/development-process.md`**

Even if Task 16 + Task 17 already covered most of it, the pre-push runs the FULL checklist fresh as documented. Execute:

```bash
# From the worktree root
cd frontend && npm run lint && npm run build && npm test
# Then from the worktree root:
dotnet build --configuration Release
dotnet test --no-build --configuration Release
# Then Playwright (the full PR5-touched set):
cd frontend && npx playwright test parity-baselines s4-keep-anyway-survives-reload s4-drafts-survive-restart s5-submit-foreign-pending-review --reporter=line
```

Expected: zero failures. Capture pass counts + any flake retries for the PR description.

- [ ] **Step 21.3: Commit the deferrals append**

```bash
git add docs/specs/2026-05-29-design-parity-recovery-deferrals.md
git commit -m "docs(pr5): append D46-D54 deferrals sidecar entries"
```

---

### Task 22: ce-doc-review handoff + pr-autopilot

**Files:**
- No code edits at this step.

- [ ] **Step 22.1: Hand off to ce-doc-review**

This task is performed by the orchestrator (NOT the implementer subagent) after Task 21 lands. Per CLAUDE.md, the plan invokes `compound-engineering:ce-doc-review` in headless mode on the PR5 plan before the user-review pass, applies findings via `superpowers:receiving-code-review` rigor, surfaces every finding with applied/deferred/skipped + one-line reason, and waits for explicit user go-ahead.

The plan-doc-review step happened during plan authoring; this task entry is the implementation-time review trigger that runs against the diff at PR-open time (handled by pr-autopilot Phase 1 preflight + Phase 3 comment loop).

- [ ] **Step 22.2: Open PR via pr-autopilot**

```bash
# Orchestrator invokes pr-autopilot with iteration cap 10:
/pr-autopilot 10
```

pr-autopilot drives: preflight review (Phase 1), spec alignment check (Phase 1.3), `gh pr create` (Phase 2), comment loop (Phase 3), CI gate (Phase 4), final report (Phase 5).

PR description includes:
- Closes PR1 D2.
- Lists tokens.css lift (D47) + the 9 deferrals.
- Side-by-side screenshots: handoff `StaleDraftPanel` left vs production UnresolvedPanel + Drafts tab right (per spec §4.1.4).
- Pre-push pass counts.

- [ ] **Step 22.3: Watch for review findings**

Standard pr-autopilot loop. Worktree + branch cleaned at merge.

---

## Self-review

After writing the complete plan, looking at the spec with fresh eyes:

**1. Spec coverage check:** Spec §4.5 lists exactly the 10 components in this plan; all 10 receive module CSS. Restored visuals (drafts-by-file grouping with file headings → Task 7; stale-draft row presentation → Task 6; severity chips → Task 4 lift; AI-suggestion chip → deferred per D48 / spec §6.4 contract; sticky-top reconciliation surface → Task 5; foreign-pending-review modal flow → Tasks 13 + 14). Side-by-side capture targets (Drafts tab zone → Task 19; reconciliation-panel zone → Task 20). Spec §4.1.3 zone list `pr-detail-drafts` + `pr-detail-reconciliation-panel` both un-fixmed + captured. PR1 D2 deferred work explicitly closed.

**2. Placeholder scan:** Searched the plan for "TBD" / "TODO" / "implement later" / "fill in details" / "Add appropriate error handling" / "Add validation" / "handle edge cases" / "Write tests for the above" / "Similar to Task N" / abstract code references → none present. Every step contains exact paths, exact code snippets, exact commands, exact expected outputs.

**3. Type consistency:** `styles.unresolvedPanel` / `styles.staleDraftRow` / `styles.draftsTab` / `styles.draftListItem` / `styles.draftListEmpty` / `styles.draftsTabSkeleton` / `styles.draftsTabError` / `styles.discardAllPreviewList` / `styles.foreignPrrModal` / `styles.discardConfirmationSubModal` — consistent across Tasks 5-14. Literal class names (`unresolved-panel`, `stale-draft-row`, etc.) used as JSX test seams — consistent across all tasks. Helper name `setupAndOpenHandoffParityFixtureWithStaleDraft` consistent between Task 3.3, Task 18.2, Task 18.3, Task 18.4.

**4. Granularity check:** Each task contains 4-6 bite-sized steps. The longest task (Task 5) has 6 steps; the smallest (Task 12.5 split-checkpoint) has 3. All steps are 2-5 minutes of work each.

**5. Test-first discipline:** Every component task (5-14) starts with "Step N.1: Write the failing test" and follows the canonical red → green → commit cycle. Tasks 4 (tokens.css lift) and 19-20 (baseline captures) are visual-regression-tested via the parity baselines themselves.

**6. Plan deviations are visible.** D46-D54 are documented at the top of the plan AND get appended to the deferrals sidecar at Task 21.

---

## Open Questions

None. All plan-time decisions are explicit (D46-D54).

---

## Execution handoff

Plan complete. Execution options:

**1. Subagent-Driven (recommended)** — fresh implementer subagent per task + two-stage review (spec compliance → code quality) per Tasks 1-21. Task 22 is orchestrator-driven post-implementation.

**2. Inline execution** — `superpowers:executing-plans` walks the tasks in-session with batch checkpoints.

Subagent-Driven is the established pattern for the design-parity-recovery roadmap (used for PR2/PR3/PR4) and is the right default.
