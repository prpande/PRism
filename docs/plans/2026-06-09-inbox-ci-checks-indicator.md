# Inbox Leading Status Glyphs (#264) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `CiStatus.Passing` state, and render GitHub-parity leading status glyphs in the inbox row — a **PR-state icon** (open/merged/closed) prefixing the title, and a **CI glyph** (bare check / cross / amber dot) suffixing the title.

**Architecture:** Backend widens the `CiStatus` wire enum + detector (shipped, Tasks 1–4). Frontend reworks `InboxRow`: the leading 16px slot holds the PR-state octicon on every row; the title line becomes a flex row with the CI glyph pinned to its trailing edge (open rows only); the old meta-line "Merged/Closed" text badge is dropped. All glyph colours reuse existing shipped tokens.

**Tech Stack:** .NET 10 (xUnit + FluentAssertions), React + Vite + TS (Vitest + Testing Library), Playwright (B1 visual proof).

**Spec:** `docs/specs/2026-06-09-inbox-ci-checks-indicator-design.md`

---

## Status: backend complete (Tasks 1–4 shipped on the branch)

| Task | Commit | What |
|------|--------|------|
| 1 | `0a1b61ce` | `CiStatus.Passing` enum member + kebab-case wire test (4 cases) |
| 2 | `45f51d57` | detector emits `Passing` for all-green check-runs (`anyRun` entry-count; `Failing>Pending>Passing>None` precedence) |
| 3 | `ac88195c` | registered `success` combined-status → `Passing` |
| 4 | `c55a13b7` | precedence + degraded-not-cached tests (+ necessary rename of one pre-existing forbidden-status test) |

Full `PRism.GitHub.Tests` 225/225 green. **Remaining work: Tasks 5–7 (frontend + B1).**

---

## File Structure (remaining)

- Modify: `frontend/src/api/types.ts` — add `'passing'` to the `CiStatus` union (Task 5).
- Modify: `frontend/src/components/Inbox/InboxRow.tsx` — PR-state leading icon, CI title-suffix, badge removal, aria (Task 6).
- Modify: `frontend/src/components/Inbox/InboxRow.module.css` — `.prState*` + `.ciSuffix*` + `.titleRow`; delete `.dot*` + `.stateBadge`/`.badgeMerged`/`.badgeClosed` (Task 6).
- Modify: `frontend/src/components/Inbox/InboxRow.test.tsx` — rewrite CI tests, add PR-state tests, fix the merged-badge test (Task 6).
- Modify: `frontend/__tests__/InboxRow.test.tsx` — **a SECOND, duplicate-named test file** (the `__tests__` hazard, same as `usePrDetail.test.tsx`). Its `getByText('Merged')`/`getByText('Closed')` badge tests break on badge removal; rewrite them + the two `getByTitle('CI failing')` tests (Task 6 Step 1b). **Easy to miss — `npx vitest run` covers both files.**

---

## Notes for the implementer

- **All commands run in the worktree** `D:\src\PRism-264-ci-indicator`. Tool cwd resets to the main checkout each call — prefix with `cd /d/src/PRism-264-ci-indicator &&`.
- **One build/test at a time, foreground, timeout ≥ 300000ms.** Never parallelize.
- Frontend single-file test: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx`. Full build (real typecheck): `cd frontend && npm run build` (`tsc -b`; `--noEmit` is vacuous here).
- **Octicon paths below are verified** (Primer v19, 16-viewBox) — they were rendered in the owner-approved design preview. Copy verbatim.
- All glyph colours reuse existing `tokens.css` tokens: `--success-fg` (green), `--merged-fg` (purple), `--danger-fg` (red), `--warning-fg` (amber). **No new tokens.**

---

## Task 5: Add `'passing'` to the frontend `CiStatus` union

**Files:** Modify `frontend/src/api/types.ts`.

- [ ] **Step 1: Widen the union.** Change `frontend/src/api/types.ts` (the `CiStatus` line):

```typescript
export type CiStatus = 'none' | 'pending' | 'failing' | 'passing';
```

- [ ] **Step 2: Typecheck.** Run: `cd /d/src/PRism-264-ci-indicator/frontend && npm run build`
Expected: PASS. `FilterBar.tsx`'s `CI_VALUES: CiStatus[] = ['failing', 'pending']` is a valid subset and does not error.

- [ ] **Step 3: Commit.**
```bash
cd /d/src/PRism-264-ci-indicator && git add frontend/src/api/types.ts && git commit -m "feat(#264): add 'passing' to frontend CiStatus union

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Rework `InboxRow` render — PR-state leading icon + CI title-suffix + drop badge

