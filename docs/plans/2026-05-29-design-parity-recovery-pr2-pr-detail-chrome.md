# PR2 — PR Detail chrome restoration (CSS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `design/handoff/screens.css` rules for `PrHeader` + `PrSubTabStrip` into colocated CSS modules; author module CSS for `BannerRefresh` + `CrossTabPresenceBanner` + `ImportedDraftsBanner` (no handoff source — coherence-only); migrate 5 vitest/Playwright specs off classname selectors; un-`fixme` and capture the `pr-detail-header` viewport baseline.

**Architecture:** Approach 3 hybrid per spec §3 — component-specific layouts in colocated `.module.css` files (camelCase class names), `tokens.css` primitives reused as-is (`.row`, `.col`, `.gap-*`, `.chip`, `.btn*`, `.banner`, `.banner-warning`, `.muted-2`, `.sr-only`). State modifiers stay as separate camelCase classes (`isActive`, `isDisabled`) per spec §3.1.

**Tech Stack:** React 19 + TypeScript 5.9 + Vite 7.1 (CSS modules transformed at build), Vitest 3.2 + Testing Library, Playwright 1.56 (`@playwright/test`), .NET 10 backend untouched.

**Origin:** [`docs/specs/2026-05-29-design-parity-recovery-design.md`](../specs/2026-05-29-design-parity-recovery-design.md) §4.2 (PR2 scope) + §6.1 (test-selector mitigation) + §6.2 (dormant attributes) + §6.3 (Header layout repositioning).

---

## Deviations from spec (read before starting)

The spec §4.2 calls for "Module CSS for: `PrHeader`, `PrSubTabStrip`, `BannerRefresh`, `CrossTabPresenceBanner`, `ImportedDraftsBanner`." Six implementation-level adjustments surfaced during planning. The first changes the *character* of the work for 3 of the 5 components; the remaining five are smaller in scope but all must be visible up front, not buried in the work log.

| Item | Spec position | Plan position | Reason |
|------|---------------|---------------|--------|
| BannerRefresh, CrossTabPresenceBanner, ImportedDraftsBanner CSS source | "Module CSS for ... `BannerRefresh`, `CrossTabPresenceBanner`, `ImportedDraftsBanner`" — implies handoff source | **No-handoff-CSS carve-out.** Handoff `screens.css` and `*.jsx` files contain **zero** rules or markup for `banner-refresh*`, `cross-tab-presence-banner*`, `imported-drafts-banner*`. Handoff's update-banner equivalent uses bare `.banner` (`tokens.css:422` — already ported). Plan ports BannerRefresh's outer wrapper to compose with the existing `.banner` global so it inherits info-tint, padding, and bottom border; module CSS adds only the Action-group layout the global doesn't cover. CrossTabPresenceBanner does the same. ImportedDraftsBanner already composes `.banner-warning`; module CSS adds only the multi-paragraph spacing inside. | Spec lists in scope; handoff has no source. Coherence with restored Header/Tabs achieved via composition. Logged in [`deferrals-sidecar`](../specs/2026-05-29-design-parity-recovery-deferrals.md) under PR2 → D6. |
| ImportedDraftsBanner module CSS path | Spec §3.2 lists `PrDetail/ImportedDraftsBanner.tsx + ImportedDraftsBanner.module.css` at the PrDetail top level | On-disk file lives at `frontend/src/components/PrDetail/ForeignPendingReviewModal/ImportedDraftsBanner.tsx`. Plan colocates the module CSS next to the actual file: `ForeignPendingReviewModal/ImportedDraftsBanner.module.css`. No file move. | Spec §3.2 file layout was speculative; on-disk path is the historical truth. Logged in [`deferrals-sidecar`](../specs/2026-05-29-design-parity-recovery-deferrals.md) under PR2 → D7. |
| `.btn-link` CSS rule | Spec §3.1 lists `.btn*` as already-in-`tokens.css` global primitives | `.btn-link` is used at `CrossTabPresenceBanner.tsx:56` but is NOT defined in `tokens.css` or any module. Plan adds a minimal `.btn-link` rule to `tokens.css` alongside the existing `.btn-secondary`/`.btn-icon` block. Single-consumer today, but it's a button variant — `tokens.css` is its semantic home. | Latent CSS gap surfaced by PR2; fix in the same slice. Logged in [`deferrals-sidecar`](../specs/2026-05-29-design-parity-recovery-deferrals.md) under PR2 → D8. |
| Dormant hook classes (`.is-disabled` on `.pr-tab`, `.pr-subtitle-author`, `.pr-subtitle-branch`, `.pr-meta-repo`) | Spec §6.2 says port dormant rules as-is for state attributes | These are JSX classnames with **no** rules in `screens.css` (not unset *attributes*, no unset *classes*). Plan does NOT author dormant rules for them — they become module no-ops. JSX composition can either keep the bare class as a no-op (preferred — preserves the hook) or drop it; plan keeps them as bare classes so future styling has an anchor. The `.is-disabled` modifier on `pr-tab` is a real state hook used today; plan authors a minimal `opacity: 0.5; pointer-events: none; cursor: not-allowed;` for it. | Honest about which dormant classes have semantic intent vs which are debris. Logged in [`deferrals-sidecar`](../specs/2026-05-29-design-parity-recovery-deferrals.md) under PR2 → D9. |
| Test-selector strategy | Spec §6.1 says "rename these selectors when the `.pr-tab-count` class moves" | Plan migrates the 5 test files to `data-testid` selectors (`data-testid="pr-tab-count"`, `data-testid="pr-title"`) rather than to hashed-module-class regex. Per spec §4.1.3 "data-testid queries (the preferred selector form)" — switching now removes the brittle class-rename coupling for future PRs in this roadmap. PR2 adds the two `data-testid` attributes to the JSX. | Cleaner long-term selector hygiene; the `data-testid` additions are a narrow scope addition to the otherwise classname-only JSX edits. Logged in [`deferrals-sidecar`](../specs/2026-05-29-design-parity-recovery-deferrals.md) under PR2 → D10. |
| `.pr-tab-count-warn` warn variant | Spec §4.2 implies "three-tab sub-strip with proper active-state visual" matches the handoff (which applies `pr-tab-count-warn` to Drafts when `draftCount > 0` per `design/handoff/pr-detail.jsx:131`) | Plan authors `.prTabCountWarn` in the module so the rule is ready, but does **not** wire the conditional render. Wiring is a behavior change (the JSX decides when to apply the warn class), explicitly out of scope per §2.2. | Behavior-change carve-out; the rule is in place for PR9 to wire if revisit decides so. Logged in [`deferrals-sidecar`](../specs/2026-05-29-design-parity-recovery-deferrals.md) under PR2 → D11. |

