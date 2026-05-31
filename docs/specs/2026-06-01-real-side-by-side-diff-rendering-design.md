---
title: Real two-pane side-by-side diff rendering (slice 1 of 2)
date: 2026-06-01
type: feat
origin: docs/backlog/05-P4-polish.md (P4-B8 expansion via brainstorm 2026-06-01)
related:
  - docs/specs/2026-05-06-s3-pr-detail-read-design.md (declared whole-file diff expansion as P4-B8 backlog)
  - docs/backlog/05-P4-polish.md (P4-B8: per-file expand-context-to-full-file)
  - frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx (current renderer)
  - design/handoff/screens.css:660-664 (handoff side-by-side grid reference)
---

# Real two-pane side-by-side diff rendering — design (slice 1 of 2)

## 1. Goal

Make `<DiffPane>`'s existing `'side-by-side'` mode actually render two content panes. Today the `d` keyboard shortcut (`useFilesTabShortcuts` → `onToggleDiffMode`) and the `diffMode` state at `FilesTab.tsx:61` change a CSS className that no rule targets — so the toggle is silent and the two-pane layout reviewers expect from ADO never appears.

Slice 1 ships true two-pane rendering at **hunk-only scope** (the current range of unified-diff content). Slice 2 (separate brainstorm, after slice 1 lands) will layer ADO-style whole-file mode on top.

This slice is the production realization of backlog item **P4-B8** (`docs/backlog/05-P4-polish.md:96`), reshaped per the 2026-06-01 brainstorm to split renderer work (slice 1) from whole-file context work (slice 2). The original backlog wording bundled both; splitting them keeps each slice within "Effort: S" sizing.

## 2. Why now / scoping rationale

The toggle has been a stub since S3 (`docs/specs/2026-05-06-s3-pr-detail-read-design.md`). The source comment at `DiffPane.tsx:325-328` documents this explicitly:

> PoC scope: split-vs-unified mode currently renders the same two-gutter layout regardless. The `isSplit`-driven modeClass on the outer .diff-pane wrapper is the seam if/when split-mode introduces a real layout fork

Empirical verification (2026-06-01): `grep -rn 'diff-pane--split\|diff-pane--unified' frontend/src/` returns three hits — one in `DiffPane.tsx` setting the className on the wrapper, two in `DiffPane.test.tsx` asserting the className is applied — and zero CSS rules anywhere in `frontend/src/styles/` or `frontend/src/components/**/*.module.css` targeting those selectors. The handoff at `design/handoff/screens.css:660-664` specifies real two-pane (`grid-template-columns: 1fr 1fr`) but `diff-line-sbs` has zero matches in `frontend/src/` — the handoff layout was never ported.

User-visible cost: pressing `d` does nothing visible, which reads as a broken toggle. Slice 1 makes the toggle deliver what reviewers from ADO expect and what every prior PR9b slice's keyboard-shortcut taxonomy implied.

## 3. Out of scope (carried)

The following are **carried into slice 1's deferrals list** and not touched here:

- **Whole-file context expansion** — slice 2 (separate brainstorm). Slice 2 layers a "show full file" toggle on top of the renderer slice 1 ships. The renderer architecture in slice 1 is deliberately compatible with slice 2's eventual data-shape.
- **Left-side comment anchoring** — the iteration-relative `anchoredSha` plumbing called out at `DiffPane.tsx:297-302` stays deferred. Slice 1 only enables right-side comment affordances in split view. Bundling left-side anchoring would drag in per-iteration `beforeSha` plumbing that's been deliberately deferred since S4.
- **Multi-line modification block alignment** (Hunt–McIlroy / patience-diff line-level LCS within a change block). Slice 1 matches the **existing** `findAdjacentPair` pairing behavior (boundary delete pairs with boundary insert; mid-run lines render solo). Sophisticated row-alignment is post-PoC polish — not on the backlog today.
- **Per-pane scroll sync** — slice 1 uses a single `<table>` with one horizontal scroll, so sync is unnecessary. If a future slice splits into two `<div>`s with independent overflow, scroll sync becomes a new concern.
- **`diffMode` persistence across PR-detail mounts or sessions** — today resets to the `useState` default per `FilesTab` mount. Preserved.
- **`MarkdownFileView.tsx`** — defined but **never imported** in production (verified via grep 2026-06-01); orphan code, out of scope.
- **`<colgroup>`-driven equal-width enforcement under very narrow viewports** — the existing `useViewportWidth` gate at `FilesTab.tsx:64` forces `'unified'` below 900px, so the slice 1 split layout never has to defend itself against narrow viewports.