This is the core frontend task. The leading 16px slot (currently the CI dot) becomes the **PR-state icon** on every row; the title becomes a flex `titleRow` with the **CI glyph** pinned to its trailing edge (open rows only); the meta-line "Merged/Closed" badge is removed. TDD: write the new tests, watch them fail, implement, pass.

**Files:**
- Modify: `frontend/src/components/Inbox/InboxRow.tsx`
- Modify: `frontend/src/components/Inbox/InboxRow.module.css`
- Test: `frontend/src/components/Inbox/InboxRow.test.tsx`

- [ ] **Step 1: Rewrite the test surface.** In `InboxRow.test.tsx`, **replace the entire `describe('InboxRow CI dot', ...)` block** with:

```tsx
describe('InboxRow PR-state leading icon', () => {
  it('renders the open glyph for an open PR', () => {
    const { container } = renderInboxRow({ ...PR, mergedAt: null, closedAt: null });
    expect(container.querySelector('[data-pr-state="open"]')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('· open');
  });

  it('renders the merged glyph + aria for a merged PR', () => {
    const { container } = renderInboxRow({ ...PR, mergedAt: new Date().toISOString() });
    expect(container.querySelector('[data-pr-state="merged"]')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('· merged');
  });

  it('renders the closed glyph + aria for a closed PR', () => {
    const { container } = renderInboxRow({ ...PR, closedAt: new Date().toISOString() });
    expect(container.querySelector('[data-pr-state="closed"]')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('· closed');
  });

  it('no longer renders a "Merged"/"Closed" text badge', () => {
    renderInboxRow({ ...PR, mergedAt: new Date().toISOString() });
    expect(screen.queryByText('Merged')).toBeNull();
  });
});

describe('InboxRow CI suffix glyph', () => {
  it('renders a passing check glyph + aria for an open passing PR', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'passing' });
    expect(container.querySelector('[data-ci="passing"]')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('CI passing');
  });

  it('renders a failing cross glyph + aria for an open failing PR', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'failing' });
    expect(container.querySelector('[data-ci="failing"]')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('CI failing');
  });

  it('renders a pending dot glyph + aria for an open pending PR', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'pending' });
    expect(container.querySelector('[data-ci="pending"]')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('CI pending');
  });

  it('renders no CI glyph and no CI suffix when ci is none', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'none' });
    expect(container.querySelector('[data-ci]')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).not.toContain('CI ');
  });

  it('renders no CI glyph on a done (merged) PR even when ci=failing', () => {
    const { container } = renderInboxRow({
      ...PR,
      ci: 'failing',
      mergedAt: new Date().toISOString(),
    });
    expect(container.querySelector('[data-ci]')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).not.toContain('CI ');
  });
});
```

Then, in the existing `describe('InboxRow chip + badge placement ...')` block, **replace** the test `renders the Merged badge on the meta line for a merged PR` with:

```tsx
  it('shows merged state via the leading icon + aria, not a meta-line badge', () => {
    const { container } = renderInboxRow({ ...PR, mergedAt: new Date().toISOString() });
    expect(container.querySelector('[data-pr-state="merged"]')).not.toBeNull();
    expect(screen.queryByText('Merged')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('· merged');
  });
```

