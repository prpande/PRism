# Collapsible PR-detail header + toolbar density trim (#128) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual double-chevron toggle that collapses the PR-detail header's read-once meta to a compact single row, and trim the over-padded Files toolbar — reclaiming ~97px of vertical space for the diff.

**Architecture:** Plain React state (no scroll machinery). A per-PR, session-only in-memory store (`usePrHeaderCollapsed`, mirroring `useTabScrollMemory`) backs a `data-collapsed` attribute on the PrHeader root; CSS reflows the meta block to a single row and hides read-once fields while keeping the title + CI/mergeability chips. The chevron is a **sibling** of the sub-tab `role="tablist"` (not a child — avoids `aria-required-children`). The toolbar trim is independent, always-on CSS.

**Tech Stack:** React 19 + TypeScript + Vite, CSS Modules, vitest + @testing-library/react, Playwright e2e.

**Spec:** `docs/specs/2026-06-05-condense-pr-header-on-scroll-design.md`

**Plan deviation from spec A.2 (documented):** The spec suggested *moving* the CI/mergeability chip out of `.prSubtitle` in JSX. This plan keeps the chip in `.prSubtitle` and instead, in the collapsed state, **reflows `.pr-meta` to a row and hides only the non-chip subtitle children** — achieving the same compact row with pure CSS and no JSX restructure. Same acceptance criteria, simpler change.

**Plan deviation — motion:** The collapse is **instant** (no height animation); only the chevron rotation transitions (≤150ms, suppressed under reduced-motion). A height/opacity ease over a `flex-direction`-changing reflow is not cleanly animatable, and on a user-initiated toggle an instant snap is acceptable and avoids the "empty-box intermediate frame" the review flagged. **Spec AC 9 interpretation:** the chevron rotation is the *only* animated transition, so reduced-motion has only that to suppress (handled by the Task 3 `@media` block); there is no collapse height/opacity transition, so the spec's "collapse transition suppressed" is satisfied vacuously and **no separate reduced-motion e2e case is written** (a CSS-level media query, not an observable behavioral assertion).

**Plan deviation from spec A.1 — hook location:** Spec A.1 sketched the state in `PrDetailView` (passed to `PrHeader` as a prop). This plan puts `usePrHeaderCollapsed` **directly in `PrHeader`** (which already has `reference` → `prRefKey`), avoiding prop-drilling through `PrDetailView`. Same per-PR/session-only semantics; `PrDetailView` is untouched.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `frontend/src/hooks/usePrHeaderCollapsed.ts` | Per-PR session-only collapsed state (module Map + hook) | Create |
| `frontend/src/hooks/usePrHeaderCollapsed.test.tsx` | Unit tests for the hook | Create |
| `frontend/src/components/PrDetail/PrHeader.tsx` | Render chevron (sibling of tablist) + `data-collapsed` wiring | Modify |
| `frontend/src/components/PrDetail/PrHeader.module.css` | Chevron styles + collapsed-meta reflow rules | Modify |
| `frontend/src/components/PrDetail/FilesTab/FilesTab.module.css` | Toolbar vertical-padding trim | Modify |
| `frontend/src/components/PrDetail/FilesTab/IterationTabStrip.module.css` | Iteration strip + chip vertical-padding trim | Modify |
| `frontend/e2e/pr-header-collapse.spec.ts` | e2e: collapse/expand, meta hidden, chip+title kept, diff taller, toolbar shorter, a11y | Create |
| `frontend/e2e/diff-scroll-regression.spec.ts` | Add file-tree-independent-scroller regression assertion | Modify |
| `frontend/e2e/a11y-audit.spec.ts` | Assert chevron introduces no `aria-required-children` | Modify |
| `frontend/e2e/parity-baselines.spec.ts` | (re-baseline only — no code change) | Re-capture PNGs |
| `docs/specs/2026-06-05-condense-pr-header-on-scroll-design.md` | Flip `status: draft` → `implemented` | Modify |

---

## Task 1: `usePrHeaderCollapsed` hook (per-PR session state)