Each item above is documented in the deferrals sidecar that ships alongside this spec (see § 11).

## 4. Architecture: one DiffPane, mode-dependent column count

### 4.1 The decision

Single `<DiffPane>` component, single `<table>`. Column count is mode-dependent:

| Mode | Columns | Layout |
|------|---------|--------|
| Unified (today, unchanged) | 3 | `[oldGutter, newGutter, content]` |
| Split (new) | 4 | `[oldGutter, oldContent, newGutter, newContent]` |

The `DIFF_TABLE_COLSPAN = 3` constant at `DiffPane.tsx:105` becomes a per-render `colSpan = isSplit ? 4 : 3` value, threaded into the AI annotation row, the existing-comment-widget row, and the inline-composer-slot row.

### 4.2 Why not CSS Grid converge (option B from brainstorm)

A grid-based converged renderer (handoff-style) would be cleaner long-term but requires converting `<table>` → `<div role="table">`, which invalidates every existing DiffPane test that asserts `<table>`/`<tr>`/`<td>` structure and touches the comment-affordance hover targeting that already works. The DOM migration is a refactor with no user-visible benefit beyond the split-mode fix that approach C also delivers. Slice 2 may revisit if whole-file alignment-padding becomes thorny; slice 1 declines the churn.

### 4.3 Why not a separate split renderer (option A from brainstorm)

A separate `<SplitDiffView>` component would duplicate comment-widget, composer-slot, and AI-annotation row emission for every future DiffPane change to pay twice. Slice 1 keeps the **scaffold** (DiffPane structure, full-width row emission, hunk-counter tracking, fileThreads bucketing) inside `DiffPane.tsx` and only forks the per-line cell layout into a new row component. That's the dedup win of approach C: scaffold-shared, row-shape-forked.

## 5. Row iteration

### 5.1 Unified mode (unchanged)

The iteration body at `DiffPane.tsx:211-251` stays as-is. One `DiffLineRow` per parsed line. Adjacent insert+delete pairs trigger `WordDiffOverlay` rendering across two stacked rows. No regression risk.

### 5.2 Split mode (new)

```
let idx = 0;
let hunkCounter = -1;
while (idx < allLines.length) {
  const line = allLines[idx];
  const next = allLines[idx + 1];

  if (line.type === 'hunk-header') {
    hunkCounter += 1;
    emit <SplitDiffLineRow kind="header" content={line.content} />
    emit AI annotation rows for hunkCounter (each colSpan=4) as today
    idx += 1;
    continue;
  }

  if (line.type === 'delete' && next?.type === 'insert') {
    // Paired modification: single 4-cell row with word-diff on both sides.
    emit <SplitDiffLineRow
      kind="paired"
      oldLineNum={line.oldLineNum}
      newLineNum={next.newLineNum}
      oldText={line.content}
      newText={next.content}
    />
    emit existing-comment-widget row anchored to next.newLineNum (if any)
    emit composer-slot row anchored to next.newLineNum (if renderComposerForLine returns non-null)
    idx += 2;
    continue;
  }

  if (line.type === 'context') {
    emit <SplitDiffLineRow
      kind="context"
      oldLineNum={line.oldLineNum}
      newLineNum={line.newLineNum}
      content={line.content}
    />
    emit existing-comment-widget row anchored to line.newLineNum (if any)
    emit composer-slot row anchored to line.newLineNum (if renderComposerForLine returns non-null)
    idx += 1;
    continue;
  }

  if (line.type === 'delete') {
    // Solo delete: left filled, right empty. No comment affordance (no newLineNum).
    emit <SplitDiffLineRow kind="solo-delete" oldLineNum={line.oldLineNum} content={line.content} />
    idx += 1;
    continue;
  }

  if (line.type === 'insert') {
    // Solo insert: right filled, left empty. Comment affordance on new gutter.
    emit <SplitDiffLineRow kind="solo-insert" newLineNum={line.newLineNum} content={line.content} />
    emit existing-comment-widget row anchored to line.newLineNum (if any)
    emit composer-slot row anchored to line.newLineNum (if renderComposerForLine returns non-null)
    idx += 1;
    continue;
  }
}
```

### 5.3 Pairing algorithm consistency

The pairing rule above (delete[idx] + insert[idx+1] → paired) is **identical** to the existing `findAdjacentPair` at `DiffPane.tsx:92-103`. For a run like `[D, D, D, I]` the pairing in unified mode today is:

- idx=0 (D): next is D → no pair → word-diff overlay not invoked, render as solo delete.
- idx=1 (D): next is D → no pair → word-diff overlay not invoked, render as solo delete.
- idx=2 (D): next is I → paired → word-diff overlay invoked across this row and the next.
- idx=3 (I): prev is D → paired → word-diff overlay invoked across the previous row and this.