- [ ] **Step 1b: Update the DUPLICATE test file `frontend/__tests__/InboxRow.test.tsx`.** This second, duplicate-named file (uses a `renderRow(pr, opts)` helper + `basePr` fixture) has two tests that assert the removed badge **text** (break) and two that assert CI via `getByTitle` (survive only by coincidence — the new CI `<svg>` carries `<title>CI failing</title>`). Replace all four for parity with the src-tree rewrite:

Replace `shows a Merged badge for a merged row`:
```tsx
  it('shows merged state via the leading icon + aria (no text badge)', () => {
    const { container } = renderRow({ ...basePr, mergedAt: new Date().toISOString() });
    expect(container.querySelector('[data-pr-state="merged"]')).not.toBeNull();
    expect(screen.queryByText('Merged')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('· merged');
  });
```

Replace `shows a Closed badge for a closed-unmerged row`:
```tsx
  it('shows closed state via the leading icon + aria (no text badge)', () => {
    const { container } = renderRow({ ...basePr, mergedAt: null, closedAt: new Date().toISOString() });
    expect(container.querySelector('[data-pr-state="closed"]')).not.toBeNull();
    expect(screen.queryByText('Closed')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('· closed');
  });
```

Replace `shows CI failing dot when ci is failing` (rename + assert the glyph, not the title text):
```tsx
  it('renders the CI failing glyph when ci is failing', () => {
    const { container } = renderRow({ ...basePr, ci: 'failing', lastViewedHeadSha: 'old-sha' });
    expect(container.querySelector('[data-ci="failing"]')).not.toBeNull();
  });
```

Replace `does not show the CI-failing dot on a done row`:
```tsx
  it('renders no CI glyph on a done row', () => {
    const { container } = renderRow({ ...basePr, ci: 'failing', mergedAt: new Date().toISOString() });
    expect(container.querySelector('[data-ci]')).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail.** Run: `cd /d/src/PRism-264-ci-indicator/frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx __tests__/InboxRow.test.tsx`
Expected: FAIL — `[data-pr-state]`/`[data-ci]` not found; `· open` not in aria-label; the badge still renders "Merged".

- [ ] **Step 3: Add module-level glyph constants to `InboxRow.tsx`.** Just above `interface Props`, after the imports, add:

```tsx
// ---- Leading PR-state octicons (Primer v19, 16-viewBox), every row ----
type PrState = 'open' | 'merged' | 'closed';
const PR_GLYPH_PATH: Record<PrState, string> = {
  open: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  merged: 'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm0-8a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z',
  closed: 'M10.72 1.227a.75.75 0 0 1 1.06 0l.97.97.97-.97a.75.75 0 1 1 1.06 1.061l-.97.97.97.97a.75.75 0 1 1-1.06 1.06l-.97-.97-.97.97a.75.75 0 1 1-1.06-1.06l.97-.97-.97-.97a.75.75 0 0 1 0-1.06Zm-9.22 2.02a2.25 2.25 0 1 1 3 2.123v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm10.5 7.503a2.25 2.25 0 1 1-1.5 0V8.755a.75.75 0 0 1 1.5 0ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
};
const PR_GLYPH_CLASS: Record<PrState, string> = { open: 'prOpen', merged: 'prMerged', closed: 'prClosed' };

// ---- CI title-suffix octicons (bare check / cross, no enclosing circle) ----
type VisibleCi = 'passing' | 'failing' | 'pending';
const CI_GLYPH_PATH: Record<VisibleCi, string> = {
  passing: 'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z',
  failing: 'M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z',
  pending: 'M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z',
};
const CI_GLYPH_CLASS: Record<VisibleCi, string> = {
  passing: 'ciPassing',
  failing: 'ciFailing',
  pending: 'ciPending',
};
// Single source of truth for the CI label — used for both the aria suffix and the <title>.
const CI_GLYPH_LABEL: Record<VisibleCi, string> = {
  passing: 'CI passing',
  failing: 'CI failing',
  pending: 'CI pending',
};
```

> Glyphs render uncoloured until Step 6 adds the colour classes — `vite/client` types CSS modules loosely so `styles.prOpen` etc. are just `undefined` until then. Expected mid-task.

- [ ] **Step 4: Compute `prState` and rewrite `ciSuffix` + `ariaLabel`.** In the component body, after the `doneState` line, add:

```tsx
  const prState: PrState = doneState ?? 'open';
