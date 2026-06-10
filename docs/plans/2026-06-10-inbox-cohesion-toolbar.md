# Inbox Cohesion (toolbar card + two-layout rail gate + sort restyle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inbox top read as one cohesive unit — round the search-bar toolbar into a card, gate the activity rail on a single `showRail` (toggle AND ≥1180px) producing two clean layouts, and restyle the Sort control to match PRism's filter-trigger family with self-consistent labels.

**Architecture:** Pure frontend change (React + Vite + TS, CSS Modules). One new shared constant module; the rest are edits to existing inbox components and CSS. The rail is gated in JS so it genuinely unmounts below 1180px (no background fetch). The Sort `<select>` stays native (a11y) but is restyled via an absolute glyph/caret overlay, mirroring the existing `.search` pattern.

**Tech Stack:** React 18, TypeScript, Vite, Vitest + React Testing Library, CSS Modules, design tokens in `frontend/src/styles/tokens.css`.

**Spec:** `docs/specs/2026-06-10-inbox-cohesion-toolbar-design.md`

**Worktree:** `D:\src\PRism-300-inbox-cohesion` · **Branch:** `feature/300-inbox-cohesion`

**Risk:** gated B1 (UI-visual) — after CI is green, pause for the owner's visual sign-off before merge.

**Commands (run from `D:\src\PRism-300-inbox-cohesion\frontend`):**
- Single test file: `npx vitest run <path>`
- Typecheck + build: `npm run build` (this is `tsc -b` + vite — `tsc --noEmit` is a vacuous no-op in this repo)
- Lint/format check (CI parity): `npx prettier --check <paths>` (do **not** trust `npm run lint`'s prettier summary; run prettier directly)

---

## File map

| File | Responsibility | Action |
|---|---|---|
| `frontend/src/components/Inbox/inboxLayout.ts` | Single source of the rail breakpoint constant | Create |
| `frontend/src/components/Inbox/inboxLayout.test.ts` | Pin the constant value | Create |
| `frontend/src/pages/InboxPage.tsx` | Compute `showRail`; gate `<ActivityRail/>` + skeleton on it | Modify |
| `frontend/src/pages/InboxPage.module.css` | Cross-ref comment on the `@media` rule pointing at the JS const | Modify |
| `frontend/__tests__/InboxPage.test.tsx` | Viewport-gate tests (fix 2 existing, add 1) | Modify |
| `frontend/src/components/Inbox/InboxToolbar.module.css` | `.toolbar` → rounded card | Modify |
| `frontend/src/components/Inbox/InboxSkeleton.tsx` | Bordered toolbar placeholder bar | Modify |
| `frontend/src/components/Inbox/InboxSkeleton.module.css` | `.toolbarBar` card border | Modify |
| `frontend/src/components/Inbox/filters/applyInboxFilters.ts` | Direction-encoding sort labels | Modify |
| `frontend/src/components/Inbox/filters/applyInboxFilters.test.ts` | Assert new labels | Modify |
| `frontend/src/components/Inbox/filters/FilterBar.tsx` | Restyle Sort control markup | Modify |
| `frontend/src/components/Inbox/filters/filters.module.css` | Sort-control styles in trigger family | Modify |

---

### Task 1: Shared breakpoint constant

**Files:**
- Create: `frontend/src/components/Inbox/inboxLayout.ts`
- Test: `frontend/src/components/Inbox/inboxLayout.test.ts`

- [ ] **Step 1: Write the failing test**

`frontend/src/components/Inbox/inboxLayout.test.ts`:

```ts
import { it, expect } from 'vitest';
import { INBOX_RAIL_MIN_WIDTH } from './inboxLayout';

// Pins the magic number so a future tweak forces a conscious update of BOTH the
// JS useMediaQuery arg and the InboxPage.module.css @media rule (1179px = 1180-1).
it('rail breakpoint is 1180px', () => {
  expect(INBOX_RAIL_MIN_WIDTH).toBe(1180);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/Inbox/inboxLayout.test.ts`
Expected: FAIL — cannot resolve `./inboxLayout`.

- [ ] **Step 3: Write minimal implementation**

`frontend/src/components/Inbox/inboxLayout.ts`:

```ts
// Single source of truth for the inbox activity-rail breakpoint.
// The rail is shown only at >= this width (see InboxPage's useMediaQuery gate).
// KEEP IN SYNC with InboxPage.module.css `@media (max-width: 1179px)` (= 1180 - 1).
export const INBOX_RAIL_MIN_WIDTH = 1180;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/Inbox/inboxLayout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd D:/src/PRism-300-inbox-cohesion
git add frontend/src/components/Inbox/inboxLayout.ts frontend/src/components/Inbox/inboxLayout.test.ts
git commit -m "feat(#300): add INBOX_RAIL_MIN_WIDTH breakpoint constant"
```

---

### Task 2: Viewport-gate the activity rail (`showRail`)

Narrow the existing `showActivityRail` flag with a viewport predicate so the rail (and the cold-load skeleton's rail column) only show at ≥1180px. Below that the rail is **not rendered**.

**Files:**
- Modify: `frontend/src/pages/InboxPage.tsx`
- Test: `frontend/__tests__/InboxPage.test.tsx`

- [ ] **Step 1: Add the matchMedia helper + reset to the test file**

The global test setup (`__tests__/setup.ts`) mocks `matchMedia` to `matches:false`. Add a per-test override helper and a reset. At the **top of** `frontend/__tests__/InboxPage.test.tsx`, immediately after the existing imports (after line 28's `import { useAiGate } ...`), insert:

```ts
// The global setup mock returns matches:false. The rail now also requires a
// >=1180px viewport, so rail-visible tests must opt into a wide viewport.
const realMatchMedia = window.matchMedia;
function mockViewportWide(wide: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: wide,
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
beforeEach(() => {
  window.matchMedia = realMatchMedia; // reset to the setup default (matches:false) per test
});
```

- [ ] **Step 2: Write the failing test (narrow viewport hides the rail)**

In `frontend/__tests__/InboxPage.test.tsx`, **immediately after** the existing test `renders ActivityRail when inbox.showActivityRail is on` (the block at lines ~204-209), add:

```ts
it('hides ActivityRail below the 1180px breakpoint even when the toggle is on', () => {
  // #300 two-layout gate: rail visible iff toggle ON *and* viewport wide enough.
  mockViewportWide(false);
  setHooks({ data: sampleData, aiPreview: false, showActivityRail: true });
  renderPage();
  expect(screen.queryByRole('complementary', { name: /activity/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 3: Make the existing rail-visible tests opt into a wide viewport**

There are **two** positive rail-render assertions in this file, in **two different `describe` blocks**, and they use **different assertion shapes** — both must get `mockViewportWide(true);` as the first line of the test body, or they break under the new gate (the global mock is `matches:false`):

1. First block — `renders ActivityRail when inbox.showActivityRail is on` (currently lines ~204-209). Add `mockViewportWide(true);` before `setHooks(...)`:

```ts
it('renders ActivityRail when inbox.showActivityRail is on', () => {
  // #283 decoupled from AI: even with aiPreview off, the rail shows when its flag is on.
  mockViewportWide(true); // #300 rail also needs a wide viewport
  setHooks({ data: sampleData, aiPreview: false, showActivityRail: true });
  renderPage();
  expect(screen.getByRole('complementary', { name: /activity/i })).toBeInTheDocument();
});
```

2. Second block — `describe('InboxPage — useAiGate migrations', ...)`, test `shows the activity rail when inbox.showActivityRail is true (AI gate off)` (currently lines ~396-407). This one asserts via `container.querySelector('[data-testid="activity-rail"]')).not.toBeNull()` and uses the `setShowActivityRail(true)` helper + an inline `render(...)` (not `renderPage`). Add `mockViewportWide(true);` as its first line:

```ts
it('shows the activity rail when inbox.showActivityRail is true (AI gate off)', () => {
  mockViewportWide(true); // #300 rail also needs a wide viewport
  vi.mocked(useAiGate).mockReturnValue(false); // AI fully off — rail still shows
  setShowActivityRail(true);
  const { container } = render(
    <MemoryRouter initialEntries={['/']}>
      <OpenTabsProvider>
        <InboxPage />
      </OpenTabsProvider>
    </MemoryRouter>,
  );
  expect(container.querySelector('[data-testid="activity-rail"]')).not.toBeNull();
});
```

The negative tests (`hides ActivityRail when inbox.showActivityRail is off even with aiPreview on`, and the second block's `hides the activity rail when … is false`) need **no** change — the rail is absent regardless. The module-scope `beforeEach` from Step 1 coexists with the second block's own `beforeEach` (both run; the matchMedia reset is harmless before the AI-mock setup).

- [ ] **Step 4: Run tests to verify the new test fails, others still pass-or-fail as expected**

Run: `npx vitest run __tests__/InboxPage.test.tsx`
Expected: the new `hides ActivityRail below the 1180px breakpoint` test **FAILS** (rail still renders — gate not implemented yet). The two `mockViewportWide(true)` tests pass (matchMedia true, but `showRail` not yet wired, so the rail renders on the toggle alone — still green).

- [ ] **Step 5: Implement the `showRail` gate in `InboxPage.tsx`**

Add the import near the other hook imports (after line 5's `usePreferences` import):

```ts
import { useMediaQuery } from '../hooks/useMediaQuery';
import { INBOX_RAIL_MIN_WIDTH } from '../components/Inbox/inboxLayout';
```

Replace the existing rail flag (line 29):

```ts
  // #283 the activity rail is a fabricated, non-AI mockup — decoupled from the AI-preview
  // toggle onto a dedicated inbox flag (default false), so default-on AI no longer surfaces it.
  const showActivityRail = preferences?.inbox.showActivityRail ?? false;
```

with:

```ts
  // #283 the activity rail is a fabricated, non-AI mockup — decoupled from the AI-preview
  // toggle onto a dedicated inbox flag (default false).
  // #300 the rail also requires a wide-enough viewport: below INBOX_RAIL_MIN_WIDTH it is
  // not rendered at all (genuinely hidden, no background fetch), giving the single-column
  // Layout B. One `showRail` drives both the rail render and the cold-load skeleton.
  const wideEnoughForRail = useMediaQuery(`(min-width: ${INBOX_RAIL_MIN_WIDTH}px)`);
  const showRail = (preferences?.inbox.showActivityRail ?? false) && wideEnoughForRail;
```

Then update the two consumers:
- Line 56 (cold-load branch): `<InboxSkeleton showRail={showActivityRail} />` → `<InboxSkeleton showRail={showRail} />`
- Line 119 (main render): `{showActivityRail && <ActivityRail />}` → `{showRail && <ActivityRail />}`

(There are no other references to `showActivityRail` in the file after this rename — confirm with a search.)

- [ ] **Step 6: Run tests to verify all pass**

Run: `npx vitest run __tests__/InboxPage.test.tsx`
Expected: PASS (all, including the new narrow-viewport test).

- [ ] **Step 7: Add the breakpoint cross-ref comment in `InboxPage.module.css`**

So the CSS `@media` boundary and the JS const are visibly linked (the value-pin test guards the number; this comment guards the human). In `frontend/src/pages/InboxPage.module.css`, change the media query block (lines 14-18) from:

```css
@media (max-width: 1179px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
```

to:

```css
/* #300 — 1179px == INBOX_RAIL_MIN_WIDTH (1180) − 1. Below it the grid is single-column
   (Layout B); InboxPage's useMediaQuery gate (same const) also stops rendering the rail.
   Keep these two boundaries in sync — see frontend/src/components/Inbox/inboxLayout.ts. */
@media (max-width: 1179px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 8: Commit**

```bash
cd D:/src/PRism-300-inbox-cohesion
git add frontend/src/pages/InboxPage.tsx frontend/src/pages/InboxPage.module.css frontend/__tests__/InboxPage.test.tsx
git commit -m "feat(#300): gate activity rail on viewport >=1180px (two-layout)"
```

---

### Task 3: Toolbar as a rounded card

Pure CSS. No unit test (visual); verified at the B1 gate (Task 7).

**Files:**
- Modify: `frontend/src/components/Inbox/InboxToolbar.module.css`

- [ ] **Step 1: Replace the `.toolbar` rule**

Current `.toolbar` (the whole rule):

```css
.toolbar {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--s-3);
  padding: var(--s-3) var(--s-4);
  border-bottom: 1px solid var(--border-1);
  background: var(--surface-1);
}
```

Replace with (drop `border-bottom`; add full border + radius to match `InboxSection .section` — `--surface-1`, `1px --border-1`, `--radius-3`, no shadow):

```css
/* #300 — the toolbar reads as a card matching the section/accordion cards below
   it (InboxSection .section: surface-1 + 1px border-1 + radius-3, NO box-shadow).
   The full border (vs the old bottom-only border) also closes the ~1px-per-side
   width mismatch with the bordered section cards. */
.toolbar {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--s-3);
  padding: var(--s-3) var(--s-4);
  background: var(--surface-1);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-3);
}
```

- [ ] **Step 2: Build to confirm no type/CSS breakage**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
cd D:/src/PRism-300-inbox-cohesion
git add frontend/src/components/Inbox/InboxToolbar.module.css
git commit -m "feat(#300): toolbar reads as a rounded card matching section cards"
```

---

### Task 4: Skeleton toolbar bar matches the card

The cold-load skeleton's toolbar placeholder is a borderless shimmer bar; give it the card border so the load→content transition is seamless.

**Files:**
- Modify: `frontend/src/components/Inbox/InboxSkeleton.tsx`
- Modify: `frontend/src/components/Inbox/InboxSkeleton.module.css`

- [ ] **Step 1: Add the `.toolbarBar` class**

Append to `frontend/src/components/Inbox/InboxSkeleton.module.css`:

```css
/* #300 — match the real toolbar card (border + radius) so the skeleton→content
   swap doesn't pop a border in. The Skeleton shimmer fills the inside. */
.toolbarBar {
  border: 1px solid var(--border-1);
  border-radius: var(--radius-3);
}
```

- [ ] **Step 2: Pass the class to the toolbar Skeleton**

In `frontend/src/components/Inbox/InboxSkeleton.tsx`, change line 34 from:

```tsx
      <Skeleton width="100%" height={36} radius={8} />
```

to:

```tsx
      <Skeleton width="100%" height={36} radius={8} className={styles.toolbarBar} />
```

(`Skeleton` already supports `className`; it composes it after `styles.block`.)

- [ ] **Step 3: Build to confirm**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
cd D:/src/PRism-300-inbox-cohesion
git add frontend/src/components/Inbox/InboxSkeleton.tsx frontend/src/components/Inbox/InboxSkeleton.module.css
git commit -m "feat(#300): skeleton toolbar bar carries the card border"
```

---

### Task 5: Direction-encoding sort labels

**Files:**
- Modify: `frontend/src/components/Inbox/filters/applyInboxFilters.ts`
- Test: `frontend/src/components/Inbox/filters/applyInboxFilters.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/components/Inbox/filters/applyInboxFilters.test.ts`:

```ts
import { SORT_OPTIONS } from './applyInboxFilters';

it('sort labels are direction-encoding and keys are unchanged', () => {
  // #300 — labels read consistently and convey their fixed (descending) direction
  // without a toggle. Keys MUST be unchanged so persisted inbox.defaultSort survives.
  expect(SORT_OPTIONS).toEqual([
    { key: 'updated', label: 'Recently updated' },
    { key: 'pushed', label: 'Recently pushed' },
    { key: 'diff', label: 'Largest diff' },
    { key: 'comments', label: 'Most comments' },
  ]);
});
```

(If `applyInboxFilters.test.ts` doesn't already import `it`/`expect` from vitest, add them to the existing import line.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/Inbox/filters/applyInboxFilters.test.ts`
Expected: FAIL — current labels are `Updated` / `Recently pushed` / `Diff size` / `Comments`.

- [ ] **Step 3: Update the labels**

In `frontend/src/components/Inbox/filters/applyInboxFilters.ts`, replace `SORT_OPTIONS` (lines 4-9):

```ts
export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'updated', label: 'Updated' },
  { key: 'pushed', label: 'Recently pushed' },
  { key: 'diff', label: 'Diff size' },
  { key: 'comments', label: 'Comments' },
];
```

with:

```ts
// #300 — direction-encoding labels: each conveys its fixed (descending) sort
// direction in words, so the control reads consistently with no asc/desc toggle.
// Keys are unchanged — persisted inbox.defaultSort values keep working.
export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'updated', label: 'Recently updated' },
  { key: 'pushed', label: 'Recently pushed' },
  { key: 'diff', label: 'Largest diff' },
  { key: 'comments', label: 'Most comments' },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/Inbox/filters/applyInboxFilters.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd D:/src/PRism-300-inbox-cohesion
git add frontend/src/components/Inbox/filters/applyInboxFilters.ts frontend/src/components/Inbox/filters/applyInboxFilters.test.ts
git commit -m "feat(#300): direction-encoding sort labels"
```

---

### Task 6: Restyle the Sort control to the filter-trigger family

Wrap the native `<select>` in a relative container with a leading sort glyph + custom caret, drop the visible "Sort:" text, add `aria-label="Sort"`, and style it to match `.trigger`.

**Files:**
- Modify: `frontend/src/components/Inbox/filters/FilterBar.tsx`
- Modify: `frontend/src/components/Inbox/filters/filters.module.css`
- Test: `frontend/src/components/Inbox/filters/FilterBar.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/components/Inbox/filters/FilterBar.test.tsx`:

```ts
it('sort control is an accessible combobox named "Sort" with no visible "Sort:" text', () => {
  render(
    <MemoryRouter>
      <OpenTabsProvider>
        <FilterBar sections={secs} initialSort="updated" ciProbeComplete onState={onState} />
      </OpenTabsProvider>
    </MemoryRouter>,
  );
  // #300 — the visible "Sort:" label is dropped; the select keeps an accessible name.
  expect(screen.getByRole('combobox', { name: /^sort$/i })).toBeInTheDocument();
  expect(screen.queryByText('Sort:')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/Inbox/filters/FilterBar.test.tsx`
Expected: FAIL — today the `<select>` has no accessible name and the literal "Sort:" text is present (`getByRole('combobox', { name: /^sort$/i })` finds nothing).

- [ ] **Step 3: Replace the Sort markup in `FilterBar.tsx`**

Current (lines 73-82):

```tsx
        <label className={styles.sort}>
          Sort:{' '}
          <select value={f.sort} onChange={(e) => f.setSort(e.target.value as SortKey)}>
            {SORT_OPTIONS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
```

Replace with (relative wrapper + leading sort glyph + caret, `aria-label`, no visible text):

```tsx
        <span className={styles.sort}>
          <svg
            className={styles.sortGlyph}
            viewBox="0 0 16 16"
            width="13"
            height="13"
            fill="currentColor"
            aria-hidden="true"
          >
            {/* Neutral "sorted list" mark (decreasing bars) — NOT an asc/desc arrow;
                the control has no direction toggle (#300). */}
            <path d="M0 4.25c0-.414.336-.75.75-.75h11.5a.75.75 0 0 1 0 1.5H.75A.75.75 0 0 1 0 4.25Zm2 4a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5A.75.75 0 0 1 2 8.25Zm2 4a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1-.75-.75Z" />
          </svg>
          <select
            className={styles.sortSelect}
            aria-label="Sort"
            value={f.sort}
            onChange={(e) => f.setSort(e.target.value as SortKey)}
          >
            {SORT_OPTIONS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <svg
            className={styles.sortCaret}
            viewBox="0 0 16 16"
            width="11"
            height="11"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.94l3.72-3.72a.749.749 0 0 1 1.06 0Z" />
          </svg>
        </span>
```

- [ ] **Step 4: Replace the `.sort` styles in `filters.module.css`**

Current (lines 248-271):

```css
/* Sort label */
.sort {
  display: inline-flex;
  align-items: center;
  gap: var(--s-1);
  font-size: var(--text-sm);
  color: var(--text-2);
  white-space: nowrap;
}

.sort select {
  font-size: var(--text-sm);
  color: var(--text-1);
  background: var(--surface-inset);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-2);
  padding: 3px var(--s-2);
  cursor: pointer;
  outline: none;
}

.sort select:focus {
  border-color: var(--accent);
}
```

Replace with (trigger-family control; glyph + caret overlaid; `appearance:none`; `:focus-visible` border + `outline:none`):

```css
/* Sort control (#300) — styled to the .trigger family. The native <select> is kept
   (full keyboard + AT semantics); a leading "sorted" glyph and a custom caret are
   absolute-overlaid (pointer-events:none) so they never intercept the select's clicks,
   mirroring the .search input pattern. */
.sort {
  position: relative;
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
}

.sortGlyph {
  position: absolute;
  left: var(--s-2);
  display: inline-flex;
  color: var(--text-3);
  pointer-events: none;
}

.sortCaret {
  position: absolute;
  right: var(--s-2);
  display: inline-flex;
  color: var(--text-3);
  pointer-events: none;
}

.sortSelect {
  appearance: none;
  -webkit-appearance: none;
  height: 28px;
  /* clear the 13px glyph (left) and 11px caret (right) */
  padding: 0 calc(var(--s-2) + 16px) 0 calc(var(--s-2) + 18px);
  font-size: var(--text-sm);
  color: var(--text-1);
  background: var(--surface-inset);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-2);
  cursor: pointer;
}

/* Single focus ring: border swap on the select (matches .searchInput:focus);
   outline:none suppresses the UA ring some engines leave under appearance:none. */
.sortSelect:focus-visible {
  border-color: var(--accent);
  outline: none;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/components/Inbox/filters/FilterBar.test.tsx`
Expected: PASS.

- [ ] **Step 6: Build to confirm types/CSS**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
cd D:/src/PRism-300-inbox-cohesion
git add frontend/src/components/Inbox/filters/FilterBar.tsx frontend/src/components/Inbox/filters/filters.module.css frontend/src/components/Inbox/filters/FilterBar.test.tsx
git commit -m "feat(#300): restyle Sort control to the filter-trigger family"
```

---

### Task 7: Full verification + B1 visual proof

**Files:** none (verification only)

- [ ] **Step 1: Run the full frontend unit suite**

Run: `npx vitest run`
Expected: all pass (no regressions in inbox/filters/skeleton suites).

- [ ] **Step 2: Typecheck + build**

Run: `npm run build`
Expected: clean (`tsc -b` passes; this catches type errors esbuild misses).

- [ ] **Step 3: Prettier (CI parity)**

Run: `npx prettier --check "src/components/Inbox/**/*.{ts,tsx,css}" "src/pages/InboxPage.tsx" "__tests__/InboxPage.test.tsx"`
Expected: "All matched files use Prettier code style!" If not, run `npx prettier --write` on the listed files and re-check.

- [ ] **Step 4: Capture B1 visual proof**

Launch the app (serve-detached / run.ps1) and capture before/after screenshots in **light + dark**:
- Layout A (rail toggle on, viewport ≥1180, e.g. 1440px): rounded toolbar card capping both columns; restyled Sort control.
- Layout B (rail toggle off): rounded toolbar aligned with the section list.
- Narrow viewport (<1180) with toggle on: rail absent, single-column Layout B.

Save under `review-assets/pr-300/` for the PR `## Proof` section.

- [ ] **Step 5: Regenerate visual baselines if the e2e parity suite is run**

The toolbar rounding + sort restyle shift inbox visual baselines. If/when the Linux parity baselines are regenerated, pull the CI artifact `actual.png` and overwrite the affected baselines (per the repo's baseline-regen flow), verifying the diff is intentional (rounded toolbar + restyled sort), not a regression.

- [ ] **Step 6: Final commit (proof assets, if any)**

```bash
cd D:/src/PRism-300-inbox-cohesion
git add review-assets/pr-300
git commit -m "test(#300): B1 visual proof — toolbar card, two layouts, sort restyle"
```

---

## Self-review

- **Spec coverage:**
  - Toolbar card (radius-3, full border, no shadow) → Task 3. ✓
  - Two-layout `showRail` gate (toggle && ≥1180px), rail not rendered below → Task 2. ✓
  - Skeleton toolbar bar border + rail-column gate → Task 4 (border) + Task 2 (skeleton call site). ✓
  - Shared `INBOX_RAIL_MIN_WIDTH` const + pinning test → Task 1. ✓
  - Sort restyle (28px, surface-inset, border-2, radius-2, glyph + caret, `:focus-visible` border + `outline:none`, `aria-label`, drop "Sort:") → Task 6. ✓
  - Direction-encoding labels (keys/comparators unchanged) → Task 5. ✓
  - AC #2 override (toolbar spans both when rail on) → emergent from Task 2 + Task 3 (no structural change to the rail-on layout; the toolbar stays full-width above the `1fr auto` grid). ✓
  - Existing test breakage handled (matchMedia overrides) → Task 2 Steps 1-3. ✓
  - Light + dark visual proof → Task 7. ✓
- **Placeholder scan:** none — every code step has complete code; commands have expected output.
- **Type consistency:** `showRail`/`wideEnoughForRail`/`INBOX_RAIL_MIN_WIDTH` consistent across Tasks 1-2; `styles.sort`/`sortGlyph`/`sortCaret`/`sortSelect`/`toolbarBar` class names consistent between the TSX and CSS tasks; `SORT_OPTIONS` shape (`{key,label}`) unchanged.
- **Out of scope (unchanged):** PR-row pills (#264), facet-trigger restyle, asc/desc toggle, manual-refresh button (#311).
