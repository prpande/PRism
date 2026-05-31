---
title: Real two-pane side-by-side diff rendering (slice 1 of 2)
date: 2026-06-01
type: feat
origin: docs/backlog/05-P4-polish.md (P4-B8 prerequisite, surfaced via brainstorm 2026-06-01)
related:
  - docs/specs/2026-05-06-s3-pr-detail-read-design.md (declared whole-file diff expansion as P4-B8 backlog)
  - docs/backlog/05-P4-polish.md (P4-B8: per-file expand-context-to-full-file)
  - frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx (current renderer)
  - design/handoff/screens.css:660-674 (handoff side-by-side grid reference)
---

# Real two-pane side-by-side diff rendering — design (slice 1 of 2)

## 1. Goal

Make `<DiffPane>`'s existing `'side-by-side'` mode actually render two content panes — AND establish the renderer foundation that slice 2's ADO-style whole-file mode will layer on top.

Slice 1 has two honest motivations, both real:

1. **Fix the stubbed toggle.** The `d` keyboard shortcut (`useFilesTabShortcuts` → `onToggleDiffMode`) and the `diffMode` state at `FilesTab.tsx:61` change a CSS className that no rule targets, so the toggle has been visually silent since S3. The default of `'side-by-side'` was set during S3 with the intent of an ADO-aligned positioning, but until slice 1 ships, no user has experienced that default visually.
2. **Unblock slice 2.** ADO-style whole-file mode (P4-B8's actual backlog wording) needs a working two-pane renderer first. Slice 1 builds the renderer; slice 2 layers whole-file context on top.

Slice 1 is honestly the prerequisite, not the deliverable, of P4-B8. The backlog entry talks about whole-file context; the brainstorm split off the renderer work because shipping the two as one slice would exceed Effort: S sizing. See § 2 for the scope-shift acknowledgement.

## 2. Why now / scoping rationale

The toggle has been a stub since S3 (`docs/specs/2026-05-06-s3-pr-detail-read-design.md:73`). The source comment at `DiffPane.tsx:325-328` documents this explicitly:

> PoC scope: split-vs-unified mode currently renders the same two-gutter layout regardless. The `isSplit`-driven modeClass on the outer .diff-pane wrapper is the seam if/when split-mode introduces a real layout fork

Empirical verification (2026-06-01): `grep -rn 'diff-pane--split\|diff-pane--unified' frontend/src/` returns three hits — one in `DiffPane.tsx` setting the className on the wrapper, two in `DiffPane.test.tsx` asserting the className is applied — and zero CSS rules anywhere in `frontend/src/styles/` or `frontend/src/components/**/*.module.css` targeting those selectors. The handoff at `design/handoff/screens.css:660-674` specifies real two-pane (`grid-template-columns: 1fr 1fr`) but `diff-line-sbs` has zero matches in `frontend/src/` — the handoff layout was never ported.

**Scope-shift from P4-B8 backlog wording.** P4-B8 is written as "Per-file expand-context-to-full-file — Show full file content with the diff highlighted, on demand." The renderer-architecture work in slice 1 isn't in the backlog at all — it's the prerequisite the brainstorm surfaced. The backlog's "revisit if reviewers complain" gate specifically refers to whole-file context, not the renderer stub. Slice 1 reshapes P4-B8 into two slices, and the `docs/backlog/05-P4-polish.md` entry should be updated to note the split when slice 1 lands.

## 3. Out of scope (carried)

- **Whole-file context expansion** — slice 2 (separate brainstorm). The actual P4-B8 deliverable.
- **Left-side comment anchoring** — the iteration-relative `anchoredSha` plumbing called out at `DiffPane.tsx:297-302` stays deferred. Slice 1 only enables right-side comment affordances in split view.
- **Multi-line modification block alignment** (Hunt–McIlroy / patience-diff line-level LCS). See § 5.4 for the visual implication slice 1 ships with, and DSx3 in the sidecar.
- **Per-pane scroll sync** — slice 1 uses a single `<table>` with shared horizontal scroll. See DSx4 in the sidecar for the trade-off slice 1 explicitly accepts.
- **`diffMode` persistence across PR-detail mounts or sessions** — preserved.
- **`MarkdownFileView.tsx`** — defined but never imported in production (verified via grep 2026-06-01); orphan code.

Each item above is documented in the deferrals sidecar (see § 11).

## 4. Architecture: one DiffPane, mode-dependent column count

### 4.1 The decision

Single `<DiffPane>` component, single `<table>`. Column count is mode-dependent:

| Mode | Columns | Layout |
|------|---------|--------|
| Unified (today, unchanged) | 3 | `[oldGutter, newGutter, content]` |
| Split (new) | 4 | `[oldGutter, oldContent, newGutter, newContent]` |

The `DIFF_TABLE_COLSPAN = 3` constant at `DiffPane.tsx:105` becomes a per-render `colSpan = isSplit ? 4 : 3` value, threaded into the AI annotation row, the existing-comment-widget row, and the inline-composer-slot row.

The full-table layout uses an explicit `<colgroup>` so the two content cells stay balanced even when one side is empty (sparse rows must still hold their column slot). The CSS rule lives in `DiffPane.module.css` under a `:global(.diff-pane--split)` selector that targets the existing global className already set on the wrapper at `DiffPane.tsx:192`.

### 4.2 Alternatives rejected

- **Option A (separate split renderer component).** Duplicates comment-widget, composer-slot, and AI-annotation row emission. Every future DiffPane change pays the cost twice.
- **Option B (CSS Grid converged renderer, handoff-style).** Full DOM migration from `<table>` to `<div role="table">` invalidates every existing DiffPane test for no user-visible benefit beyond what option C delivers.

If slice 2 introduces alignment-padding requirements that make the grid migration cheaper than working around the table, revisit option B then. Slice 1 declines the churn.

### 4.3 Single-`<table>` trade-off accepted

Slice 1's single-`<table>` means one horizontal scrollbar shared by both panes. On `[D,D]` solo-delete rows or `[I,I]` solo-insert rows, the empty pane's gutter and content cells still occupy column space — so horizontal scrolling reveals empty space on the short side. Slice 2's whole-file mode may force a renderer rewrite if it surfaces independent vertical scroll requirements (long files where one side has +500 and the other -200 lines diverge in pane height). Slice 1 commits to single-table with that trade-off documented in DSx4; the brainstorm that opens slice 2 should treat the renderer as a candidate for restructuring, not a constraint.

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

Split mode applies the **same** rule, just relocating the paired output from two stacked rows to two adjacent cells in one row.

### 5.4 Multi-line modification block visual implication

A `[D,D,D,I]` run in slice 1's split mode produces: two solo-delete rows (left filled, right empty), then one paired-modification row. Visually this looks "fragmented" compared to ADO's aligned-block rendering. The same fragmentation exists in unified mode today (two solo delete rows + a stacked pair), but the visual cost is higher in split mode because the right pane shows large vertical runs of empty cells next to filled left-side cells.

Slice 1 ships this fragmentation knowingly because:
- Hunt-McIlroy-style row-alignment changes BOTH modes' output and is its own design decision (DSx3).
- The `d` shortcut + the toolbar toggle (per § 7) make falling back to unified mode trivial.
- Real-world fragmentation severity is bounded by hunk-size: `findAdjacentPair` only fails to pair across mixed runs WITHIN a hunk, and PRism's diff payloads bound hunks to GitHub's standard context window.

DSx3 captures the future trigger. If reviewer use surfaces fragmentation as actively bad (the lead engineer hits it on 3+ consecutive PRs and reaches for the toggle), the deferral closes by either landing alignment or flipping the default (see § 7.1).

## 6. Component changes

### 6.1 `DiffPane.tsx`

- Replace `DIFF_TABLE_COLSPAN = 3` (line 105) with a per-render `colSpan` computed from `isSplit`.
- Replace the two hard-coded `colSpan={3}` literals at `DiffPane.tsx:353` (existing-comment-widget row) and `DiffPane.tsx:385` (composer-slot row) with the same mode-aware constant. The AI annotation row at `DiffPane.tsx:243` already uses the constant — update it to the mode-aware version.
- Extract `renderDiffRows()` helper from the inline IIFE at lines 211-253. The helper branches on `isSplit`:
  - Unified branch: today's logic, emitting `<DiffLineRow>` per line.
  - Split branch: the iteration described in § 5.2, emitting `<SplitDiffLineRow>` per visual row.
- Both branches emit the AI annotation row, existing-comment-widget row, and composer-slot row at the appropriate position. These three full-width rows use the new mode-aware `colSpan` constant.
- The `modeClass = isSplit ? 'diff-pane--split' : 'diff-pane--unified'` (line 192) stays and is now load-bearing — the CSS module rules below target it via `:global(.diff-pane--split)`.
- The dead-ternary comment at `DiffPane.tsx:325-328` is removed (the seam it described is now wired).

### 6.2 New component: `SplitDiffLineRow`

Sibling to `DiffLineRow` in `DiffPane.tsx`. Five `kind` variants drive the cell shape:

| Kind | Cells | Comment affordance |
|------|-------|---------------------|
| `header` | one `<td colSpan={4}>` with `.diffHunkHeader` span | none |
| `paired` | `[oldNum, WordDiffOverlay(old,new,'delete'), newNum, WordDiffOverlay(old,new,'insert')]` | right gutter, anchored to `newLineNum` |
| `context` | `[oldNum, content, newNum, content]` (same content, two cells) | right gutter, anchored to `newLineNum` |
| `solo-delete` | `[oldNum, content, empty, empty]` | none (no `newLineNum`) |
| `solo-insert` | `[empty, empty, newNum, content]` | right gutter, anchored to `newLineNum` |

**`WordDiffOverlay` call shape on paired rows.** Both cells receive the SAME `oldText` and `newText`; only the `type` differs. The left cell renders `<WordDiffOverlay oldText={line.content} newText={next.content} type='delete' />` which displays the OLD text with deleted segments highlighted; the right cell renders `<WordDiffOverlay oldText={line.content} newText={next.content} type='insert' />` which displays the NEW text with inserted segments highlighted. Same diff pairing, two complementary renderings. This matches today's unified-mode behavior where two stacked rows each call WordDiffOverlay with the same inputs and opposite `type`.

**Right-gutter cell className.** The right-gutter cell in `<SplitDiffLineRow>` MUST receive the same composite className as `DiffLineRow`'s new-gutter cell: `` `diff-gutter diff-gutter--new ${styles.diffGutter} ${styles.diffGutterNew}` ``. This is load-bearing: the existing hover selector `.diffGutterNew:hover .diffCommentAffordance` at `DiffPane.module.css:110` triggers via the CSS-module hash class; using a different class name would silently break hover-to-reveal on the affordance button.

**Empty cells.** Empty `<td>` elements receive `aria-hidden="true"` to silence screen-reader announcement of empty table cells (a navigating screen reader would otherwise read each empty cell). They also receive a `${styles.diffCellEmpty}` class for the CSS rule in § 6.3.

**Left-side affordance not added.** Slice 1 does NOT add `position: relative` to `.diffGutterOld` and does NOT add an affordance button on the left gutter. Left-side comment anchoring stays in DSx2. When DSx2 lands, the left-gutter affordance gets its positioning context then.

### 6.3 `DiffPane.module.css`

New rules under `:global(.diff-pane--split)`:

- **Column widths via `<colgroup>`.** The table emits a `<colgroup>` in split mode with four `<col>` widths: `[3em, auto, 3em, auto]`. The two `auto` content columns share remaining width equally via `table-layout: fixed` scoped to split mode.
- **Vertical pane separator.** `:global(.diff-pane--split) .diffGutterNew { border-left: 1px solid var(--border-1); }`. This places the divider between the old-content column and the new-gutter column — the same boundary the handoff's `.diff-half + .diff-half` rule at `design/handoff/screens.css:674` targets.
- **Empty-cell visual treatment.** `:global(.diff-pane--split) .diffCellEmpty { background: var(--surface-1); }`. This neutralizes the row tint on the empty half of solo-delete and solo-insert rows. Without this, a delete-row tint cascades into the empty right cells and produces a uniformly red row across both panes — the wrong visual signal.
- **Row tint isolation.** In split mode the `.diff-line--insert` / `.diff-line--delete` row classes color only the populated content cell (`:global(.diff-pane--split) .diff-line--insert .diffContent { background: var(--diff-insert-bg); }` and the symmetric delete rule). The row-level tint rules from `tokens.css` continue to apply in unified mode (where they target the full row).
- **Long-line policy.** Split-mode content cells use `white-space: pre; overflow: visible` (the same policy as unified mode). The table widens past the pane to accommodate long lines and the body's `overflow: auto` handles horizontal scroll. The empty-side scroll trade-off is documented in § 4.3 and DSx4.

No changes to global `tokens.css` — the existing `--diff-insert-bg` / `--diff-delete-bg` tokens are reused for cell-level tints.

### 6.4 No backend changes

`PrDetailEndpoints.cs`, `IPrReader`, `DiffDto`, `FileChange`, `DiffHunk`, `parseHunkLines` — all unchanged.

### 6.5 No new API client / hook changes

`useFileDiff`, `useUnionDiff`, `useAiHunkAnnotations`, `useAiGate`, `useFilesTabShortcuts` — all unchanged.

## 7. Default state and toggle UX

`FilesTab.tsx:61` already defaults `diffMode` to `'side-by-side'`. After slice 1, that default produces the new two-pane layout. The existing `useFilesTabShortcuts` (`d` shortcut) and viewport gate (`<900px` forces unified at `FilesTab.tsx:64`) are unchanged.

**Toolbar button.** Verified 2026-06-01: `FilesTab.tsx:343-357` contains only `CommitMultiSelectPicker` and `IterationTabStrip` — NO diff-mode button exists today. Slice 1 adds one:

- A `<button>` placed in the `files-tab-toolbar` after the iteration/commit pickers.
- Label: "Side-by-side" when `effectiveDiffMode === 'side-by-side'`, "Unified" when `'unified'`. (Stateful label communicates current mode without an icon.)
- `aria-pressed={diffMode === 'side-by-side'}` for assistive tech.
- Disabled (with `aria-disabled="true"`) when `viewportWidth < 900` so the user sees the gate is forcing unified rather than the button being broken.
- On click: calls `handleToggleDiffMode` (same handler the `d` shortcut uses).

### 7.1 Default choice rationale (`'side-by-side'`)

GitHub defaults to unified; ADO defaults to side-by-side. Keeping `'side-by-side'` as the slice 1 default rather than flipping to `'unified'` for the launch:

- Owns the ADO-aligned positioning explicitly. The toggle (button + `d` shortcut) makes switching trivial; the choice isn't buried in preferences.
- Avoids a two-step default migration (flip to unified for slice 1, flip back later) that would surprise users twice.
- Accepts the multi-line block fragmentation risk per § 5.4 — the `d` shortcut is the escape valve.

Rejected alternatives:
- **Flip default to unified for slice 1 launch.** Safer launch posture but introduces a known temporary state.
- **One-time chooser on first PR mount.** Over-engineered for a single sole-owner audience.

Future trigger: if multi-line block fragmentation makes split mode actively bad (lead engineer reaches for the `d` fallback on 3+ consecutive PRs), close DSx3 by landing alignment or flip the default.

## 8. Comment affordance, AI annotations, existing comments, composers

### 8.1 Comment affordance placement

Split mode:
- Present on the **new (right) gutter** for `context`, `paired`, and `solo-insert` rows.
- Absent for `solo-delete` and `header` rows.

The affordance button's CSS at `DiffPane.module.css:91-113` uses `position: absolute; left: 2px` relative to its parent `.diffGutterNew` (which is `position: relative`). In a 4-column table the new-gutter cell is column 3 of 4. The `position: relative` context remains correct because § 6.2 commits to applying `${styles.diffGutterNew}` to the right-gutter cell. The affordance is positioned within that cell, not relative to the table.

Left-side commenting deferral preserved (DSx2). Slice 1 does NOT add `position: relative` to `.diffGutterOld` — that's DSx2's setup.

### 8.2 AI hunk annotation rows

Same logic as today (`DiffPane.tsx:236-249`): after each `hunk-header` row, look up `annotationsForFile.get(hunkCounter)` and emit one full-width `<tr>` per annotation. The `colSpan` value comes from the mode-aware constant (4 in split, 3 in unified). `AiHunkAnnotation` component itself is unchanged.

**Visual continuity in split mode.** The hunk-header row and the AI annotation row(s) are both full-width (`colSpan=4`) immediately stacked. Both retain their existing background tokens (`--surface-2` for the hunk header; `AiHunkAnnotation`'s internal styling for the annotation row). The CSS rule `:global(.diff-pane--split) .aiHunkRow + .aiHunkRow + .diffHunkHeader` does NOT need a separator — the existing background contrast between the two component types already reads as related-but-distinct.

### 8.3 Existing comment widget rows

Same logic as today (`DiffPane.tsx:351-357`): after a line row whose new-side line number has threads, emit one full-width `<tr>` wrapping `<ExistingCommentWidget>`. In split mode, threads attach to:
- `paired` rows → `next.newLineNum` (the right-side line of the pair).
- `context` rows → `line.newLineNum`.
- `solo-insert` rows → `line.newLineNum`.
- `solo-delete` rows → no threads attached (no right-side line number).

`ReviewThreadDto.lineNumber` is always a right-side (new-file) line number — the wire contract from GitHub already filters left-side comments into a separate channel. The `threadsByLine` map at `DiffPane.tsx:179-184` therefore never contains a thread keyed to a deleted-only line, and slice 1's solo-delete-no-widget rule is consistent with the data shape.

### 8.4 Inline composer slot

Same logic as today (`DiffPane.tsx:358-364`): `ComposerSlot` renders if `renderComposerForLine(filePath, lineNumber)` returns non-null. In split mode, `lineNumber` is the new-side line per § 8.3.

## 9. Test plan

### 9.1 Vitest (`frontend/__tests__/DiffPane.test.tsx`)

Existing 9 cases unchanged — verified count via `grep -c 'it(' frontend/__tests__/DiffPane.test.tsx`. New cases (target 9):

| # | Scenario | Assertion |
|---|----------|-----------|
| 1 | Split mode paired modification row | 4 cells; exactly 2 `data-testid='word-diff-overlay'` elements within the row; left has `type='delete'` styling, right has `type='insert'` styling |
| 2 | Split mode solo delete | left gutter has line number; left content cell has line text; right gutter and right content elements have `aria-hidden="true"` and `${styles.diffCellEmpty}` class |
| 3 | Split mode solo insert | right gutter has line number; right content cell has line text; left gutter and left content have `aria-hidden="true"` and `${styles.diffCellEmpty}` class |
| 4 | Split mode context | both gutters populated; both content cells contain same text |
| 5 | Split mode hunk-header | one `<td colSpan={4}>` containing the `.diffHunkHeader` span |
| 6 | Split mode comment affordance presence | present on `paired`/`context`/`solo-insert`, absent on `solo-delete` and `header` |
| 7 | Split mode comment affordance anchors to right-side line number | clicking the affordance on a paired row produces an `InlineAnchor` whose `lineNumber` equals the paired row's right-side (new) line number |
| 8 | Split mode existing-comment-widget row | full-width (`colSpan=4`); rendered under the row whose right-side line matches the thread's `lineNumber` |
| 9 | Split mode AI annotation row | full-width (`colSpan=4`); rendered after the hunk-header row for the corresponding `hunkCounter` |

Existing test at `DiffPane.test.tsx:189` (`expect(screen.getByTestId('diff-pane')).toHaveClass('diff-pane--split')`) and `:204` (`'diff-pane--unified'`) stay green — the wrapper className is still applied.

Viewport-gate regression guard: existing test that mounts at `<900px` and expects unified rendering still passes — `effectiveDiffMode` in FilesTab forces unified before DiffPane ever sees `'side-by-side'`.

### 9.2 Playwright

Extend existing `frontend/e2e/parity-baselines.spec.ts` (the existing `pr-detail-files-diff` baseline test at `parity-baselines.spec.ts:177-188` already selects `src/Calc.cs` via the data-testid-migrated locator, so co-location keeps the diff-pane assertions in one file):

| Scenario | Assertion |
|----------|-----------|
| Open Calc.cs in default mode | A row containing both a delete-styled and an insert-styled `word-diff-overlay` exists (i.e., a paired row in split mode shows two overlay elements on the SAME `<tr>`) |
| Press `d` to switch to unified | A paired modification shows two `word-diff-overlay` elements on TWO different `<tr>`s (one in the delete row, one in the insert row) — matching today's unified rendering |
| Press `d` again | Back to paired-row layout with both overlays on one `<tr>` |
| Viewport <900px | The wrapper className contains `'diff-pane--unified'` regardless of stored `diffMode` |

The DOM topology (same `<tr>` vs different `<tr>`s) is the differentiator; the overlay COUNT is the same (2 per paired modification) in both modes.

### 9.3 Parity baseline change

`pr-detail-files-diff.png` baseline at `frontend/e2e/parity-baselines.spec.ts:177-188` (4 KB, captured PR #90 against the stubbed split mode) **will change** visually. This is an intentional visual change of the stub baseline — the stub is replaced with true two-pane rendering, not a fidelity loss. Slice 1's plan includes a baseline recapture step.

## 10. Edge cases

| Case | Handling |
|------|----------|
| Empty file (`file.hunks.length === 0`) | Same as today — "Empty file — no changes to display." muted message. No mode-aware change. |
| Loading state (`isLoading && !file`) | Same as today — diff-pane-header + "Loading…" span. No mode-aware change. |
| Diff truncated (`truncated === true`) | Same as today — `<DiffTruncationBanner>` rendered below the table regardless of mode. |
| File deleted in PR (`status === 'deleted'`, hunks present) | All rows are `solo-delete`. Right pane shows full-height empty cells. Intentional — communicates "this file was removed" at a glance. |
| File newly added in PR (`status === 'added'`) | All rows are `solo-insert`. Left pane shows full-height empty cells. Intentional symmetric to deleted-file case. |
| Viewport resize across 900px threshold mid-render | `effectiveDiffMode` re-evaluates per render; DiffPane re-renders with the new column count. Row keys may differ between modes (split uses paired-row index hops; unified uses per-line index). React unmounts and remounts the row tree. An open inline composer survives because composer state lives on FilesTab (`activeAnchor`/`composerDraftId`), not on the row. Documented PoC behavior — out of slice 1 scope to optimize. |
| Iteration ranges / commit multi-select | Orthogonal — DiffPane receives the same `FileChange` shape regardless of which range the parent fetched. |
| Theme (dark / light) | Existing `.diff-line--insert / --delete` tint rules in `tokens.css` work in both modes via the cell-scoped rules in § 6.3. |
| Markdown raw mode | `MarkdownFileView.tsx` is dead code (verified 2026-06-01); not in scope. |
| AI gating off | No annotation rows emitted — same as today. |
| `replyContext === undefined` (test harness) | Existing-comment-widget row still renders, threads read-only — same as today. |

## 11. Deferrals sidecar

A companion file `docs/specs/2026-06-01-real-side-by-side-diff-rendering-deferrals.md` ships in the same commit, with five entries:

- **DSx1** — Whole-file context (slice 2, separate brainstorm; the actual P4-B8 deliverable).
- **DSx2** — Left-side comment anchoring (existing deferral preserved).
- **DSx3** — Multi-line modification block alignment (post-PoC polish; visual implication documented in § 5.4).
- **DSx4** — Per-pane scroll sync (out of scope at single-`<table>` architecture; trade-off documented in § 4.3).
- **DSx5** — `diffMode` cross-session / cross-mount persistence (preserved out of scope).

## 12. Acceptance criteria

1. Pressing `d` OR clicking the new toolbar button (per § 7) visibly switches between two-pane layout (left old, right new) and unified single-pane layout.
2. Every diff-rendered line that appears in unified mode also appears in split mode — no deletion or insertion drops visually.
3. Word-diff highlighting still applied to modification pairs in both modes (left half delete-styled, right half insert-styled).
4. Comment affordance behavior matches today's predicate: present on the right gutter for `insert` lines, `context` lines, and `paired` rows; absent for `solo-delete` rows and `hunk-header` rows.
5. AI hunk annotation rows render at hunk-header positions in both modes.
6. Existing comment widget rows and inline-composer slot rows span the full row width in both modes.
7. Viewport `<900px` continues to force unified rendering; the toolbar button reflects this via `aria-disabled="true"`.
8. All existing `DiffPane.test.tsx` cases pass.
9. New vitest cases per § 9.1 pass.
10. New Playwright assertions per § 9.2 pass.
11. Empty / loading / truncated / deleted-file / added-file states render per § 10.
12. Pre-push checklist per `.ai/docs/development-process.md` clean: `npm run lint`, `npm run build`, `npm test`, `dotnet test`, `npx playwright test --project=prod`.
13. **Usability gate.** Lead engineer uses split mode by default for at least 3 consecutive PR reviews after slice 1 ships without reverting to unified for reasons other than the viewport gate. If reverted, capture the reason in the deferrals sidecar (likely DSx3 multi-line fragmentation trigger fired) before opening slice 2's brainstorm.

## 13. References

- Brainstorm transcript: 2026-06-01 session continuation (this spec is the output).
- Backlog item: `docs/backlog/05-P4-polish.md:96` (P4-B8 — needs slice-split note added when slice 1 lands).
- S3 source declaration: `docs/specs/2026-05-06-s3-pr-detail-read-design.md:73`.
- Stub comment to remove: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx:325-328`.
- Hard-coded `colSpan={3}` literals to replace: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx:353` + `:385`.
- Handoff reference: `design/handoff/screens.css:660-674`.
- Comment-anchoring deferral that slice 1 preserves: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx:297-302`.
- Current `findAdjacentPair` algorithm slice 1 matches: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx:92-103`.
- Word-diff overlay component reused: `frontend/src/components/PrDetail/FilesTab/DiffPane/WordDiffOverlay.tsx`.
- Hover selector that depends on `${styles.diffGutterNew}` class: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css:110`.
- Playwright parity baseline: `frontend/e2e/parity-baselines.spec.ts:177-188` (`pr-detail-files-diff.png`, recapture in slice 1 plan).