```

Replace the existing `ciSuffix` block:

```tsx
  const ciSuffix =
    !isDone && pr.ci === 'failing'
      ? ' · CI failing'
      : !isDone && pr.ci === 'pending'
        ? ' · CI pending'
        : '';
```

with (the `pr.ci !== 'none'` guard narrows to `VisibleCi`):

```tsx
  // CI rides the aria-label (glyph is aria-hidden); open rows only. Reuses
  // CI_GLYPH_LABEL so the suffix and the <title> tooltip never drift.
  const ciSuffix = !isDone && pr.ci !== 'none' ? ` · ${CI_GLYPH_LABEL[pr.ci]}` : '';
```

Replace the `ariaLabel` block:

```tsx
  const ariaLabel = isDone
    ? `${pr.title} · ${pr.repo} · ${doneState}`
    : `${pr.title} · ${pr.repo} · iteration ${pr.iterationNumber}${
        hasUnseenActivity ? ' · unread' : ''
      }${ciSuffix}`;
```

with (adds `· open` so all three PR states announce symmetrically):

```tsx
  const ariaLabel = isDone
    ? `${pr.title} · ${pr.repo} · ${doneState}`
    : `${pr.title} · ${pr.repo} · open · iteration ${pr.iterationNumber}${
        hasUnseenActivity ? ' · unread' : ''
      }${ciSuffix}`;
```

- [ ] **Step 5: Replace the leading slot JSX and the title JSX.** Replace the entire status-slot block:

```tsx
      <span className={styles.status}>
        {!isDone && pr.ci === 'failing' ? (
          <span
            className={`${styles.dot} ${styles.dotFailing}`}
            title="CI failing"
            aria-hidden="true"
          />
        ) : !isDone && pr.ci === 'pending' ? (
          <span
            className={`${styles.dot} ${styles.dotPending}`}
            title="CI pending"
            aria-hidden="true"
          />
        ) : (
          <span className={styles.dot} style={{ opacity: 0 }} aria-hidden="true" />
        )}
      </span>
```

with the PR-state icon (always rendered):

```tsx
      <span className={styles.status}>
        <svg
          className={`${styles.prState} ${styles[PR_GLYPH_CLASS[prState]]}`}
          data-pr-state={prState}
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="currentColor"
          aria-hidden="true"
        >
          <title>{`PR ${prState}`}</title>
          <path d={PR_GLYPH_PATH[prState]} />
        </svg>
      </span>
```

Then replace the title span:

```tsx
        <span className={styles.title} title={pr.title}>
          {pr.title}
        </span>
```

with the title row (title + trailing CI glyph, open rows only):

```tsx
        <span className={styles.titleRow}>
          <span className={styles.title} title={pr.title}>
            {pr.title}
          </span>
          {!isDone && pr.ci !== 'none' && (
            <svg
              className={`${styles.ciSuffix} ${styles[CI_GLYPH_CLASS[pr.ci]]}`}
              data-ci={pr.ci}
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="currentColor"
              aria-hidden="true"
            >
              <title>{CI_GLYPH_LABEL[pr.ci]}</title>
              <path d={CI_GLYPH_PATH[pr.ci]} />
            </svg>
          )}
        </span>
```

- [ ] **Step 6: Remove the meta-line badge JSX.** Delete both badge blocks from the `.meta` span:

```tsx
          {doneState === 'merged' && (
            <>
              <span className={`${styles.stateBadge} ${styles.badgeMerged}`}>Merged</span>
              <span className={styles.dotsep}>·</span>
            </>
          )}
          {doneState === 'closed' && (
            <>
              <span className={`${styles.stateBadge} ${styles.badgeClosed}`}>Closed</span>
              <span className={styles.dotsep}>·</span>
            </>
          )}
