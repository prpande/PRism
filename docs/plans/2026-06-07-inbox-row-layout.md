# Inbox Row Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound inbox-row height (2-line title clamp + single-line meta) and column-align the right-rail metrics across rows, sections, and repo groups — frontend-only, per [#227](https://github.com/prpande/PRism/issues/227).

**Architecture:** Keep the title-over-meta row shape (bounded-rhythm list, not a table). Align by making the tail a **fixed-width grid track** (`--inbox-tail-w`) holding a right-pinned metrics cluster with reserve-and-collapse slots, and by **moving the repo-group indent off the row box** onto a leading `--row-indent` grid track so flat and grouped rows share one right edge. CI state reads via **shape + semantic colour + label**, independent of the user-chosen accent. Responsive via a `@container` query on the inbox `.sections` column.

**Tech Stack:** React 19 + TypeScript + Vite, CSS Modules, Vitest + Testing Library. Runtime is Chromium/Electron + modern browsers (container queries are native — Chromium 105+; no polyfill).

**Spec:** `docs/specs/2026-06-07-inbox-row-layout-design.md`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `frontend/src/components/Inbox/InboxRow.tsx` | Row markup: CI dot, title+`title` attr, single-line meta, reserved tail slots, `grouped`/CI in `aria-label` | Modify |
| `frontend/src/components/Inbox/InboxRow.module.css` | Row grid (indent + tail tracks), title clamp, meta nowrap, dot shapes, tail/metrics slots, `@container` rules | Modify |
| `frontend/src/components/Inbox/InboxRow.test.tsx` | Unit tests for the above DOM/aria hooks | Modify |
| `frontend/src/components/Inbox/RepoGroupAccordion.tsx` | Pass `grouped` to nested rows | Modify |
| `frontend/src/components/Inbox/RepoGroupAccordion.module.css` | Remove `.body` `padding-left` (indent now on the row) | Modify |
| `frontend/src/components/Inbox/RepoGroupAccordion.test.tsx` | Assert nested rows are `data-grouped` | Modify |
| `frontend/src/pages/InboxPage.module.css` | Establish `container-type: inline-size` on `.sections` | Modify |

**What unit tests can and can't prove here:** Vitest (jsdom) asserts DOM structure, classes, attributes, and `aria-label` text — the *hooks* the CSS hangs on. It cannot assert pixel alignment or computed CSS-module styles. Pixel alignment, the title clamp, dot shapes, and responsive drops are verified in the **B1 visual pass** (Task 7), which is the real assertion for those. Tasks below test every DOM hook; CSS-only behavior is called out as B1-verified rather than faked with a green-but-meaningless test.

---

## Task 1: Shared test helper + full title via `title` attribute

**Files:**
- Modify: `frontend/src/components/Inbox/InboxRow.tsx`
- Test: `frontend/src/components/Inbox/InboxRow.test.tsx`

- [ ] **Step 1: Add a shared render helper + the failing test**

Add this helper near the top of `InboxRow.test.tsx` (after the existing `PR` constant), and a new `describe` block. The helper is reused by later tasks.

```tsx
function renderInboxRow(pr: PrInboxItem = PR, props: Partial<Parameters<typeof InboxRow>[0]> = {}) {
  return render(
    <MemoryRouter>
      <OpenTabsProvider>
        <InboxRow pr={pr} showCategoryChip={false} maxDiff={100} {...props} />
      </OpenTabsProvider>
    </MemoryRouter>,
  );
}

describe('InboxRow title', () => {
  it('exposes the full title via the title attribute and aria-label so a clamped title is recoverable', () => {
    const long = { ...PR, title: 'Refactor the pagination cursor encoder to be stable across reorders and deletes' };
    const { container } = renderInboxRow(long);
    const titleEl = container.querySelector('[class*="title"]')!;
    expect(titleEl.getAttribute('title')).toBe(long.title);
    // truncation hides nothing from AT: the untruncated title stays in the aria-label
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain(long.title);
  });
});
```