**Files:**
- Create: `frontend/src/hooks/usePrHeaderCollapsed.ts`
- Test: `frontend/src/hooks/usePrHeaderCollapsed.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/hooks/usePrHeaderCollapsed.test.tsx
import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { usePrHeaderCollapsed, _clearStoreForTest } from './usePrHeaderCollapsed';

afterEach(() => _clearStoreForTest());

describe('usePrHeaderCollapsed', () => {
  test('defaults to expanded (false)', () => {
    const { result } = renderHook(() => usePrHeaderCollapsed('acme/api/1'));
    expect(result.current[0]).toBe(false);
  });

  test('toggle flips the flag', () => {
    const { result } = renderHook(() => usePrHeaderCollapsed('acme/api/1'));
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(false);
  });

  test('a fresh mount with the same key reads the persisted value', () => {
    const first = renderHook(() => usePrHeaderCollapsed('acme/api/1'));
    act(() => first.result.current[1]());
    const second = renderHook(() => usePrHeaderCollapsed('acme/api/1'));
    expect(second.result.current[0]).toBe(true);
  });

  test('state is per-key', () => {
    const a = renderHook(() => usePrHeaderCollapsed('acme/api/1'));
    act(() => a.result.current[1]());
    const b = renderHook(() => usePrHeaderCollapsed('acme/api/2'));
    expect(b.result.current[0]).toBe(false);
  });

  test('_clearStoreForTest resets persistence', () => {
    const a = renderHook(() => usePrHeaderCollapsed('acme/api/1'));
    act(() => a.result.current[1]());
    _clearStoreForTest();
    const b = renderHook(() => usePrHeaderCollapsed('acme/api/1'));
    expect(b.result.current[0]).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/hooks/usePrHeaderCollapsed.test.tsx`
Expected: FAIL — "Failed to resolve import './usePrHeaderCollapsed'".

- [ ] **Step 3: Write the hook**

```ts
// frontend/src/hooks/usePrHeaderCollapsed.ts
import { useCallback, useState } from 'react';

// Per-PR collapsed state for the PrHeader meta block. Session-only and
// in-memory (mirrors useTabScrollMemory's store): closing/reopening the app
// resets every PR to expanded. Keyed by prRefKey so each open PR remembers its
// own choice while the app runs — surviving sub-tab and PR-tab switches under
// keep-alive.
const store = new Map<string, boolean>();

// Test-only: reset the module-level store between Vitest files.
export function _clearStoreForTest(): void {
  store.clear();
}

// Returns [collapsed, toggle]. The seed is read ONCE — prRefKey is stable for a
// PrHeader instance's lifetime (PrTabHost keys one PrDetailView per PR), so no
// re-seed effect is needed (mirrors PrDetailView's initialSubTab seed-once
// pattern).
export function usePrHeaderCollapsed(prRefKey: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => store.get(prRefKey) ?? false);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      store.set(prRefKey, next);
      return next;
    });
  }, [prRefKey]);

  return [collapsed, toggle];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/hooks/usePrHeaderCollapsed.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/usePrHeaderCollapsed.ts frontend/src/hooks/usePrHeaderCollapsed.test.tsx
git commit -m "feat(#128): per-PR session-only collapsed-header state hook"
```

---

## Task 2: PrHeader — chevron toggle (sibling of tablist) + `data-collapsed`