Split mode applies the **same** rule, just relocating the paired output from two stacked rows to two adjacent cells in one row. Solo-delete and solo-insert rendering matches today's solo-line rendering exactly, just placed into the appropriate side of a 4-cell row with the opposite side empty.

This is a deliberate "match existing behavior" choice. A more sophisticated alignment algorithm (e.g., walking equal-length runs and pairing across the whole run) would change how multi-line modification blocks look in BOTH unified and split modes — out of slice 1 scope.

## 6. Component changes

### 6.1 `DiffPane.tsx`

- Replace `DIFF_TABLE_COLSPAN = 3` (line 105) with a per-render `colSpan` computed from `isSplit`.
- Extract `renderDiffRows()` helper from the inline IIFE at lines 211-253. The helper branches on `isSplit`:
  - Unified branch: today's logic, emitting `<DiffLineRow>` per line.
  - Split branch: the iteration described in § 5.2, emitting `<SplitDiffLineRow>` per visual row.
- Both branches emit the AI annotation row, existing-comment-widget row, and composer-slot row at the appropriate position. These three full-width rows use the new mode-aware `colSpan` constant.
- The `modeClass = isSplit ? 'diff-pane--split' : 'diff-pane--unified'` (line 192) stays — it's now load-bearing because the CSS module rules below target it.
- The dead-ternary comment at `DiffPane.tsx:325-328` is removed (the seam it described is now wired).

### 6.2 New component: `SplitDiffLineRow`

Sibling to `DiffLineRow` in `DiffPane.tsx`. Five `kind` variants drive the cell shape:

| Kind | Cells | Comment affordance |
|------|-------|---------------------|
| `header` | one `<td colSpan={4}>` with `.diffHunkHeader` span | none |
| `paired` | `[oldNum, WordDiffOverlay(old,new,'delete'), newNum, WordDiffOverlay(old,new,'insert')]` | right gutter, anchored to `newLineNum` |
| `context` | `[oldNum, content, newNum, content]` (same content, two cells) | right gutter, anchored to `newLineNum` |
| `solo-delete` | `[oldNum, content, '', '']` | none (no `newLineNum`) |
| `solo-insert` | `['', '', newNum, content]` | right gutter, anchored to `newLineNum` |

The comment-affordance button is reused verbatim from `DiffLineRow` (the `.diffCommentAffordance` styling at `DiffPane.module.css:91-113` is gutter-anchored and works unchanged in the right-gutter cell of a 4-column row).

`onLineClick` and `replyContext` props match `DiffLineRow`'s. Side anchoring stays `'right'` only — left-side commenting deferral preserved per § 3.

### 6.3 `DiffPane.module.css`

New rules (the previously-no-op `.diff-pane--split` selector finally gets CSS):

- `.diffPane[data-mode='split'] .diffTable` (or equivalent) — column-width hints so the two content panes stay balanced.
- A vertical separator (`border-left: 1px solid var(--border-1)`) on the new-side gutter cell when in split mode, so the two panes have a visible divider.
- Empty-cell rendering (`&:empty` or explicit `aria-hidden="true"` on the empty `<td>`s, TBD by what reads cleanest in tests).

The diff-line tint rules (`.diff-line--insert / .diff-line--delete`) in `tokens.css` work in both modes since they target the row — slice 1 does not change `tokens.css`.

### 6.4 No backend changes

`PrDetailEndpoints.cs`, `IPrReader`, `DiffDto`, `FileChange`, `DiffHunk`, `parseHunkLines` — all unchanged. The same `FileChange` data feeds both modes; only the renderer differs.

### 6.5 No new API client / hook changes

`useFileDiff`, `useUnionDiff`, `useAiHunkAnnotations`, `useAiGate`, `useFilesTabShortcuts` — all unchanged.

## 7. Default state and toggle UX

`FilesTab.tsx:61` already defaults `diffMode` to `'side-by-side'`. After slice 1, that default produces the new two-pane layout for first-time visitors. This is a **deliberate behavior change**: the toggle was always intended to do this, and the default was set with that intent. Documented here so the PR description and the deferrals sidecar both call it out.

The keyboard shortcut (`d`) and viewport gate (`<900px` forces unified at `FilesTab.tsx:64`) are unchanged.

The `<button>` that toggles diff mode in the FilesTab toolbar — verify presence and accessibility (`aria-pressed`); add one if missing. (The brainstorm did not surface an existing button — only the `d` shortcut is wired. If no toolbar button exists, slice 1 adds one with `aria-pressed={diffMode === 'side-by-side'}` next to the existing range/commit pickers.)