(No `import React` needed — `Parameters<typeof InboxRow>[0]` is the Props type via a built-in TS utility, matching the no-React-import pattern in the other test files.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx -t "full title via the title attribute"`
Expected: FAIL — `title` attribute is `null` (not yet rendered).

- [ ] **Step 3: Add the `title` attribute to the `.title` span**

In `InboxRow.tsx`, change the title span (currently line 58):

```tsx
<span className={styles.title} title={pr.title}>
  {pr.title}
</span>
```

(The `title` goes on the `.title` span, NOT the button — the button already carries `aria-label`.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx -t "full title via the title attribute"`
Expected: PASS

- [ ] **Step 5: Apply the 2-line clamp CSS**

In `InboxRow.module.css`, replace the `.title` rule (currently lines 66-73):

```css
.title {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2; /* forward-compat alias; the -webkit-box trio above is the operative clamp */
  overflow: hidden;
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-1);
  margin-bottom: 4px;
}
```

(`text-wrap: pretty` is removed; the clamp now bounds height. No fixed row height — the row stays `align-items: center` and the tail centers against the title block.)

- [ ] **Step 6: Run the full row test file + commit**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx`
Expected: PASS (all existing + new)

```bash
git add frontend/src/components/Inbox/InboxRow.tsx frontend/src/components/Inbox/InboxRow.module.css frontend/src/components/Inbox/InboxRow.test.tsx
git commit -m "feat(#227): clamp inbox title to 2 lines, full title in title attr"
```

---

## Task 2: Single-line meta with author truncation hook

**Files:**
- Modify: `frontend/src/components/Inbox/InboxRow.tsx`
- Modify: `frontend/src/components/Inbox/InboxRow.module.css`
- Test: `frontend/src/components/Inbox/InboxRow.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `InboxRow.test.tsx`:

```tsx
describe('InboxRow meta', () => {
  it('wraps the author name in a dedicated truncating span so the meta line stays single-line', () => {
    renderInboxRow(PR);
    const name = screen.getByText(PR.author);
    expect(name.className).toMatch(/authorName/);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx -t "single-line"`
Expected: FAIL — the author name span has no `authorName` class today.

- [ ] **Step 3: Wrap the author name**

In `InboxRow.tsx`, change the author name span (currently line 68) from `<span>{pr.author}</span>` to:

```tsx
<span className={styles.authorName}>{pr.author}</span>
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx -t "single-line"`
Expected: PASS

- [ ] **Step 5: Apply the single-line meta CSS**

In `InboxRow.module.css`, change `.meta` (currently lines 75-82) — replace `flex-wrap: wrap;` with `flex-wrap: nowrap;` and add `overflow: hidden;`:

```css
.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-xs);
  color: var(--text-3);
  flex-wrap: nowrap;
  overflow: hidden;
}
```

Then add a truncation rule for the author name (the most variable field) so it shrinks first; `.author` already has `min-width: 0`:

```css
.authorName {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

The short fields (`repo`, `iter`, `age`) hold; `dotsep` separators stay inline. The line never wraps to a second row (visual — B1).

- [ ] **Step 6: Run the file + commit**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx`
Expected: PASS

```bash
git add frontend/src/components/Inbox/InboxRow.tsx frontend/src/components/Inbox/InboxRow.module.css frontend/src/components/Inbox/InboxRow.test.tsx
git commit -m "feat(#227): single-line inbox meta with author truncation"
```

---

## Task 3: CI dot — failing (solid) + pending (ring), accent-independent, with aria-label

**Files:**
- Modify: `frontend/src/components/Inbox/InboxRow.tsx`
- Modify: `frontend/src/components/Inbox/InboxRow.module.css`
- Test: `frontend/src/components/Inbox/InboxRow.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `InboxRow.test.tsx`:

```tsx
describe('InboxRow CI dot', () => {
  it('renders a solid failing dot and names it in the aria-label for open PRs', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'failing' });
    expect(container.querySelector('[class*="dotFailing"]')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('CI failing');
  });

  it('renders a hollow-ring pending dot and names it in the aria-label for open PRs', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'pending' });
    expect(container.querySelector('[class*="dotPending"]')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('CI pending');
  });

  it('shows no CI dot and no CI suffix when ci is none', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'none' });
    expect(container.querySelector('[class*="dotFailing"]')).toBeNull();
    expect(container.querySelector('[class*="dotPending"]')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).not.toContain('CI ');
  });

  it('never shows a CI dot or CI suffix on a done (merged) PR even when ci=failing', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'failing', mergedAt: new Date().toISOString() });
    expect(container.querySelector('[class*="dotFailing"]')).toBeNull();
    expect(container.querySelector('[class*="dotPending"]')).toBeNull();
    // AT parity: the hidden dot means no "CI failing" in the label either
    expect(screen.getByRole('button').getAttribute('aria-label')).not.toContain('CI ');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx -t "CI dot"`
Expected: FAIL — `dotFailing`/`dotPending` classes don't exist; aria-label lacks CI suffix.

- [ ] **Step 3: Implement the dot + aria-label suffix**

In `InboxRow.tsx`, replace the `ariaLabel` block (currently lines 37-41) with a CI-aware version:

```tsx
const ciSuffix =
  !isDone && pr.ci === 'failing'
    ? ' · CI failing'
    : !isDone && pr.ci === 'pending'
      ? ' · CI pending'
      : '';