**Files:**
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx`

This task wires the hook, adds `data-collapsed` to the root, gives `.pr-meta` an id for `aria-controls`, and renders the chevron button as a **sibling** of `<PrSubTabStrip>` inside a flex row. No unit test here (PrHeader is hook/provider-heavy — covered by the Task 5 e2e); behavior is verified at Step 3 by build + the e2e.

- [ ] **Step 1: Import the hook and `prRefKey`**

In `PrHeader.tsx`, add to the existing imports:

```tsx
import { prRefKey } from '../../api/types';
import { usePrHeaderCollapsed } from '../../hooks/usePrHeaderCollapsed';
```

(`PrReference` is already imported from `../../api/types`; add `prRefKey` to that line or as shown.)

- [ ] **Step 2: Add a chevron icon component**

Add near the top of `PrHeader.tsx` (module scope, below imports):

```tsx
// #128 — double-chevron, authored pointing DOWN (the expanded state). The
// collapsed state rotates it 180° via CSS (.prHeader[data-collapsed] .collapseToggle svg).
function CollapseChevron() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4l4 4 4-4" />
      <path d="M4 9l4 4 4-4" />
    </svg>
  );
}
```

- [ ] **Step 3: Call the hook inside `PrHeader`**

At the top of the `PrHeader` component body (with the other hooks, e.g. just after `const submit = useSubmit(reference);`):

```tsx
const [collapsed, toggleCollapsed] = usePrHeaderCollapsed(prRefKey(reference));
```

- [ ] **Step 4: Add `data-collapsed` to the root and `id` to the meta column**

Change the root opening tag:

```tsx
// FROM:
<div className={styles.prHeader} data-testid="pr-header">
// TO: (explicit string value so e2e `toHaveAttribute('data-collapsed','true')`
// is unambiguous; `undefined` omits the attribute entirely when expanded)
<div className={styles.prHeader} data-testid="pr-header" data-collapsed={collapsed ? 'true' : undefined}>
```

Change the meta column opening tag (the `pr-meta col gap-1` div) to add an id:

```tsx
// FROM:
<div className="pr-meta col gap-1">
// TO:
<div className="pr-meta col gap-1" id="pr-header-meta">
```

- [ ] **Step 5: Wrap `<PrSubTabStrip>` + chevron in a flex row (chevron is a SIBLING, never a child of the tablist)**

```tsx
// FROM:
<PrSubTabStrip
  activeTab={activeTab}
  onTabChange={onTabChange}
  fileCount={fileCount}
  draftsCount={draftsCount}
/>
// TO:
<div className={styles.subTabRow}>
  <PrSubTabStrip
    activeTab={activeTab}
    onTabChange={onTabChange}
    fileCount={fileCount}
    draftsCount={draftsCount}
  />
  <button
    type="button"
    className={styles.collapseToggle}
    data-testid="pr-header-collapse-toggle"
    aria-expanded={!collapsed}
    aria-controls="pr-header-meta"
    aria-label={collapsed ? 'Expand PR details' : 'Collapse PR details'}
    title={collapsed ? 'Expand PR details' : 'Collapse PR details'}
    onClick={toggleCollapsed}
  >
    <CollapseChevron />
  </button>
</div>
```

- [ ] **Step 6: Type-check + build**

Run: `cd frontend && npx tsc --noEmit && npm run build`
Expected: no type errors; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/PrDetail/PrHeader.tsx
git commit -m "feat(#128): PrHeader chevron toggle (sibling of tablist) + data-collapsed"
```

---

## Task 3: PrHeader collapse CSS (reflow + chevron styles + motion)

**Files:**
- Modify: `frontend/src/components/PrDetail/PrHeader.module.css`

- [ ] **Step 1: Append the sub-tab-row + chevron styles**

```css
/* ---- #128: sub-tab row holds the tabs + the collapse chevron (sibling of the
   role="tablist", never a child — avoids aria-required-children). ---- */
.subTabRow {
  display: flex;
  align-items: center;
  gap: var(--s-3);
}
.subTabRow > :first-child {
  flex: 1 1 auto;
  min-width: 0;
}
.collapseToggle {
  flex: none;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 24px;
  background: transparent;
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  color: var(--text-3);
  cursor: pointer;
  transition:
    color var(--t-fast),
    background var(--t-fast),
    border-color var(--t-fast);
}
.collapseToggle:hover {
  color: var(--text-1);
  background: var(--surface-2);
}
.collapseToggle:active {
  background: var(--surface-3);
}
/* Explicit focus ring clipped to the button's own radius (the global
   :focus-visible uses --radius-1; the button is --radius-2, so match it here to
   avoid a mismatched ring corner — spec called for an aligned focus state). */
.collapseToggle:focus-visible {
  outline: 2px solid var(--accent-ring);
  outline-offset: 2px;
  border-radius: var(--radius-2);
}
.collapseToggle svg {
  transition: transform var(--t-fast);
}
```

> **Chevron vertical alignment (verify at the visual gate):** `.prTabs` carries
> `margin-top: var(--s-4)`, so with `.subTabRow { align-items: center }` the
> chevron may sit slightly low against the tab labels. If it floats, the fix is
> to move that top spacing onto `.subTabRow` (`margin-top: var(--s-4)` on the row,
> remove it from `.prTabs`) or switch the row to `align-items: flex-end`. Confirm
> by eye in Step 3.