PR2 does **not** add `data-testid="pr-actions"` because no test queries it today (grep confirmed). Spec §4.2 mentions `.pr-actions` as a class that gets renamed, but no test asserts on it. The class becomes `styles.prActions` and that's the end of it.

---

## File structure

**Create (6):**
- `frontend/src/components/PrDetail/PrHeader.module.css` — Port of `design/handoff/screens.css:62-82` (5 rules: `prHeader`, `prHeaderTop`, `prTitle`, `prSubtitle`, `prActions`)
- `frontend/src/components/PrDetail/PrSubTabStrip.module.css` — Port of `design/handoff/screens.css:212-247` (6 rules: `prTabs`, `prTab`, `prTab:hover`, `prTab.isActive`, `prTabCount`, `prTab.isActive .prTabCount`, `prTabCountWarn`, `prTab.isDisabled`)
- `frontend/src/components/PrDetail/BannerRefresh.module.css` — No handoff source; layout-only (action-group flex). Composes with `.banner` global.
- `frontend/src/components/PrDetail/CrossTabPresenceBanner.module.css` — No handoff source; layout-only (action-group flex, optional warning tint via `.banner-warning`). Composes with `.banner`.
- `frontend/src/components/PrDetail/ForeignPendingReviewModal/ImportedDraftsBanner.module.css` — No handoff source; multi-paragraph spacing only.
- `frontend/e2e/__screenshots__/win32/pr-detail-header.png` — First viewport baseline captured during this slice (committed as binary).

**Modify (13):**
- `frontend/src/components/PrDetail/PrHeader.tsx` — Classname swap to `styles.*`; add `data-testid="pr-title"` to `<h1>` at line 285; keep dormant bare classes `pr-subtitle-author`, `pr-subtitle-branch`, `pr-meta-repo` per spec §6.2 spirit.
- `frontend/src/components/PrDetail/PrSubTabStrip.tsx` — Classname swap to `styles.*`; add `data-testid="pr-tab-count"` to the count `<span>` at line 68; keep dormant `is-disabled` modifier with a real CSS rule.
- `frontend/src/components/PrDetail/BannerRefresh.tsx` — Classname swap; compose with global `.banner`.
- `frontend/src/components/PrDetail/CrossTabPresenceBanner.tsx` — Classname swap; compose with global `.banner` + conditional `.banner-warning` for read-only state.
- `frontend/src/components/PrDetail/ForeignPendingReviewModal/ImportedDraftsBanner.tsx` — Classname swap; keep global `.banner-warning`.
- `frontend/src/styles/tokens.css` — Append minimal `.btn-link` rule next to `.btn-icon` block (around line 338).
- `frontend/__tests__/PrSubTabStrip.test.tsx` — Replace `.querySelector('.pr-tab-count')` with `.querySelector('[data-testid="pr-tab-count"]')`.
- `frontend/e2e/s4-multi-tab-consistency.spec.ts` — Replace `.locator('.pr-tab-count')` with `.locator('[data-testid="pr-tab-count"]')`.
- `frontend/e2e/s4-drafts-survive-restart.spec.ts` — Same `.pr-tab-count` migration.
- `frontend/e2e/s5-marker-prefix-collision.spec.ts` — Same `.pr-tab-count` migration (2 occurrences at 68 + 95).
- `frontend/e2e/no-layout-shift-on-banner.spec.ts` — Replace `h1.pr-title` with `[data-testid="pr-title"]`.
- `frontend/e2e/parity-baselines.spec.ts` — Remove `test.fixme` wrapper on the `pr-detail-header` block (lines 127-134); leave the other 8 zones `fixme`'d (PR3-PR8 territory).
- `docs/specs/2026-05-29-design-parity-recovery-deferrals.md` — Append `## PR2 — PR Detail chrome` section with D6-D11.

**Not touched (preserved):**
- Any Inbox component (PR2 scope says so; §2.2 enforces).
- Any Submit-surface component (S5-shipped CSS in `tokens.css:493-637` stays per spec §3.2).
- Any backend file (PR2 is frontend-CSS-only; PR1 already shipped the 401→403 backend change).

---

## Task 1: Pre-flight grep for classname queries

**Goal:** Confirm the test-selector inventory matches the plan before touching anything. Catches any classname query the survey missed (which would cause a hidden test red after the rename).

**Files:**
- Read-only: `frontend/__tests__/`, `frontend/e2e/`, `frontend/src/`

- [ ] **Step 1: Grep for `pr-tab-count` classname references across the frontend**

Run:
```powershell
# From repo root in the PR2 worktree
Get-ChildItem frontend -Recurse -Include *.ts,*.tsx,*.spec.ts | Select-String "pr-tab-count"
```
Expected: matches at the 5 file paths listed in the File structure section AND at `frontend/src/components/PrDetail/PrSubTabStrip.tsx:68` (the JSX itself).

- [ ] **Step 2: Grep for `pr-title` and `pr-header` classname references**

Run:
```powershell
Get-ChildItem frontend -Recurse -Include *.ts,*.tsx,*.spec.ts | Select-String "\.pr-title|\.pr-header|h1\.pr-title|h1.pr-meta|\.pr-actions"
```
Expected: `h1.pr-title` at `frontend/e2e/no-layout-shift-on-banner.spec.ts:59`. PrHeader JSX classnames at `frontend/src/components/PrDetail/PrHeader.tsx:275-302`. No other test queries.

- [ ] **Step 3: Grep for `banner-refresh`, `cross-tab-presence-banner`, `imported-drafts-banner` references**

Run:
```powershell
Get-ChildItem frontend -Recurse -Include *.ts,*.tsx,*.spec.ts | Select-String "banner-refresh|cross-tab-presence-banner|imported-drafts-banner"
```
Expected: JSX usages at the 3 component `.tsx` files. **No test queries on these classes** (data-testid="reload-banner" is the existing handle and is unaffected).

If any of these greps surface a query the plan didn't enumerate, **stop and report** — the plan needs updating before proceeding.

- [ ] **Step 4: Commit nothing** (this task is read-only). Move to Task 2.

---

## Task 2: Add data-testid hooks before classname rename