const ariaLabel = isDone
  ? `${pr.title} · ${pr.repo} · ${doneState}`
  : `${pr.title} · ${pr.repo} · iteration ${pr.iterationNumber}${
      hasUnseenActivity ? ' · unread' : ''
    }${ciSuffix}`;
```

Replace the status-dot block (currently lines 50-56) with:

```tsx
<span className={styles.status}>
  {!isDone && pr.ci === 'failing' ? (
    <span className={`${styles.dot} ${styles.dotFailing}`} title="CI failing" />
  ) : !isDone && pr.ci === 'pending' ? (
    <span className={`${styles.dot} ${styles.dotPending}`} title="CI pending" />
  ) : (
    <span className={styles.dot} style={{ opacity: 0 }} aria-hidden="true" />
  )}
</span>
```

- [ ] **Step 4: Run, verify pass**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx -t "CI dot"`
Expected: PASS

- [ ] **Step 5: Implement the dot shapes (CSS)**

In `InboxRow.module.css`, rename `.dotDanger` (currently lines 55-57) to `.dotFailing` and add `.dotPending`. Semantic tokens only — never `--accent`:

```css
.dotFailing {
  background: var(--danger-fg);
}

/* Hollow ring — shape distinguishes pending from failing without relying on
   hue, so CI state reads in greyscale / for colour-blind users / against any
   user-chosen accent. box-sizing:border-box keeps the ring an 8px dot. */
.dotPending {
  background: transparent;
  border: 1.5px solid var(--warning-fg);
}
```

- [ ] **Step 6: Run the file + commit**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx`
Expected: PASS

```bash
git add frontend/src/components/Inbox/InboxRow.tsx frontend/src/components/Inbox/InboxRow.module.css frontend/src/components/Inbox/InboxRow.test.tsx
git commit -m "feat(#227): CI dot shows pending (ring) + failing (solid), accent-independent"
```

---

## Task 4: Fixed-width tail + right-pinned metrics with reserve-and-collapse slots

**Files:**
- Modify: `frontend/src/components/Inbox/InboxRow.tsx`
- Modify: `frontend/src/components/Inbox/InboxRow.module.css`
- Test: `frontend/src/components/Inbox/InboxRow.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `InboxRow.test.tsx`:

```tsx
describe('InboxRow tail reserve-and-collapse', () => {
  it('always reserves the diff, counts, and comment slots', () => {
    const { container } = renderInboxRow({ ...PR, additions: 0, deletions: 0, commentCount: 0 });
    expect(container.querySelector('[class*="diffSlot"]')).not.toBeNull();
    expect(container.querySelector('[class*="countsSlot"]')).not.toBeNull();
    expect(container.querySelector('[class*="commentSlot"]')).not.toBeNull();
  });

  it('renders the diff-bar slot empty at zero diff but keeps the counts populated', () => {
    const { container } = renderInboxRow({ ...PR, additions: 0, deletions: 0 });
    const diffSlot = container.querySelector('[class*="diffSlot"]')!;
    expect(diffSlot.querySelector('[class*="diffbar"]')).toBeNull(); // DiffBar returns null at zero total
    expect(container.querySelector('[class*="countsSlot"]')!.textContent).toContain('+0');
  });

  it('renders the comment slot empty when commentCount is 0', () => {
    const { container } = renderInboxRow({ ...PR, commentCount: 0 });
    expect(container.querySelector('[class*="commentSlot"]')!.querySelector('[class*="comments"]')).toBeNull();
  });

  it('renders the comment count when commentCount > 0', () => {
    const { container } = renderInboxRow({ ...PR, commentCount: 5 });
    expect(container.querySelector('[class*="commentSlot"]')!.textContent).toContain('5');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx -t "reserve-and-collapse"`