- [ ] **Step 2: Append the collapsed-meta reflow rules**

```css
/* ---- #128: collapsed state. The meta column reflows to a single row holding
   the (ellipsized) title + the CI/mergeability chips; read-once fields hide.
   The chips stay in .prSubtitle — only the non-chip children are hidden — so no
   JSX restructure is needed (plan deviation from spec A.2). ---- */
.prHeader[data-collapsed] :global(.pr-meta-repo),
.prHeader[data-collapsed] .statusMerged,
.prHeader[data-collapsed] .statusClosed {
  display: none;
}
.prHeader[data-collapsed] :global(.pr-meta) {
  flex-direction: row;
  align-items: center;
  gap: var(--s-3);
  min-width: 0;
}
.prHeader[data-collapsed] .prTitle {
  font-size: var(--text-base);
  margin: 0;
  max-width: none;
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.prHeader[data-collapsed] .prSubtitle {
  flex: 0 0 auto;
}
/* Keep ONLY the CI + mergeability chips; hide author/branch/iterationLabel.
   .chip-ci / .chip-mergeability are GLOBAL classes (className strings in
   PrHeader.tsx, no module rule), so they MUST be wrapped in :global() — a bare
   .chip-ci inside a CSS Module is hashed and matches nothing, which would hide
   the very chips we want to keep. Same idiom as DiffPane.module.css's
   :global(.diff-pane--split:not(...)). */
.prHeader[data-collapsed] .prSubtitle > :not(:global(.chip-ci)):not(:global(.chip-mergeability)) {
  display: none;
}
.prHeader[data-collapsed] .collapseToggle svg {
  transform: rotate(180deg);
}

/* Motion: only the chevron rotation animates (the collapse itself is an instant
   reflow — see plan). Suppress the rotation under reduced-motion. */
@media (prefers-reduced-motion: reduce) {
  .collapseToggle svg {
    transition: none;
  }
}
```

- [ ] **Step 3: Launch the app and verify both states visually**