**Goal:** Add `data-testid="pr-title"`, `data-testid="pr-tab-count"`, and `data-testid="imported-drafts-banner"` to the JSX so the test-selector migration in Task 3 has a stable target. Adding the attributes first lets the existing tests pass through the rename in any order.

**Plan amendment (2026-05-29 pre-flight).** The third `data-testid` (`imported-drafts-banner`) is added in response to Task 1's discovery: `frontend/e2e/s5-submit-foreign-pending-review.spec.ts:64` queries `.locator('.imported-drafts-banner')`. After Task 8 module-scopes the class, the global selector would break. Same migration pattern as the other two — add a `data-testid` in Task 2, migrate the query in Task 3.

**Files:**
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx:285`
- Modify: `frontend/src/components/PrDetail/PrSubTabStrip.tsx:68`
- Modify: `frontend/src/components/PrDetail/ForeignPendingReviewModal/ImportedDraftsBanner.tsx:38`

- [ ] **Step 1: Add `data-testid="pr-title"` to the `<h1>` in PrHeader**

Edit `frontend/src/components/PrDetail/PrHeader.tsx:285`:

Before:
```tsx
<h1 className="pr-title">{title}</h1>
```
After:
```tsx
<h1 className="pr-title" data-testid="pr-title">{title}</h1>
```

- [ ] **Step 2: Add `data-testid="pr-tab-count"` to the count `<span>` in PrSubTabStrip**

Edit `frontend/src/components/PrDetail/PrSubTabStrip.tsx:68-70`:

Before:
```tsx
<span className="pr-tab-count" aria-hidden="true">
  {count}
</span>
```
After:
```tsx
<span className="pr-tab-count" data-testid="pr-tab-count" aria-hidden="true">
  {count}
</span>
```

- [ ] **Step 3: Add `data-testid="imported-drafts-banner"` to the outer `<div>` in ImportedDraftsBanner**

Edit `frontend/src/components/PrDetail/ForeignPendingReviewModal/ImportedDraftsBanner.tsx:38`:

Before:
```tsx
<div className="imported-drafts-banner banner-warning" role="status">
```
After:
```tsx
<div className="imported-drafts-banner banner-warning" data-testid="imported-drafts-banner" role="status">
```

Preserve `role="status"` — it's the existing semantic identity for screen-reader announcement.

- [ ] **Step 4: Run vitest to confirm no regression from attribute additions**

Run:
```powershell
cd frontend; npm test -- --run PrSubTabStrip
```
Expected: 9/9 tests in `PrSubTabStrip.test.tsx` pass (the existing `.querySelector('.pr-tab-count')` still matches because the class is still there).

- [ ] **Step 5: Commit**

```powershell
cd ..
git add frontend/src/components/PrDetail/PrHeader.tsx frontend/src/components/PrDetail/PrSubTabStrip.tsx frontend/src/components/PrDetail/ForeignPendingReviewModal/ImportedDraftsBanner.tsx
git commit -m "feat(pr2): add data-testid hooks for pr-title, pr-tab-count, imported-drafts-banner

Stable test-selector targets ahead of the CSS module rename in PR2.
Adding the data-testid first lets existing classname-based queries
continue to pass through the rename in any order.

Third hook (imported-drafts-banner) added in response to Task 1
pre-flight discovery: s5-submit-foreign-pending-review.spec.ts:64
queries .imported-drafts-banner as a global class; Task 8 hashes it,
so the Playwright assertion would silently fail without this hook.