Expected: FAIL — `diffSlot`/`countsSlot`/`commentSlot` don't exist.

- [ ] **Step 3: Restructure the tail markup**

In `InboxRow.tsx`, replace the entire `<span className={styles.tail}>…</span>` block (currently lines 76-92) with a leading zone + a fixed metrics cluster whose slots always render:

```tsx
<span className={styles.tail}>
  <span className={styles.tailLead}>
    {doneState === 'merged' && (
      <span className={`${styles.stateBadge} ${styles.badgeMerged}`}>Merged</span>
    )}
    {doneState === 'closed' && (
      <span className={`${styles.stateBadge} ${styles.badgeClosed}`}>Closed</span>
    )}
    {showCategoryChip && enrichment?.categoryChip && (
      <span className={styles.chip}>{enrichment.categoryChip}</span>
    )}
  </span>
  <span className={styles.metrics}>
    <span className={styles.diffSlot}>
      <DiffBar additions={pr.additions} deletions={pr.deletions} max={maxDiff} />
    </span>
    <span className={`${styles.counts} ${styles.countsSlot}`}>
      <span className={styles.add}>+{pr.additions}</span>
      <span className={styles.del}>−{pr.deletions}</span>
    </span>
    <span className={styles.commentSlot}>
      {pr.commentCount > 0 && <span className={styles.comments}>{pr.commentCount}</span>}
    </span>
  </span>
</span>
```

- [ ] **Step 4: Run, verify pass**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx -t "reserve-and-collapse"`
Expected: PASS

- [ ] **Step 5: Apply the grid + tail + metrics CSS**

In `InboxRow.module.css`:

(a) Change only the **third** track of the `.row` grid (currently line 4) from `auto` to the fixed `var(--inbox-tail-w)`, and seed the token. Keep it a 3-track grid — the three child spans auto-place into the three tracks exactly as today, so **no `grid-column` placement is needed**. (The repo-group indent is applied via `padding-left` in Task 5, NOT a leading grid track — a zero-width leading track would still take a `gap` and push flat-row content right.)

```css
.row {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) var(--inbox-tail-w);
  --inbox-tail-w: 200px; /* ~140px metrics + ~60px badge/chip zone; tuned in B1 */
  gap: var(--s-3);
  width: 100%;
  padding: var(--s-3) var(--s-4);
  text-align: left;
  border-bottom: 1px solid var(--border-1);
  align-items: center;
  transition: background var(--t-fast);
  position: relative;
  background: transparent;
  cursor: pointer;
}
```

(`.status` and `.main` are unchanged — leave their existing rules as-is.)

(b) Replace the `.tail` rule (currently lines 101-105) and add the leading zone + metrics + slots:

```css
.tail {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  min-width: 0;
}

/* Badge + AI chip flow here, left of the metrics; takes the slack and
   truncates so it never pushes the right-pinned metrics. */
.tailLead {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--s-3);
  overflow: hidden;
}

/* Right-pinned, fixed-width slots in fixed order — this is what makes the
   numbers line up column-for-column across rows. */
.metrics {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--s-3);
  justify-content: flex-end;
}

.diffSlot {
  flex: none;
  width: 64px; /* matches DiffBar track width */
  display: flex;
  justify-content: flex-end;
}

.countsSlot {
  flex: none;
  width: 72px;
  justify-content: flex-end;
  font-variant-numeric: tabular-nums;
}