## 8. Comment affordance, AI annotations, existing comments, composers

### 8.1 Comment affordance placement

Split mode:
- Present on the **new (right) gutter** for `context`, `paired`, and `solo-insert` rows.
- Absent for `solo-delete` and `header` rows.

This matches today's `canComment` predicate at `DiffPane.tsx:303-306`: `insert | context` lines on the new side. No new commentable lines are added in slice 1.

### 8.2 AI hunk annotation rows

Same logic as today (`DiffPane.tsx:236-249`): after each `hunk-header` row, look up `annotationsForFile.get(hunkCounter)` and emit one full-width `<tr>` per annotation. The `colSpan` value comes from the slice's mode-aware constant (4 in split, 3 in unified). `AiHunkAnnotation` component itself is unchanged.

### 8.3 Existing comment widget rows

Same logic as today (`DiffPane.tsx:351-357`): after a line row whose new-side line number has threads, emit one full-width `<tr>` wrapping `<ExistingCommentWidget>`. In split mode, threads attach to:
- `paired` rows → `next.newLineNum` (the right-side line of the pair).
- `context` rows → `line.newLineNum`.
- `solo-insert` rows → `line.newLineNum`.
- `solo-delete` rows → no threads attached (no right-side line number).

The thread-bucketing at `DiffPane.tsx:179-184` is unchanged (still groups by `newLineNum`).

### 8.4 Inline composer slot

Same logic as today (`DiffPane.tsx:358-364`): `ComposerSlot` renders if `renderComposerForLine(filePath, lineNumber)` returns non-null. In split mode, `lineNumber` is the new-side line per § 8.3.

## 9. Test plan

### 9.1 Vitest (`frontend/__tests__/DiffPane.test.tsx`)

Existing ~26 cases unchanged — all about unified mode rendering. New cases (target ~10):

| # | Scenario | Assertion |
|---|----------|-----------|
| 1 | Split mode paired modification row | 4 cells; both contain word-diff-overlay spans; left has `type='delete'` class, right has `type='insert'` class |
| 2 | Split mode solo delete | left gutter has line number; left content cell has line text; right gutter and right content are empty |
| 3 | Split mode solo insert | right gutter has line number; right content cell has line text; left gutter and left content are empty |
| 4 | Split mode context | both gutters populated; both content cells contain same text |
| 5 | Split mode hunk-header | one `<td colSpan={4}>` containing the `.diffHunkHeader` span |
| 6 | Split mode comment affordance presence | present on `paired`/`context`/`solo-insert`, absent on `solo-delete` and `header` |
| 7 | Split mode comment affordance anchors to right-side line number | clicking the affordance on a paired row produces an `InlineAnchor` whose `lineNumber === next.newLineNum` |
| 8 | Split mode existing-comment-widget row | full-width (`colSpan=4`); rendered under the row whose right-side line matches the thread's `lineNumber` |
| 9 | Split mode AI annotation row | full-width (`colSpan=4`); rendered after the hunk-header row for the corresponding `hunkCounter` |
| 10 | Word-diff overlay invoked twice per paired row | querying for `data-testid='word-diff-overlay'` within a paired row returns 2 elements |

Existing test at `DiffPane.test.tsx:189` (`expect(screen.getByTestId('diff-pane')).toHaveClass('diff-pane--split')`) and `:204` (`'diff-pane--unified'`) stay green — the wrapper className is still applied.

Viewport-gate regression guard: existing test that mounts at `<900px` and expects unified rendering still passes — `effectiveDiffMode` in FilesTab forces unified before DiffPane ever sees `'side-by-side'`.

### 9.2 Playwright

Extend existing `frontend/e2e/parity-baselines.spec.ts` (or add new `frontend/e2e/diff-pane-split.spec.ts` — TBD by what reads cleaner in plan):

| Scenario | Assertion |
|----------|-----------|
| Open Calc.cs in default mode | Two `data-testid='word-diff-overlay'` elements present on a known modification line (one with delete styling, one with insert styling) AND on the same DOM row (`closest('tr')` matches) |
| Press `d` | Single `word-diff-overlay` count returns to today's value (one per modification cell in stacked rows) |
| Press `d` again | Back to two-pane layout |
| Viewport <900px | `data-mode` (or equivalent) attribute on `.diffPane` reports unified regardless of stored `diffMode` |

### 9.3 Parity baseline recapture