Spec: docs/specs/2026-05-29-design-parity-recovery-design.md §4.1.3
Plan: docs/plans/2026-05-29-design-parity-recovery-pr2-pr-detail-chrome.md"
```

---

## Task 3: Migrate test selectors from classname to data-testid

**Goal:** Switch all 5 affected test/spec files to query by `data-testid` so the CSS module rename in Tasks 4-8 can't break them.

**Files:**
- Modify: `frontend/__tests__/PrSubTabStrip.test.tsx:65`
- Modify: `frontend/e2e/s4-multi-tab-consistency.spec.ts:56`
- Modify: `frontend/e2e/s4-drafts-survive-restart.spec.ts:75`
- Modify: `frontend/e2e/s5-marker-prefix-collision.spec.ts:68, 95`
- Modify: `frontend/e2e/no-layout-shift-on-banner.spec.ts:59`

- [ ] **Step 1: Update `frontend/__tests__/PrSubTabStrip.test.tsx:65`**

Before:
```tsx
expect(drafts.querySelector('.pr-tab-count')).toBeNull();
```
After:
```tsx
expect(drafts.querySelector('[data-testid="pr-tab-count"]')).toBeNull();
```

- [ ] **Step 2: Update `frontend/e2e/s4-multi-tab-consistency.spec.ts:56`**

Find the line containing `.locator('.pr-tab-count')` and replace `.pr-tab-count` with `[data-testid="pr-tab-count"]`. Preserve surrounding context (`.first()`, `.nth(0)`, etc.).

- [ ] **Step 3: Update `frontend/e2e/s4-drafts-survive-restart.spec.ts:75`**

Same `.pr-tab-count` → `[data-testid="pr-tab-count"]` replacement.

- [ ] **Step 4: Update `frontend/e2e/s5-marker-prefix-collision.spec.ts:68, 95`**

Two occurrences of `.locator('.pr-tab-count')` to migrate. Both lines: replace `.pr-tab-count` with `[data-testid="pr-tab-count"]`.

- [ ] **Step 4b: Update `frontend/e2e/s5-submit-foreign-pending-review.spec.ts:64`**

Before:
```ts
await expect(page.locator('.imported-drafts-banner')).toContainText(
```
After:
```ts
await expect(page.locator('[data-testid="imported-drafts-banner"]')).toContainText(
```

This selector was added to the migration list during Task 1 pre-flight (it wasn't in the original spec §6.1 survey). The rest of the assertion (text content, options) stays unchanged.

- [ ] **Step 5: Update `frontend/e2e/no-layout-shift-on-banner.spec.ts` (BOTH `h1.pr-title` occurrences — lines 52 and 59)**

The spec has two `h1.pr-title` references:
- Line 52: `await expect(page.locator('h1.pr-title')).toHaveText('Calc utilities');` — assertion that the PR title renders.
- Line 59: `const targets = ['[data-testid="pr-header"]', 'h1.pr-title', '[data-testid="pr-tab-files"]'];` — bounding-box capture list.

Both must migrate. After Task 4, the `pr-title` global class no longer renders on the `<h1>` (replaced by `styles.prTitle`), so the line-52 `toHaveText` assertion would time out and the line-59 capture would silently drop the title from the bounding-box set.

Before (line 52):
```ts
await expect(page.locator('h1.pr-title')).toHaveText('Calc utilities');
```
After (line 52):
```ts
await expect(page.locator('[data-testid="pr-title"]')).toHaveText('Calc utilities');
```

Before (line 59):
```ts
const targets = ['[data-testid="pr-header"]', 'h1.pr-title', '[data-testid="pr-tab-files"]'];
```
After (line 59):
```ts
const targets = ['[data-testid="pr-header"]', '[data-testid="pr-title"]', '[data-testid="pr-tab-files"]'];
```

Confirm via `Get-ChildItem frontend/e2e/no-layout-shift-on-banner.spec.ts | Select-String "h1.pr-title"` returns zero matches after the edit.

- [ ] **Step 6: Run vitest to confirm PrSubTabStrip suite still passes**

Run:
```powershell
cd frontend; npm test -- --run PrSubTabStrip
```
Expected: 9/9 tests pass (data-testid query now resolves; classname removed).

- [ ] **Step 7: Commit**

```powershell
cd ..
git add frontend/__tests__/PrSubTabStrip.test.tsx frontend/e2e/s4-multi-tab-consistency.spec.ts frontend/e2e/s4-drafts-survive-restart.spec.ts frontend/e2e/s5-marker-prefix-collision.spec.ts frontend/e2e/s5-submit-foreign-pending-review.spec.ts frontend/e2e/no-layout-shift-on-banner.spec.ts
git commit -m "test(pr2): migrate .pr-tab-count, h1.pr-title, .imported-drafts-banner queries to data-testid

Switches 6 test/spec files off CSS class selectors ahead of the
PrHeader, PrSubTabStrip, and ImportedDraftsBanner CSS module renames.
Spec §6.1 mitigation. The s5-submit-foreign-pending-review.spec.ts
migration was added during Task 1 pre-flight (the .imported-drafts-banner
query wasn't in the original spec §6.1 survey).

Spec: docs/specs/2026-05-29-design-parity-recovery-design.md §4.2 + §6.1"
```

---

## Task 4: PrHeader module CSS + JSX rename

**Goal:** Port `design/handoff/screens.css:62-82` (5 rules) into `PrHeader.module.css`; swap `PrHeader.tsx` global classes onto `styles.*`. Dormant hook classes (`.pr-subtitle-author`, `.pr-subtitle-branch`, `.pr-meta-repo`) stay as bare globals per the Deviations table.

**Files:**
- Create: `frontend/src/components/PrDetail/PrHeader.module.css`
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx:275-302`

- [ ] **Step 1: Author `PrHeader.module.css`**

Create `frontend/src/components/PrDetail/PrHeader.module.css` with the exact ported rules (`screens.css:62-82`, kebab-case → camelCase):

```css
.prHeader {
  padding: var(--s-5) var(--s-6) 0;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border-1);
}

.prHeaderTop {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--s-6);
}

.prTitle {
  font-size: var(--text-xl);
  font-weight: 600;
  letter-spacing: -0.015em;
  margin: 4px 0 6px;
  text-wrap: pretty;
  max-width: 70ch;
}

.prSubtitle {
  font-size: var(--text-xs);
  flex-wrap: wrap;
  gap: var(--s-3);
}

.prActions {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  flex: none;
}
```

No new tokens. All `var(--*)` references already exist in `tokens.css`.

- [ ] **Step 2: Swap PrHeader JSX classnames onto module**

Edit `frontend/src/components/PrDetail/PrHeader.tsx`. Add `import styles from './PrHeader.module.css';` near the top imports.

Then at lines 274-302, swap as follows (preserve every existing className not in this table):

| Line | Before | After |
|------|--------|-------|
| 275 | `<div className="pr-header" data-testid="pr-header">` | `<div className={styles.prHeader} data-testid="pr-header">` |
| 276 | `<div className="pr-header-top">` | `<div className={styles.prHeaderTop}>` |
| 277 | `<div className="pr-meta col gap-1">` | `<div className={`${styles.prMeta} col gap-1`}>` — but **note**: `prMeta` is NOT in handoff CSS and NOT in the module either. Keep as plain global hook: `<div className="pr-meta col gap-1">` (no styles rename — this is a dormant hook). |
| 278 | `<div className="row gap-2 muted-2 pr-meta-repo">` | (unchanged) — `pr-meta-repo` is a dormant hook per Deviations table. |
| 285 | `<h1 className="pr-title" data-testid="pr-title">` | `<h1 className={styles.prTitle} data-testid="pr-title">` |
| 286 | `<div className="row gap-3 muted-2 pr-subtitle">` | `<div className={`row gap-3 muted-2 ${styles.prSubtitle}`}>` |
| 287 | `<span className="pr-subtitle-author">` | (unchanged) — dormant hook. |
| 289 | `<span className="pr-subtitle-branch">` | (unchanged) — dormant hook. |
| 302 | `<div className="pr-actions">` | `<div className={styles.prActions}>` |

**Important:** Don't drop the dormant hooks (`pr-meta`, `pr-meta-repo`, `pr-subtitle-author`, `pr-subtitle-branch`). They stay as plain global strings so future styling has an anchor. The `chip`, `chip-ci-*`, `chip-mergeability-*`, `row`, `col`, `gap-*`, `muted-2` classes all stay as plain globals — they're `tokens.css` primitives per spec §3.1.

- [ ] **Step 3: Run vitest to confirm PrHeader doesn't have a regression**

Run:
```powershell
cd frontend; npm test -- --run PrHeader
```
Expected: existing PrHeader tests pass. (If there are no PrHeader-specific vitest files, this is a quick smoke. The integration tests in `PrDetailRoute.test.tsx` etc. are the real check — they'd fail if `data-testid="pr-header"` broke or the JSX structure regressed.)

Run full vitest:
```powershell
cd frontend; npm test -- --run
```
Expected: same green count as before this task.

- [ ] **Step 4: Verify build**

Run:
```powershell
cd frontend; npm run build
```
Expected: 0 errors, 0 warnings. Vite emits the new `.module.css` chunk in the build report.

- [ ] **Step 5: Commit**

```powershell
cd ..
git add frontend/src/components/PrDetail/PrHeader.module.css frontend/src/components/PrDetail/PrHeader.tsx
git commit -m "feat(pr2): port PrHeader handoff CSS into module

Faithful port of design/handoff/screens.css:62-82 — five rules:
prHeader, prHeaderTop, prTitle, prSubtitle, prActions. Dormant hook
classes (pr-meta-repo, pr-subtitle-author, pr-subtitle-branch) stay as
bare globals per the plan's Deviations table.

Spec: docs/specs/2026-05-29-design-parity-recovery-design.md §4.2"
```

---

## Task 5: PrSubTabStrip module CSS + JSX rename

**Goal:** Port `design/handoff/screens.css:212-247` (8 rules) into `PrSubTabStrip.module.css`; swap JSX. Author an additional `.prTab.isDisabled` rule (no handoff source) for the dormant state hook.

**Files:**
- Create: `frontend/src/components/PrDetail/PrSubTabStrip.module.css`
- Modify: `frontend/src/components/PrDetail/PrSubTabStrip.tsx`

- [ ] **Step 1: Author `PrSubTabStrip.module.css`**

Create with the ported rules. Note `.pr-tab.is-active` becomes `.prTab.isActive` (both classes must apply for the selector to match — JSX must compose them).

```css
.prTabs {
  display: flex;
  gap: 2px;
  margin-top: var(--s-4);
  margin-left: -4px;
}

.prTab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 14px;
  font-size: var(--text-sm);
  color: var(--text-3);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  font-weight: 500;
  position: relative;
}

.prTab:hover {
  color: var(--text-1);
}

.prTab.isActive {
  color: var(--text-1);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

.prTab.isDisabled {
  opacity: 0.5;
  pointer-events: none;
  cursor: not-allowed;
}

.prTabCount {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  background: var(--surface-3);
  color: var(--text-2);
  border-radius: 999px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.prTab.isActive .prTabCount {
  background: var(--accent-soft);
  color: var(--accent);
}

.prTabCountWarn {
  background: var(--warning-soft) !important;
  color: var(--warning-fg) !important;
}
```

The `.prTabCountWarn` `!important` is faithful to the handoff (`screens.css:247`).

- [ ] **Step 2: Swap PrSubTabStrip JSX classnames onto module**

Edit `frontend/src/components/PrDetail/PrSubTabStrip.tsx`. Add `import styles from './PrSubTabStrip.module.css';` near top.

| Line | Before | After |
|------|--------|-------|
| 17 | `<div role="tablist" className="pr-tabs">` | `<div role="tablist" className={styles.prTabs}>` |
| 59 | `className={`pr-tab ${active ? 'is-active' : ''} ${disabled ? 'is-disabled' : ''}`.trim()}` | `className={[styles.prTab, active && styles.isActive, disabled && styles.isDisabled].filter(Boolean).join(' ')}` |
| 68 | `<span className="pr-tab-count" data-testid="pr-tab-count" aria-hidden="true">` | `<span className={styles.prTabCount} data-testid="pr-tab-count" aria-hidden="true">` |

**Sibling-structure preservation note.** The `<span className="sr-only">` at line 73 MUST remain a **sibling** of the `prTabCount` span, NOT a child inside it. The count span carries `aria-hidden="true"` which propagates to descendants — wrapping the sr-only span inside would hide the screen-reader-only count announcement ("Files, 3 items") from assistive tech. The JSX structure stays:
```tsx
<>
  <span className={styles.prTabCount} data-testid="pr-tab-count" aria-hidden="true">{count}</span>
  <span className="sr-only">{`, ${count} ${count === 1 ? 'item' : 'items'}`}</span>
</>
```
Only the className on the first span changes. The fragment, the sibling structure, the `aria-hidden`, and the `sr-only` global all stay intact.

**Focus-visible audit (deferred).** The global `:focus-visible` rule in `tokens.css` applies an accent ring to any keyboard-focused element. On `.prTab` (negative-margin overlaps the container border-bottom), the ring may visually clip against the strip's border. After Task 9 captures the baseline, visually confirm in the running app (`npx playwright test` headed mode or manual): tab through the Overview/Files/Drafts buttons; the focus ring should be fully visible. If it clips, append `.prTab:focus-visible { outline-offset: 3px; }` to the module and re-capture the baseline. If no clip, no change needed.

**Note on the warn-variant.** The handoff applies `pr-tab-count-warn` as a second class alongside `pr-tab-count` (`screens.css:247` + `pr-detail.jsx:131`). The current PrSubTabStrip JSX does not render `pr-tab-count-warn` (grep against `PrSubTabStrip.tsx` returns zero matches). This is a faithfulness gap: the handoff dimensions the warn variant for the Drafts tab when drafts > 0. **PR2 does NOT add the warn variant** — that would be a behavior change (deciding when to render warn vs default), which is out of scope per §2.2. The `.prTabCountWarn` rule is authored so the class is ready when wired; absence is logged in the deferrals sidecar under PR2 → D11.

- [ ] **Step 3: Run vitest**

```powershell
cd frontend; npm test -- --run PrSubTabStrip
```
Expected: 9/9 pass. The `drafts.querySelector('[data-testid="pr-tab-count"]')` query at line 65 of the spec resolves because the new module class is on the same `<span>` as the data-testid.

- [ ] **Step 4: Verify build**

```powershell
cd frontend; npm run build
```
Expected: 0 errors. New module chunk emitted.

- [ ] **Step 5: Commit**

```powershell
cd ..
git add frontend/src/components/PrDetail/PrSubTabStrip.module.css frontend/src/components/PrDetail/PrSubTabStrip.tsx
git commit -m "feat(pr2): port PrSubTabStrip handoff CSS into module

Faithful port of design/handoff/screens.css:212-247 — prTabs,
prTab (+:hover/.isActive/.isDisabled), prTabCount (+ .isActive
nested), prTabCountWarn. The .isDisabled state hook is plan-authored
(no handoff rule) for the existing JSX modifier.

Warn-variant remains unwired in production JSX — see deferrals D11.

Spec: docs/specs/2026-05-29-design-parity-recovery-design.md §4.2"
```

---

## Task 6: BannerRefresh module CSS + JSX (no-handoff carve-out, composes with .banner)

**Goal:** Compose `BannerRefresh` with the existing `.banner` global (`tokens.css:422`) for info-tint + padding + bottom border; module CSS adds only the action-group flex that `.banner` doesn't ship.

**Files:**
- Create: `frontend/src/components/PrDetail/BannerRefresh.module.css`
- Modify: `frontend/src/components/PrDetail/BannerRefresh.tsx:24-32`

- [ ] **Step 1: Author `BannerRefresh.module.css`**

```css
.bannerRefreshMessage {
  flex: 1;
  min-width: 0;
}

.bannerRefreshActions {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex: none;
}

.bannerRefreshDismiss {
  color: var(--text-3);
}

.bannerRefreshDismiss:hover {
  color: var(--text-1);
}
```

No `.bannerRefresh` outer rule — the JSX composes with the global `.banner` which already provides display: flex + padding + bottom border + info-tint background.

- [ ] **Step 2: Swap BannerRefresh JSX**

Edit `frontend/src/components/PrDetail/BannerRefresh.tsx`. Add `import styles from './BannerRefresh.module.css';` near top.

| Line | Before | After |
|------|--------|-------|
| 24 | `className="banner-refresh"` | `className="banner"` (compose with global) |
| 25 | `className="banner-refresh-message"` | `className={styles.bannerRefreshMessage}` |
| 26 | `className="banner-refresh-actions"` | `className={styles.bannerRefreshActions}` |
| 32 | `className="btn-icon banner-refresh-dismiss"` | `className={`btn-icon ${styles.bannerRefreshDismiss}`}` |

The `btn btn-primary btn-sm` at line 27 stays as plain globals — `tokens.css` already has the rules.

**ARIA preservation note.** The outer `<div>` at line 24 carries `role="status" aria-live="polite" data-testid="reload-banner"` — all three attributes MUST be preserved through the className swap. These are the BannerRefresh's semantic identity for screen readers; losing `aria-live` would silently break the update announcement when new iterations push. Only the className string changes; rewrite the opening tag in place rather than retyping it from scratch to avoid attribute drift.

- [ ] **Step 3: Run vitest for any BannerRefresh smoke**

```powershell
cd frontend; npm test -- --run BannerRefresh
```
Expected: existing tests pass. The `data-testid="reload-banner"` handle is unaffected.

- [ ] **Step 4: Commit**

```powershell
cd ..
git add frontend/src/components/PrDetail/BannerRefresh.module.css frontend/src/components/PrDetail/BannerRefresh.tsx
git commit -m "feat(pr2): style BannerRefresh by composing with global .banner

No handoff CSS source for banner-refresh-* classes. Outer wrapper now
composes with the .banner global (tokens.css:422 — info-tint, flex,
padding, bottom border). Module CSS adds only the action-group flex
layout that .banner doesn't provide.

Spec: docs/specs/2026-05-29-design-parity-recovery-design.md §4.2
Deviation: deferrals sidecar PR2 → D6"
```

---

## Task 7: CrossTabPresenceBanner module CSS + JSX (no-handoff carve-out, conditional .banner-warning)

**Goal:** Same composition pattern as BannerRefresh, plus a conditional `.banner-warning` modifier in the `readOnly` state so the read-only banner reads as more urgent than the visibility-only banner.

**Files:**
- Create: `frontend/src/components/PrDetail/CrossTabPresenceBanner.module.css`
- Modify: `frontend/src/components/PrDetail/CrossTabPresenceBanner.tsx:38-58`

- [ ] **Step 1: Author `CrossTabPresenceBanner.module.css`**

```css
.crossTabPresenceBannerMessage {
  flex: 1;
  min-width: 0;
}

.crossTabPresenceBannerActions {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex: none;
}
```

- [ ] **Step 2: Add `.btn-link` to `tokens.css`** (per Deviations table — single-consumer today but semantically a button variant)

Find the `.btn-icon` block in `frontend/src/styles/tokens.css` (around line 331-338). Append after it:

```css
.btn-link {
  background: transparent;
  color: var(--accent);
  border: none;
  padding: 0;
  height: auto;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}

.btn-link:hover {
  color: var(--accent-hover);
  text-decoration: none;
}
```

- [ ] **Step 3: Swap CrossTabPresenceBanner JSX**

Edit `frontend/src/components/PrDetail/CrossTabPresenceBanner.tsx`. Add `import styles from './CrossTabPresenceBanner.module.css';`.

| Line | Before | After |
|------|--------|-------|
| 38 | `className="cross-tab-presence-banner"` | `className={`banner ${readOnly ? 'banner-warning' : ''}`.trim()}` |
| 39 | `className="cross-tab-presence-banner-message"` | `className={styles.crossTabPresenceBannerMessage}` |
| 40 | `className="cross-tab-presence-banner-actions"` | `className={styles.crossTabPresenceBannerActions}` |

The `btn btn-secondary btn-sm`, `btn btn-primary btn-sm`, `btn btn-link btn-sm` strings all stay as plain globals.

**ARIA preservation note.** The outer `<div>` at line 38 carries `role="alert" aria-live="assertive"` — both attributes MUST be preserved through the className swap. Per the component's own header comment, this banner is "the user's only signal that their composer is disabled because of cross-tab take-over." Losing `role="alert"` means screen readers no longer announce the take-over state change, and a user typing into a now-disabled composer would get no audible explanation. Only the className string changes; rewrite the opening tag in place to avoid attribute drift.

- [ ] **Step 4: Run vitest smoke**

```powershell
cd frontend; npm test -- --run CrossTabPresenceBanner
```
Expected: existing tests pass.

- [ ] **Step 5: Commit**

```powershell
cd ..
git add frontend/src/components/PrDetail/CrossTabPresenceBanner.module.css frontend/src/components/PrDetail/CrossTabPresenceBanner.tsx frontend/src/styles/tokens.css
git commit -m "feat(pr2): style CrossTabPresenceBanner + add .btn-link to tokens

No handoff CSS source for cross-tab-presence-banner-* classes. Outer
wrapper composes with the .banner global, with .banner-warning added
conditionally in the read-only state for visual urgency parity with
the spec's intent. Module CSS supplies only the action-group flex.

.btn-link was used at CrossTabPresenceBanner.tsx:56 but undefined in
both tokens.css and any module. Added a minimal rule in tokens.css
(semantic home for button variants) — single consumer today, valid
primitive going forward.

Spec: docs/specs/2026-05-29-design-parity-recovery-design.md §4.2
Deviation: deferrals sidecar PR2 → D6, D8"
```

---

## Task 8: ImportedDraftsBanner module CSS + JSX (no-handoff carve-out, paragraph layout)

**Goal:** Add inter-paragraph spacing for the two `<p>` elements that can render under the existing `.banner-warning` global tint.

**Files:**
- Create: `frontend/src/components/PrDetail/ForeignPendingReviewModal/ImportedDraftsBanner.module.css`
- Modify: `frontend/src/components/PrDetail/ForeignPendingReviewModal/ImportedDraftsBanner.tsx:38`

- [ ] **Step 1: Author `ImportedDraftsBanner.module.css`**

```css
.importedDraftsBanner {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}

.importedDraftsBanner p {
  margin: 0;
}
```

The class is `.importedDraftsBanner` (camelCase). The selector for the inner `<p>` is a descendant combinator inside the same module — Vite's CSS-modules transform keeps the descendant selector intact.

- [ ] **Step 2: Swap ImportedDraftsBanner JSX**

Edit `frontend/src/components/PrDetail/ForeignPendingReviewModal/ImportedDraftsBanner.tsx`. Add `import styles from './ImportedDraftsBanner.module.css';`.

| Line | Before | After |
|------|--------|-------|
| 38 | `className="imported-drafts-banner banner-warning"` | `className={`${styles.importedDraftsBanner} banner-warning`}` |

- [ ] **Step 3: Run vitest smoke**

```powershell
cd frontend; npm test -- --run ImportedDraftsBanner
```
Expected: existing tests pass.

- [ ] **Step 4: Commit**

```powershell
cd ..
git add frontend/src/components/PrDetail/ForeignPendingReviewModal/ImportedDraftsBanner.module.css frontend/src/components/PrDetail/ForeignPendingReviewModal/ImportedDraftsBanner.tsx
git commit -m "feat(pr2): style ImportedDraftsBanner paragraph layout

No handoff CSS source. Module CSS supplies multi-paragraph spacing
inside the existing .banner-warning global tint. On-disk path is
ForeignPendingReviewModal/ImportedDraftsBanner.tsx (not the spec
§3.2 file-layout's top-level location); module colocated with the
actual file.

Spec: docs/specs/2026-05-29-design-parity-recovery-design.md §4.2
Deviation: deferrals sidecar PR2 → D6, D7"
```

---

## Task 9: Un-fixme pr-detail-header parity baseline + capture first PNG

**Goal:** Remove the `test.fixme` wrapper on the `pr-detail-header` parity-baseline test (introduced in PR1) and commit the first viewport baseline. The remaining 8 zones stay `test.fixme`'d for PR3-PR8 to un-fixme as they restore each surface.

**Files:**
- Modify: `frontend/e2e/parity-baselines.spec.ts:127-134`
- Create: `frontend/e2e/__screenshots__/win32/pr-detail-header.png` (binary; via `--update-snapshots`)

- [ ] **Step 1: Un-fixme the pr-detail-header block**

Edit `frontend/e2e/parity-baselines.spec.ts:127-134`. Change:
```ts
test.fixme('pr-detail-header', async ({ page }) => {
```
to:
```ts
test('pr-detail-header', async ({ page }) => {
```

The other 8 `test.fixme(...)` blocks (`inbox`, `inbox-activity-rail`, `setup-card`, `settings-page`, `pr-detail-overview`, `pr-detail-files-tree`, `pr-detail-files-diff`, `pr-detail-drafts`, `pr-detail-reconciliation-panel`) stay `fixme`'d. PR2 only addresses the header zone.

- [ ] **Step 2: Capture the baseline (Playwright auto-starts the backend)**

**Do NOT** pre-run `./run.ps1`. The Playwright config (`frontend/playwright.config.ts:41-73`) declares a `webServer` entry that starts the backend with `--no-launch-profile` + `ASPNETCORE_ENVIRONMENT=Test` + `PRISM_E2E_FAKE_REVIEW=1` + a per-run `DataDir`. Manual `./run.ps1` uses `launchSettings.json` which forces `ASPNETCORE_ENVIRONMENT=Development`; with `reuseExistingServer: !isCI`, Playwright would silently reuse the Dev-env server, the Test-gated `/test/...` endpoints would not register, and `setupAndOpenHandoffParityFixture` would 404.

In the worktree's `frontend/` directory (no other PowerShell needed):
```powershell
cd frontend; npx playwright test parity-baselines --update-snapshots --grep "pr-detail-header" --project=prod
```
Expected: Playwright spawns the Test-env backend + Vite dev server, the test passes, and one new file at `frontend/e2e/__screenshots__/win32/pr-detail-header.png` is written.

`--project=prod` matches the canonical CI baseline path (CI runs only `prod` per `playwright.config.ts:132`). Locally without the filter, both `dev` and `prod` projects would run and contend on the same baseline file.

If the test fails to *capture* (e.g., fixture-fallback per D1 means the handoff-parity-fixture endpoint isn't available — the test uses `setupAndOpenHandoffParityFixture(page)` per PR1's helper), confirm whether the helper falls back to `setupAndOpenScenarioPr` per the D1 fallback. If not, **stop and report** — D1 needs revisiting.

- [ ] **Step 3: Run the test in non-update mode to confirm the baseline locks**

```powershell
cd frontend; npx playwright test parity-baselines --grep "pr-detail-header" --project=prod
```
Expected: 1 pass (diff against the committed baseline). Playwright tears down the webServer on exit — no manual cleanup needed.

- [ ] **Step 4: Commit**

```powershell
cd ..
git add frontend/e2e/parity-baselines.spec.ts frontend/e2e/__screenshots__/win32/pr-detail-header.png
git commit -m "test(pr2): un-fixme pr-detail-header parity baseline + capture first PNG

Locks the PR Detail header zone (PrHeader + PrSubTabStrip + actions)
as the first parity baseline. Other 8 zones remain test.fixme'd for
PR3-PR8.

Captured against the handoff-parity fixture per PR1 helper. Baseline
on win32 (CI runner platform) per per-platform pinning policy.

Spec: docs/specs/2026-05-29-design-parity-recovery-design.md §4.1.3
Plan: docs/plans/2026-05-29-design-parity-recovery-pr2-pr-detail-chrome.md"
```

---

## Task 10: Deferrals sidecar updates

**Goal:** Append the `## PR2 — PR Detail chrome` section with D6-D11 so reviewers can see every plan deviation in one place.

**Files:**
- Modify: `docs/specs/2026-05-29-design-parity-recovery-deferrals.md`

- [ ] **Step 1: Append PR2 section to the deferrals sidecar**

Open `docs/specs/2026-05-29-design-parity-recovery-deferrals.md`. After the existing `## PR1 — Foundation` section (with D1-D5), append:

```markdown
## PR2 — PR Detail chrome

### D6 — No handoff CSS source for 3 of 5 PR2 components

**Spec position:** §4.2 lists `BannerRefresh`, `CrossTabPresenceBanner`, `ImportedDraftsBanner` as scope items receiving module CSS, alongside the handoff-restored `PrHeader` and `PrSubTabStrip`.

**Reality:** Grep against `design/handoff/screens.css` and `design/handoff/*.jsx` returns zero matches for `banner-refresh*`, `cross-tab-presence-banner*`, and `imported-drafts-banner*`. The handoff's update-banner equivalent uses bare `.banner` (`design/handoff/tokens.css:396`, already ported to `frontend/src/styles/tokens.css:422`).

**Plan resolution:** Compose the three components with the existing `.banner` (or `.banner-warning`) global so they inherit info/warning tint, padding, and bottom border from the ported handoff vocabulary. Module CSS author only the additional layout (action-group flex, paragraph spacing) that the global doesn't ship.

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

**Plan resolution:** Migrate the 5 affected test files to `[data-testid="..."]` selectors instead. PR2 adds `data-testid="pr-title"` and `data-testid="pr-tab-count"` to the JSX as part of the slice (small scope addition to the otherwise-classname-only edit). Matches the project's standing preference for `data-testid` over class selectors (spec §4.1.3 note).

**Status:** Applied in PR2.

### D11 — pr-tab-count warn variant remains unwired in production JSX

**Spec position:** §4.2 says "three-tab sub-strip with proper active-state visual." Implicit: visual states match the handoff, which applies `pr-tab-count-warn` to the Drafts tab's count when `draftCount > 0` (`design/handoff/pr-detail.jsx:131`).

**Reality:** The current `PrSubTabStrip.tsx` does not render the warn variant — the count `<span>` only carries `pr-tab-count` regardless of value.

**Plan resolution:** PR2 authors `.prTabCountWarn` in the module so the rule is ready, but does NOT wire the conditional render. Wiring is a behavior change (the JSX decides when to apply the warn class), explicitly out of scope per §2.2. PR9 revisit can decide whether to wire it.

**Status:** Deferred to PR9 revisit.
```

- [ ] **Step 2: Commit**

```powershell
git add docs/specs/2026-05-29-design-parity-recovery-deferrals.md
git commit -m "docs(pr2): append PR2 deferrals (D6-D11)

Six deviations logged: no-handoff-CSS for 3 banner components,
ImportedDraftsBanner path drift, .btn-link latent gap, dormant JSX
classes triage, test-selector migration via data-testid,
pr-tab-count warn-variant deferral to PR9.

Spec: docs/specs/2026-05-29-design-parity-recovery-design.md §4.2"
```

---

## Task 11: Pre-push verification

**Goal:** Run the full pre-push checklist per `.ai/docs/development-process.md`. Per project memory `feedback_run_full_pre_push_checklist.md`, every step is mandatory — `npm run lint` and `npm run build` are not optional.

**Files:** none modified.

- [ ] **Step 1: Run frontend lint** (includes `prettier --check`)

```powershell
cd frontend; npm run lint
```
Expected: 0 errors. Per memory `feedback_prettier_check_in_ci.md` — if new `.module.css` files were added without `prettier --write`, this fails. If it does:
```powershell
cd frontend; npx prettier --write src/components/PrDetail/PrHeader.module.css src/components/PrDetail/PrSubTabStrip.module.css src/components/PrDetail/BannerRefresh.module.css src/components/PrDetail/CrossTabPresenceBanner.module.css src/components/PrDetail/ForeignPendingReviewModal/ImportedDraftsBanner.module.css
```
Then re-run lint. Stage the formatting changes if any.

- [ ] **Step 2: Run frontend build**

```powershell
cd frontend; npm run build
```
Expected: 0 errors. Build report shows the new module chunks.

- [ ] **Step 3: Run frontend test suite**

```powershell
cd frontend; npm test -- --run
```
Expected: same green count as before PR2 + the data-testid-migrated specs still pass.

- [ ] **Step 4: Run dotnet build** (PR2 is frontend-only but verify the workspace is clean)

```powershell
cd ..
dotnet build --configuration Release
```
Expected: 0 errors, 0 warnings.

- [ ] **Step 5: Run dotnet test**

```powershell
dotnet test --no-build --configuration Release
```
Expected: full green (1000+ tests). If a previously-flaky test surfaces, re-run once before flagging.

- [ ] **Step 6: Run targeted Playwright specs that were touched**

In a separate PowerShell, start `./run.ps1`. Then in the worktree:
```powershell
cd frontend; npx playwright test no-layout-shift-on-banner s4-multi-tab-consistency s4-drafts-survive-restart s5-marker-prefix-collision parity-baselines --grep "pr-detail-header"
```
Expected: all green. If the parity-baseline test fails on diff (not flake), the captured PNG didn't lock cleanly in Task 9 — re-run Task 9 step 3-4. Stop the backend after.

- [ ] **Step 7: No commit — this task is verification only.**

Move to pr-autopilot for opening the PR per memory `feedback_use_pr_autopilot.md`.

---

## Self-review notes (for the implementer)

Before invoking `pr-autopilot`, double-check:

1. **Nine commits expected on the branch** (one per Task 2-10). Task 1 is read-only, Task 11 is verification-only. Each commit is independently reviewable.
2. **Side-by-side screenshot for PR description** per spec §4.1.4 + §5(1): capture the handoff's `design/handoff/PRism.html` (load it locally with the handoff-parity fixture) on the left, the worktree's running app on the right, both at the PR Detail header zone with a sample PR loaded. Use `compound-engineering:ce-demo-reel`.
3. **Inbox baseline must NOT shift** — spec §2.2 carve-out for PR7 doesn't apply to PR2. If the parity-baselines specs for `inbox` or `inbox-activity-rail` start failing, that's a regression (PR2 shouldn't touch Inbox layout).
4. **Build chunk count check** per spec §6.7: confirm `npm run build` reports a manageable chunk count (the 5 new `.module.css` files emit small chunks).
5. **Dormant hook preservation**: grep the final PrHeader.tsx for `pr-meta-repo`, `pr-subtitle-author`, `pr-subtitle-branch`, `pr-meta` — all four bare-global classes should still appear. They're not in any CSS file, but their presence in JSX keeps the anchor for future styling.

If anything in this list fails the check, stop and surface it before pushing.