.commentSlot {
  flex: none;
  width: 28px;
  display: flex;
  justify-content: flex-end;
}
```

The existing `.counts` rule (`display: flex; gap: 6px; font-mono; font-size: 11px`, lines 135-140) **stays as-is** — the counts span carries both classes (`${styles.counts} ${styles.countsSlot}`): `.counts` keeps its existing flex/mono styling, `.countsSlot` adds the fixed width + right-justify + tabular-nums. Do not delete `.counts`. (Note: the deletions render uses a U+2212 `−`, not an ASCII hyphen — any future `toContain` assertion on the minus must use `−`.)

(c) Constrain the AI chip so a long category can't blow the lead zone (add `max-width` + ellipsis to the existing `.chip` rule, lines 107-116):

```css
.chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: var(--radius-2);
  font-size: var(--text-2xs);
  font-weight: 500;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 6: Run the file + commit**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx`
Expected: PASS

```bash
git add frontend/src/components/Inbox/InboxRow.tsx frontend/src/components/Inbox/InboxRow.module.css frontend/src/components/Inbox/InboxRow.test.tsx
git commit -m "feat(#227): fixed-width tail with right-pinned reserve-and-collapse metrics"
```

---

## Task 5: Move the repo-group indent off the accordion body onto the row

**Depends on:** Task 4 (the row's `--inbox-tail-w` tail track must exist first; this task adds the leading indent via `padding-left` so the fixed tail stays flush across flat + grouped rows).

**Files:**
- Modify: `frontend/src/components/Inbox/InboxRow.tsx`
- Modify: `frontend/src/components/Inbox/InboxRow.module.css`
- Modify: `frontend/src/components/Inbox/RepoGroupAccordion.tsx`
- Modify: `frontend/src/components/Inbox/RepoGroupAccordion.module.css`
- Test: `frontend/src/components/Inbox/InboxRow.test.tsx`, `frontend/src/components/Inbox/RepoGroupAccordion.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `InboxRow.test.tsx`:

```tsx
describe('InboxRow grouped indent', () => {
  it('marks grouped rows with data-grouped=true', () => {
    renderInboxRow(PR, { grouped: true });
    expect(screen.getByRole('button').getAttribute('data-grouped')).toBe('true');
  });

  it('flat rows are data-grouped=false', () => {
    renderInboxRow(PR);
    expect(screen.getByRole('button').getAttribute('data-grouped')).toBe('false');
  });
});
```

Add to `RepoGroupAccordion.test.tsx` — **reuse the file's existing `renderAcc(defaultOpen)` helper and `group` const** (already defined at lines 29-45; all imports — `render`, `MemoryRouter`, `OpenTabsProvider` — are already present). Add this `it` inside the existing `describe('RepoGroupAccordion', …)` block. Do **not** add new imports or a new fixture:

```tsx
it('renders its nested rows as grouped (data-grouped=true)', () => {
  const { container } = renderAcc(true);
  const rows = container.querySelectorAll('button[data-grouped="true"]');
  expect(rows.length).toBe(2); // the shared `group` const has 2 items
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx src/components/Inbox/RepoGroupAccordion.test.tsx -t "grouped"`
Expected: FAIL — no `grouped` prop / `data-grouped` attribute yet.

- [ ] **Step 3: Add the `grouped` prop to InboxRow**

In `InboxRow.tsx`, extend `Props` and the signature, and emit `data-grouped`:

```tsx
interface Props {
  pr: PrInboxItem;
  enrichment?: InboxItemEnrichment;
  showCategoryChip: boolean;
  maxDiff: number;
  showRepo?: boolean;
  grouped?: boolean;
}

export function InboxRow({ pr, enrichment, showCategoryChip, maxDiff, showRepo = true, grouped = false }: Props) {
```

On the `<button>` (currently lines 44-49), add the attribute:

```tsx
<button
  className={styles.row}
  data-unread={hasUnseenActivity ? 'true' : 'false'}
  data-grouped={grouped ? 'true' : 'false'}
  onClick={onClick}
  aria-label={ariaLabel}
>
```

- [ ] **Step 4: Pass `grouped` from the accordion**

In `RepoGroupAccordion.tsx`, add `grouped` to the nested `<InboxRow>` (currently lines 59-67):

```tsx
<InboxRow
  key={id}
  pr={pr}
  enrichment={enrichments[id]}
  showCategoryChip={showCategoryChip}
  maxDiff={maxDiff}
  showRepo={false}
  grouped
/>
```