Run the app (`./run.ps1 -Reset None --no-browser`, then open `http://localhost:5180`), open a real multi-file PR's Files tab, and click the chevron.
Expected:
- Expanded: full header (repo·#, title, status, author/branch, chips).
- Collapsed: single row = ellipsized title + CI/mergeability chip + actions; chevron rotated up; the diff body is visibly taller.
- The Overview/Files/Drafts tabs remain visible and clickable in both states.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/PrDetail/PrHeader.module.css
git commit -m "feat(#128): collapsed-header reflow + chevron styles + reduced-motion"
```

---

## Task 4: Files toolbar density trim (always-on, CSS-only)

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FilesTab.module.css`
- Modify: `frontend/src/components/PrDetail/FilesTab/IterationTabStrip.module.css`

Density-independent literals where they must beat compact mode's `--s-3:10px` override (see spec "Density-token interaction").

- [ ] **Step 1: Trim the toolbar vertical padding**

In `FilesTab.module.css`, `.filesTabToolbar`:

```css
/* FROM: */
  padding: var(--s-3) var(--s-4);
/* TO: (vertical 12px -> 8px; horizontal unchanged) */
  padding: var(--s-2) var(--s-4);
```

- [ ] **Step 2: Trim the iteration strip + chip vertical padding**

In `IterationTabStrip.module.css`:

```css
/* .iterationTabStrip — FROM: */
  padding: var(--s-2) 0;
/* TO: (vertical 8px -> 2px) */
  padding: 2px 0;

/* .iterationTab — FROM: */
  padding: var(--s-2) var(--s-3);
/* TO: (vertical 8px -> 5px; horizontal unchanged) */
  padding: 5px var(--s-3);
```

- [ ] **Step 3: Verify the toolbar height dropped**

Reload the running app's Files tab. In DevTools (or via the e2e in Task 5), confirm `.files-tab-toolbar` is ~50px (was ~77px) and all three toggle buttons + the iteration tabs are still present and clickable.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/FilesTab.module.css frontend/src/components/PrDetail/FilesTab/IterationTabStrip.module.css
git commit -m "feat(#128): trim Files toolbar vertical padding (~77px -> ~50px)"
```

---

## Task 5: e2e — collapse behavior + toolbar trim + a11y

**Files:**
- Create: `frontend/e2e/pr-header-collapse.spec.ts`

Uses the hermetic `acme/api/123` fixture via the existing helpers. `AxeBuilder` is already a dependency (used in `a11y-audit.spec.ts`).

- [ ] **Step 1: Write the e2e spec**

```ts
// frontend/e2e/pr-header-collapse.spec.ts
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

const VIEWPORT = { width: 1440, height: 900 };

test.describe('#128 collapsible PR header + toolbar trim', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetBackendState(request);
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);
    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-diff"]').waitFor();
  });

  test('chevron collapses/expands the meta and grows the diff', async ({ page }) => {
    const header = page.locator('[data-testid="pr-header"]');
    const toggle = page.locator('[data-testid="pr-header-collapse-toggle"]');
    const body = page.locator('.diff-pane-body');

    // Default = expanded.
    await expect(header).not.toHaveAttribute('data-collapsed', /.*/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const expandedH = await body.evaluate((el) => el.clientHeight);

    // Collapse.
    await toggle.click();
    await expect(header).toHaveAttribute('data-collapsed', 'true');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Read-once meta hidden; title still present.
    await expect(page.locator('[data-testid="pr-header"] .pr-meta-repo')).toBeHidden();
    await expect(page.locator('[data-testid="pr-title"]')).toBeVisible();

    // Diff body grew (poll to avoid layout-timing flake).
    await expect
      .poll(() => body.evaluate((el) => el.clientHeight))
      .toBeGreaterThan(expandedH);

    // Expand again restores.
    await toggle.click();
    await expect(header).not.toHaveAttribute('data-collapsed', /.*/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  test('collapsed state survives a sub-tab round-trip (per-PR session state)', async ({ page }) => {
    const header = page.locator('[data-testid="pr-header"]');
    await page.locator('[data-testid="pr-header-collapse-toggle"]').click();
    await expect(header).toHaveAttribute('data-collapsed', 'true');

    await page.locator('[data-testid="pr-tab-overview"]').click();
    await page.locator('[data-testid="pr-tab-files"]').click();

    // Same PrDetailView instance (keep-alive) → still collapsed.
    await expect(header).toHaveAttribute('data-collapsed', 'true');
  });

  test('the collapse toggle is a sibling of the sub-tab tablist, not a child', async ({ page }) => {
    const insideTablist = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="pr-header-collapse-toggle"]');
      return !!btn?.closest('[role="tablist"]');
    });
    expect(insideTablist).toBe(false);
  });

  test('no serious/critical a11y violations in expanded or collapsed state', async ({ page }) => {
    const analyze = async () => {
      const results = await new AxeBuilder({ page }).analyze();
      // Allow ONLY the pre-existing pr-tabstrip close-button violation (D104/#174).
      return results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .filter(
          (v) =>
            !(
              v.id === 'aria-required-children' &&
              v.nodes.length > 0 &&
              v.nodes.every((n) => n.html.includes('data-testid="pr-tabstrip"'))
            ),
        );
    };

    expect(await analyze(), 'expanded').toEqual([]);
    await page.locator('[data-testid="pr-header-collapse-toggle"]').click();
    await expect(page.locator('[data-testid="pr-header"]')).toHaveAttribute('data-collapsed', 'true');
    expect(await analyze(), 'collapsed').toEqual([]);
  });

  test('toolbar is trimmed but keeps all controls', async ({ page }) => {
    const toolbarH = await page
      .locator('.files-tab-toolbar')
      .evaluate((el) => el.getBoundingClientRect().height);
    // Was ~77px. <60 holds for the canonical 3-iteration acme/api/123 fixture at
    // 1440px (single row). The toolbar has flex-wrap:wrap, so a much larger
    // iteration set could wrap to 2 rows and break this — acceptable given the
    // fixed hermetic fixture.
    expect(toolbarH).toBeLessThan(60);

    await expect(page.locator('[data-testid="whole-file-toggle"]')).toBeVisible();
    await expect(page.locator('[data-testid="line-wrap-toggle"]')).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `cd frontend && npx playwright test pr-header-collapse.spec.ts`
Expected: all tests PASS. (If the harness's Playwright browser/container is unavailable locally, this runs in CI — see the pre-push checklist; do not skip it silently.)

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/pr-header-collapse.spec.ts
git commit -m "test(#128): e2e — collapse/expand, per-PR persistence, a11y, toolbar trim"
```

---

## Task 6: Regression — file tree is an independent scroller (extend existing spec)

**Files:**
- Modify: `frontend/e2e/diff-scroll-regression.spec.ts`

Locks in issue criterion 1 (tree stays put while diff scrolls). The only genuinely-new assertion vs the existing spec: the file tree is a **distinct scroll container** from the diff body. Assert it is a separate `overflow-y:auto` element, independent of whether it currently overflows (the single-file fixture's tree is short).

- [ ] **Step 1: Add a test inside the existing `describe` block**

Append, after the existing `test(...)` in `diff-scroll-regression.spec.ts`:

```ts
  test('file tree is an independent scroll container, separate from the diff body', async ({
    page,
  }) => {
    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-diff"]').waitFor();

    const shape = await page.evaluate(() => {
      const tree = document.querySelector('[data-testid="files-tab-tree"]') as HTMLElement | null;
      const body = document.querySelector('.diff-pane-body') as HTMLElement | null;
      return {
        treeOverflowY: tree ? getComputedStyle(tree).overflowY : null,
        treeContainsBody: !!(tree && body && tree.contains(body)),
        bodyContainsTree: !!(tree && body && body.contains(tree)),
        docOverflow:
          document.documentElement.scrollHeight - document.documentElement.clientHeight,
      };
    });

    // Tree is its OWN vertical scroller, not the page and not the diff.
    expect(shape.treeOverflowY).toBe('auto');
    expect(shape.treeContainsBody).toBe(false);
    expect(shape.bodyContainsTree).toBe(false);
    // And the page itself does not scroll in the Files view (criterion 2).
    expect(shape.docOverflow).toBeLessThanOrEqual(1);
  });
```

- [ ] **Step 2: Run the spec**

Run: `cd frontend && npx playwright test diff-scroll-regression.spec.ts`
Expected: both tests PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/diff-scroll-regression.spec.ts
git commit -m "test(#128): regression — file tree is an independent scroller (issue crit 1-2)"
```

---

## Task 7: a11y audit — confirm the chevron adds no new violation

**Files:**
- Modify: `frontend/e2e/a11y-audit.spec.ts`

The Task 5 spec already runs axe on the PR-detail Files surface in both states. This task adds a guard in the canonical a11y suite so a future regression (e.g. someone moving the chevron into the tablist) trips the dedicated audit too.

- [ ] **Step 1: Check whether a11y-audit already opens a PR-detail Files surface**

Run: `cd frontend && npx playwright test a11y-audit.spec.ts --list`
If a PR-detail (Files) audit case already exists, confirm it renders `[data-testid="pr-header-collapse-toggle"]` and passes `runAxe` (the chevron-as-sibling must not add `aria-required-children`). If it does, **no code change is needed** — note that in the commit and skip Step 2.

- [ ] **Step 2 (only if no Files-surface audit exists): add one**

Add a test mirroring the file's existing pattern (reuse its mocks/helpers — match the surrounding style), opening `/pr/acme/api/123/files`, then:

```ts
    await page.locator('[data-testid="pr-header-collapse-toggle"]').click();
    await expect(page.locator('[data-testid="pr-header"]')).toHaveAttribute(
      'data-collapsed',
      'true',
    );
    await runAxe(page); // existing helper — gates serious/critical minus the pr-tabstrip mask
```

- [ ] **Step 3: Run + commit**

Run: `cd frontend && npx playwright test a11y-audit.spec.ts`
Expected: PASS.

```bash
git add frontend/e2e/a11y-audit.spec.ts
git commit -m "test(#128): a11y audit covers the collapsed PR-detail header"
```

---

## Task 8: Re-baseline parity screenshots + visual gate (B1)

**Files (re-capture only):**
- `frontend/e2e/__screenshots__/<platform>/pr-detail-header.png` (PrHeader JSX changed)
- `frontend/e2e/__screenshots__/<platform>/pr-detail-files-diff.png` (diff grows as toolbar shrinks)
- `frontend/e2e/__screenshots__/<platform>/pr-detail-files-diff-whole-file.png` (same)

- [ ] **Step 1: Re-capture the affected baselines**

Run: `cd frontend && npx playwright test parity-baselines.spec.ts --update-snapshots`

- [ ] **Step 2: Review each diff as part of the visual gate**

Inspect the three regenerated PNGs. Confirm:
- `pr-detail-header.png`: the new chevron is present at the right of the sub-tab row; the **expanded** header is otherwise unchanged (chip still on the subtitle line).
- `pr-detail-files-diff*.png`: the toolbar is ~26px shorter and the diff container is correspondingly taller; controls unchanged.
A stale baseline must not be mistaken for a regression nor a real regression hidden.

- [ ] **Step 3: Capture the B1 human-gate proof**

Launch the real app and capture live before/after screenshots — expanded, collapsed, and toolbar-trimmed — in **light and dark** (toggle the theme via the Settings page appearance control, which sets `data-theme`; the automated parity baselines only cover the default theme, so dark is manual-gate-only here). These are the human-gated proof for the PR `## Proof` section (host on a `review-assets/pr-N` branch, embed via raw URLs).

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/__screenshots__
git commit -m "test(#128): re-baseline header + files-diff parity screenshots"
```

---

## Task 9: Docs + issue disposition

**Files:**
- Modify: `docs/specs/2026-06-05-condense-pr-header-on-scroll-design.md`

- [ ] **Step 1: Flip the spec status**

In the frontmatter: `status: draft` → `status: implemented`.

- [ ] **Step 2: Documentation-maintenance scan**

Check `.ai/docs/documentation-maintenance.md` for any doc that must update for a PR-detail UI change (e.g. a frontend-conventions or screens reference). Update in the same PR if so; otherwise note "no doc-maintenance entry applies" in the PR `## Proof`.

- [ ] **Step 3: Commit**

```bash
git add docs/specs/2026-06-05-condense-pr-header-on-scroll-design.md
git commit -m "docs(#128): mark spec implemented"
```

- [ ] **Step 4: (At PR close, not a code step) Post the criterion-4 reframe disposition on issue #128**

When the PR merges and #128 is closed, post a comment recording that criterion 4 was reframed (collapse→manual condense; scroll→chevron; "top bar(s)"→PrHeader meta + toolbar trim), per the spec's "Reframe of criterion 4" section, so the issue history isn't four checked boxes under a silent redefinition.

---

## Final verification (before PR)

- [ ] `cd frontend && npx vitest run` — full unit suite green (incl. Task 1).
- [ ] `cd frontend && npm run lint` — eslint + prettier --check clean (run `npm run prettier -- --write` on new/changed files first).
- [ ] `cd frontend && npm run build` — production build succeeds.
- [ ] `cd frontend && npx playwright test pr-header-collapse.spec.ts diff-scroll-regression.spec.ts a11y-audit.spec.ts parity-baselines.spec.ts` — green (or run in CI per the pre-push checklist if the local Playwright browser is unavailable).
- [ ] Run the full pre-push checklist in `.ai/docs/development-process.md` verbatim.

---

## Spec coverage check

| Spec acceptance criterion | Task |
|---|---|
| Chevron collapses/expands meta to compact row | 2, 3, 5 |
| Real button, aria-expanded/controls, keyboard | 2, 5, 7 |
| Collapsed hides repo·#/status/author/branch; keeps title (same h1)/chip/actions | 3, 5 |
| Per-PR, survives tab switch in session, resets on restart | 1, 5 |
| Chevron on all sub-tabs, default expanded | 2 (rendered in PrHeader, shown on every sub-tab), 5 |
| Collapsing grows the diff, no overlay | 3, 5 |
| Action cluster never overflows compact row at ≥900px | 3 (title flex:1/min-width:0; actions flex:none) |
| Toolbar vertical padding trimmed, controls unchanged | 4, 5 |
| Reduced-motion suppresses the (chevron) transition | 3 |
| Regression: doc/app-scroll not overflowing, diff is scroller, tree independent | 6 |