`pr-detail-files-diff.png` baseline at `frontend/e2e/parity-baselines.spec.ts` (4 KB, captured PR #90 against the stubbed split mode) **will change** visually. The deferrals sidecar documents this as an intentional regression of the baseline (not a fidelity loss) and the recapture step is included in the plan.

## 10. Edge cases

| Case | Handling |
|------|----------|
| Empty file (`file.hunks.length === 0`) | Same as today — "Empty file — no changes to display." muted message. No mode-aware change. |
| Loading state (`isLoading && !file`) | Same as today — diff-pane-header + "Loading…" span. No mode-aware change. |
| Diff truncated (`truncated === true`) | Same as today — `<DiffTruncationBanner>` rendered below the table regardless of mode. |
| Iteration ranges / commit multi-select | Orthogonal — DiffPane receives the same `FileChange` shape regardless of which range the parent fetched. |
| Theme (dark / light) | Existing `.diff-line--insert / --delete` tint rules in `tokens.css` work in both modes. No theme-specific work. |
| Markdown raw mode | `MarkdownFileView.tsx` is dead code (verified 2026-06-01); not in scope. |
| AI gating off | No annotation rows emitted — same as today. |
| `replyContext === undefined` (test harness) | Existing-comment-widget row still renders, threads read-only — same as today. |

## 11. Deferrals sidecar

A companion file `docs/specs/2026-06-01-real-side-by-side-diff-rendering-deferrals.md` ships in the same commit. It enumerates:

- **DSx1** — Whole-file context (slice 2, separate brainstorm).
- **DSx2** — Left-side comment anchoring (existing deferral preserved).
- **DSx3** — Multi-line modification block alignment (post-PoC polish).
- **DSx4** — Per-pane scroll sync (out of scope at single-`<table>` architecture).
- **DSx5** — `diffMode` cross-session persistence (today's per-mount reset preserved).
- **DSx6** — Parity baseline recapture for `pr-detail-files-diff.png` (intentional visual change of the stub baseline).
- **DSx7** — Toolbar `<button>` for the toggle if not already present (slice 1 adds one if missing).
- **DSx8** — `MarkdownFileView.tsx` dead-code cleanup (out of scope; visible after slice 1 ships if reviewers notice).

Each entry follows the deferrals-sidecar format used in prior PR9b slices (e.g., `docs/specs/2026-05-29-design-parity-recovery-deferrals.md`).

## 12. Acceptance criteria

1. Pressing `d` (or the toolbar toggle when one exists) visibly switches between two-pane layout (left old, right new) and unified single-pane layout.
2. Every diff-rendered line that appears in unified mode also appears in split mode — no deletion or insertion drops visually.
3. Word-diff highlighting still applied to modification pairs in both modes (left half delete-styled, right half insert-styled).
4. Comment affordance behavior matches today's predicate (right gutter only, only on `insert`/`context`/paired-row lines).
5. AI hunk annotation rows render at hunk-header positions in both modes.
6. Existing comment widget rows and inline-composer slot rows span the full row width in both modes.
7. Viewport `<900px` continues to force unified rendering (existing behavior).
8. All existing `DiffPane.test.tsx` cases pass.
9. New vitest cases per § 9.1 pass.
10. New Playwright cases per § 9.2 pass.
11. Empty / loading / truncated states render unchanged.
12. Pre-push checklist per `.ai/docs/development-process.md` clean: `npm run lint`, `npm run build`, `npm run test`, `dotnet test` (no backend changes but full suite runs as a regression guard), `playwright test --project=prod`.

## 13. Effort estimate

2–3 days end-to-end:

| Phase | Effort |
|-------|--------|
| `DiffPane.tsx` row-iteration split branch + `SplitDiffLineRow` component | half-day |
| `DiffPane.module.css` rules for split mode + colgroup | half-day |
| ~10 new vitest assertions | half-day |
| Playwright spec + baseline recapture | half-day |
| Pre-push checklist + pr-autopilot loop | half-day |

## 14. References

- Brainstorm transcript: 2026-06-01 session continuation (this spec is the output).
- Backlog item: `docs/backlog/05-P4-polish.md:96` (P4-B8).
- S3 source declaration: `docs/specs/2026-05-06-s3-pr-detail-read-design.md:73`.
- Stub comment to remove: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx:325-328`.
- Handoff reference: `design/handoff/screens.css:660-664`.
- Comment-anchoring deferral that slice 1 preserves: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx:297-302`.
- Current `findAdjacentPair` algorithm slice 1 matches: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx:92-103`.
- Word-diff overlay component reused: `frontend/src/components/PrDetail/FilesTab/DiffPane/WordDiffOverlay.tsx`.