```

(Delete all 12 lines — the merged and closed badge blocks. Leave the chip/repo/author/iter/age meta content intact.)

- [ ] **Step 7: Update `InboxRow.module.css`.** Replace the `.dot` / `.dotFailing` / `.dotPending` rules (under `.status`) with the PR-state + CI-suffix rules, and delete the badge rules.

Delete these three rules:

```css
.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.dotFailing {
  background: var(--danger-fg);
}

/* Hollow ring — shape distinguishes pending from failing without relying on
   hue, so CI state reads in greyscale / for colour-blind users / against any
   user-chosen accent. Explicit border-box (not just the global reset) keeps the
   1.5px border inside the 8×8 dot rather than expanding it to ~11px. */
.dotPending {
  box-sizing: border-box;
  background: transparent;
  border: 1.5px solid var(--warning-fg);
}
```

and in their place add:

```css
/* Leading PR-state octicon — 14px glyph centred in the 16px grid track (the
   track, not this element, reserves the column). Shown on every row. */
.prState {
  display: block;
  width: 14px;
  height: 14px;
}
.prOpen {
  color: var(--success-fg);
}
.prMerged {
  color: var(--merged-fg);
}
.prClosed {
  color: var(--danger-fg);
}

/* Title row: title (clamped) + trailing CI glyph pinned to the first line. */
.titleRow {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: 4px;
}

/* CI suffix octicon — bare check / cross / amber dot, no enclosing circle, so
   the three shapes stay distinct in greyscale (spec Decision 4). align-self
   flex-start + a small top offset optically centres it on the title's first
   line, not the midpoint of a two-line title. */
.ciSuffix {
  flex: none;
  width: 14px;
  height: 14px;
  align-self: flex-start;
  margin-top: 2px;
}
.ciPassing {
  color: var(--success-fg);
}
.ciFailing {
  color: var(--danger-fg);
}
.ciPending {
  color: var(--warning-fg);
}
```

Then in the `.title` rule, **remove** `margin-bottom: 4px;` (it moved to `.titleRow`) and add `flex: 1; min-width: 0;` so the title takes the row's width and the clamp still truncates:

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
  flex: 1;
  min-width: 0;
}
```

Finally, **delete** the three badge rules:

```css
/* Done-state badge — text is the primary signal, colour is secondary */
.stateBadge {
  display: inline-flex;
  align-items: center;
  font-size: var(--text-2xs);
  font-weight: 600;
  letter-spacing: 0.02em;
}

.badgeMerged {
  color: var(--merged-fg);
}

.badgeClosed {
  color: var(--danger-fg);
}
```

- [ ] **Step 8: Verify no orphaned references** across the component **and both** test files. Run (Grep tool equivalent): `grep -rn "dotFailing\|dotPending\|stateBadge\|badgeMerged\|badgeClosed\|getByText('Merged')\|getByText('Closed')" frontend/src/components/Inbox/InboxRow.tsx frontend/src/components/Inbox/InboxRow.test.tsx frontend/__tests__/InboxRow.test.tsx`
Expected: **no matches.** (The identically-named `.dot` in `AccentSwatches`/`WindowControls`/`PrTabStrip` are separate CSS modules — untouched.)

- [ ] **Step 9: Run the InboxRow tests — expect PASS.** Run: `cd /d/src/PRism-264-ci-indicator/frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx`
Expected: PASS (all PR-state, CI-suffix, badge-removal, and the untouched click/avatar/title/meta/tail/grouped tests).

- [ ] **Step 10: Build + full vitest + lint.** Run, one at a time:
  - `cd /d/src/PRism-264-ci-indicator/frontend && npm run build` → PASS (typecheck clean)
  - `cd /d/src/PRism-264-ci-indicator/frontend && npx vitest run` → all green
  - `cd /d/src/PRism-264-ci-indicator/frontend && node ./node_modules/prettier/bin/prettier.cjs --check . && npm run lint` → clean (run prettier directly; rtk masks it)