- [ ] **Step 5: Run, verify pass**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx src/components/Inbox/RepoGroupAccordion.test.tsx -t "grouped"`
Expected: PASS

- [ ] **Step 6: Move the indent (CSS)**

In `InboxRow.module.css`, apply the grouped indent as **extra left padding** on the row (NOT a leading grid track — a zero-width track still takes a `gap`). With `box-sizing: border-box` (global), padding eats into the `width: 100%` content box, so the tail's right edge stays flush with flat rows while the leading content indents:

```css
/* Indent grouped rows via left padding, not the accordion body, so the tail's
   right edge stays flush with flat rows and the metrics align across flat +
   grouped rows (border-box keeps width:100% honest). */
.row[data-grouped='true'] {
  padding-left: calc(var(--s-4) + var(--s-4));
}
```

(The base `.row` already has `padding: var(--s-3) var(--s-4)`; this override adds one more `--s-4` of left padding for grouped rows only. The unread `::before` accent bar stays at `left: 0`, consistent for flat and grouped.)

In `RepoGroupAccordion.module.css`, **delete** the now-redundant body indent rule (currently lines 60-63):

```css
/* DELETE these lines — the indent now lives on the row (see InboxRow.module.css). */
/* Rows indent under the band so the group reads as nested. */
.body {
  padding-left: var(--s-4);
}
```

(Delete the whole rule, not just the property — `.body` has no other declarations, and nothing else references it. Prettier/eslint don't gate `.css`, but an empty rule is dead weight.)

- [ ] **Step 7: Run both files + commit**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx src/components/Inbox/RepoGroupAccordion.test.tsx`
Expected: PASS

```bash
git add frontend/src/components/Inbox/InboxRow.tsx frontend/src/components/Inbox/InboxRow.module.css frontend/src/components/Inbox/RepoGroupAccordion.tsx frontend/src/components/Inbox/RepoGroupAccordion.module.css frontend/src/components/Inbox/InboxRow.test.tsx frontend/src/components/Inbox/RepoGroupAccordion.test.tsx
git commit -m "feat(#227): move repo-group indent onto the row (padding) for flush tail alignment"
```

---

## Task 6: Responsive — container query on the inbox sections column

**Files:**
- Modify: `frontend/src/pages/InboxPage.module.css`
- Modify: `frontend/src/components/Inbox/InboxRow.module.css`

This task is **CSS-only** (responsive drop behavior); there is no jsdom unit test for `@container` breakpoints. It is verified in the B1 visual pass (Task 7) at a narrow pane. Steps are still incremental + committed.

- [ ] **Step 1: Establish the container**

In `InboxPage.module.css`, add `container-type` to `.sections` (currently lines 20-24) so the row can query *its own* column width (not the viewport — the rail flip makes viewport a bad proxy, see spec):

```css
.sections {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  container-type: inline-size;
}
```

(Container queries are native in all supported targets — Chromium/Electron 105+, modern browsers — so no polyfill is needed. `container-type: inline-size` adds inline-axis containment only; `.sections` is width-driven, so there is no height/layout side effect.)

- [ ] **Step 2: Add the `@container` rules**

In `InboxRow.module.css`, append the responsive drops. Below the narrow threshold, shrink the tail and drop the diff bar first, then the AI chip:

```css
/* Pane-relative responsive: the row responds to the named inbox-sections
   container's width. Alignment is a within-regime invariant — the metrics
   column shifts once at the breakpoint (tail width changes), by design.
   Threshold tuned in B1. */
@container inbox-sections (max-width: 560px) {
  .row {
    --inbox-tail-w: 136px;
  }
  /* Drop diff bar AND AI chip together — a squeezed-but-present chip clamps to a
     cryptic ~1-char stub (caught in the B1 pass), worse than dropping it. */
  .diffSlot {
    display: none;
  }
  .chip {
    display: none;
  }
}
```

(B1 note: the container is named `inbox-sections` (set on `.sections` in `InboxPage.module.css`) so a future ancestor container can't hijack the breakpoint; and the chip drops at the same 560px breakpoint as the diff bar rather than a separate 460px one.)

- [ ] **Step 3: Sanity-run the suite + commit**

Run: `cd frontend && npx vitest run src/components/Inbox/`
Expected: PASS (no regressions; the `@container` rules don't affect jsdom assertions).

```bash
git add frontend/src/pages/InboxPage.module.css frontend/src/components/Inbox/InboxRow.module.css
git commit -m "feat(#227): pane-relative responsive inbox rows via container query"
```

---

## Task 7: Full verification, B1 visual proof, and PR

**Files:** none (verification + ship)

- [ ] **Step 1: Full local pre-push checklist**

Run each step in `.ai/docs/development-process.md`. At minimum, from the repo root:

```bash
cd frontend && npx vitest run
node ./node_modules/prettier/bin/prettier.cjs --check .
npm run lint
npm run build   # tsc -b + vite build — the real typecheck (tsc --noEmit is a no-op here)
```

Expected: all green. (Run prettier directly, not via rtk — rtk can mask check output. See memory.)

- [ ] **Step 2: Launch the real app and capture B1 proof**

Per memory, launch via `run.ps1` (Development + real PAT), not hand-rolled `dotnet run`:

```powershell
./run.ps1 -Reset None --no-browser
```

Open the inbox at `localhost:5180` against the real account (the BFF repo `mindbody/Mindbody.BizApp.Bff` has long titles and varied diffs — ideal). Capture screenshots with Playwright MCP in **light + dark** at a **normal** and a **narrow** pane width, showing:
- Bounded row heights (no long-title blowups; clamp at 2 lines).
- Metrics numbers lining up down the column **across sections and across repo groups** (flat + grouped rows share the right edge).
- `pending` (ring) and `failing` (solid) dots distinguishable.
- No horizontal overflow at the narrow width; diff bar dropped, counts/comments retained.

- [ ] **Step 3: Verify acceptance criteria against the running app**

Tick each #227 criterion: bounded title height + full title on hover; columns align incl. when optional fields absent; field set decided (CI pending promoted, approval/draft → #259); responsive narrow behavior, no overflow; single actionable control with complete `aria-label`; light + dark proof captured.

- [ ] **Step 4: Open the PR via pr-autopilot**

Sync `origin/main` into the branch first (see memory), then use the `pr-autopilot` skill. The PR body MUST include the `## Proof` section (per `.ai/docs/issue-resolution-workflow.md`): acceptance-criteria checklist with screenshot refs, secrets scan over the diff, and the light/dark visual proof (host PNGs on a throwaway `review-assets/pr-N` branch, embed via raw URLs).

- [ ] **Step 5: B1 gate — pause for the human**

This is a B1 (UI-visual) gate: after green-and-ready, **post a comment @-mentioning `prpande`** with the PR link and the visual proof for the eyeball-assert, then stop. The human merges. Do not self-merge.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Goal 1 (title height) → Task 1. ✓
- Goal 2 (column alignment) → Task 4 (fixed tail + right-pinned metrics) + Task 5 (indent move, the cross-group fix). ✓
- Goal 3 (field set) → Task 3 (CI pending promoted) + #259 split documented; no field removed. ✓
- Single-line meta → Task 2. ✓
- CI accent-independence (shape + semantic colour + label) → Task 3. ✓
- Reserve-and-collapse → Task 4. ✓
- Responsive → Task 6. ✓
- Accessibility (aria-label CI, `title` attr) → Task 1 + Task 3. ✓
- B1 visual proof, light+dark, real account → Task 7. ✓

**Placeholder scan:** No TBD/TODO. `--inbox-tail-w` (200px) and the container thresholds (560/460px) are concrete starting values explicitly flagged for B1 tuning, not placeholders.

**Type/name consistency:** `grouped` prop + `data-grouped` attr consistent (Task 5). Class names `diffSlot`/`countsSlot`/`commentSlot`/`tailLead`/`metrics`/`dotFailing`/`dotPending`/`authorName` defined in the CSS task that introduces each and matched in tests (verified no `[class*=...]` selector collisions: `comments`≠`commentSlot`, `counts`+`countsSlot` both intended on one span). `.counts` is pre-existing and retained. `--inbox-tail-w` consistent (Task 4 default 200px / Task 6 narrow override). Grouped indent is `padding-left` on the row (Task 5), not a grid track — a zero-width leading track would take a `gap` (ce-doc-review C1).