- [ ] **Step 11: Commit.**
```bash
cd /d/src/PRism-264-ci-indicator && git add frontend/src/components/Inbox/InboxRow.tsx frontend/src/components/Inbox/InboxRow.module.css frontend/src/components/Inbox/InboxRow.test.tsx frontend/__tests__/InboxRow.test.tsx && git commit -m "feat(#264): leading PR-state icon + CI title-suffix in InboxRow

PR-state octicon (open/merged/closed) prefixes the title on every row;
bare check/cross/dot CI glyph suffixes the title on open rows; drop the
meta-line Merged/Closed text badge (state now in icon + aria-label, incl.
new '· open'). All colours reuse existing tokens.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: B1 visual proof — full matrix, light + dark

Owner sign-off gate. Produces screenshots from the **built app** (the design-preview mockup was static; this is the real render). Not a merge-blocking automated test.

- [ ] **Step 1: Launch the app.** Run: `cd /d/src/PRism-264-ci-indicator && ./run.ps1 -Port 5180 -Reset None --no-browser` (`-Port` before `--no-browser`; use `serve-detached.ps1` for a long-lived server).

- [ ] **Step 2: Mock the inbox payload** with a Playwright route fulfilling `**/api/inbox` (and the auth/state endpoints, per #272/#273) so the page shows one row per case: **open × {passing, failing, pending, none}** plus one **merged** and one **closed** row. Use the `PrInboxItem` shape from `frontend/src/api/types.ts` (open rows: `mergedAt:null, closedAt:null`; distinct `headSha`/`lastViewedHeadSha` to avoid spurious unread; valid counts).

- [ ] **Step 3: Capture light + dark** screenshots, plus desaturated copies (CSS `filter: grayscale(1)` or post-process) for the Decision-4 check.

- [ ] **Step 4: Three checks** (per spec Testing):
  - **Contrast:** `--success-fg`/`--danger-fg`/`--warning-fg`/`--merged-fg` AA against the row surface in both themes (all existing tokens — confirming use, not deriving).
  - **Greyscale legibility:** bare ✓ vs ✗ tellable apart at 14px (expected clean — the design preview already confirmed it).
  - **Flanking read:** open+passing row reads as two distinct green signals, not a smear. If it fails, apply the spec Decision 1 fallback (mute the open icon to a neutral token) and re-capture.

- [ ] **Step 5: Post to the PR** for owner sign-off — host PNGs on a throwaway `review-assets/pr-264` branch, embed via raw URLs. **Do not merge** until the owner approves the visual.

---

## Definition of Done

- [ ] Backend green (already): `cd /d/src/PRism-264-ci-indicator && dotnet test` (one run).
- [ ] Frontend green + build clean: `npm run build && npx vitest run`.
- [ ] Lint/format clean (prettier run directly, not via rtk).
- [ ] Full pre-push checklist (`.ai/docs/development-process.md`) executed.
- [ ] `origin/main` synced into the branch before push.
- [ ] B1 screenshots posted; **owner visual sign-off before merge** (gated issue).
- [ ] PR via `pr-autopilot`; `@claude review` + Copilot addressed.

---

## Spec → task coverage

| Spec item | Task |
|---|---|
| `CiStatus.Passing` enum + detector (`anyRun`, precedence, success→Passing, degraded-not-cached) | 1–4 (shipped) |
| FE union `'passing'` | 5 |
| PR-state leading icon (open/merged/closed), every row, existing tokens | 6 |
| CI title-suffix, bare check/x/dot, open rows only | 6 |
| Drop meta-line badge; state in icon + aria | 6 |
| aria `· open` symmetry; CI aria suffix for 3 states | 6 |
| Delete `.dot*` + badge CSS; `.titleRow` flex; `align-self: flex-start` | 6 |
| Update the 2 breaking existing tests | 6 (Step 1) |
| B1: full matrix light+dark via `/api/inbox` mock; greyscale + flanking + contrast | 7 |
