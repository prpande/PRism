# Files-tab AI focus dot → fixed column (#492)

**Tier:** T2 · **Risk:** gated B1 (UI-visual; `design` label) · **Base:** V2

## Problem

In the Files-tab file tree, the AI focus/priority dot renders as the **last child
of the file-name row**, after the (non-truncated, `white-space: nowrap`) filename.
That row lives inside `.fileTreeScroll`, a horizontally-scrolling column whose inner
(`.fileTreeInner`) is `width: max-content` and is shifted via `translateX` by the
synthetic bottom scrollbar (`useTreeHScroll`). A long filename widens the row past
the viewport, pushing the trailing AI dot **off-screen to the right** — it is only
reachable by scrolling the tree right, so for long paths the AI signal is
effectively invisible.

The viewed checkbox already solves this: it lives in `.fileTreeCheckCol`, a fixed
column rendered **outside** `.fileTreeScroll` from the same flat `rows` list, so it
never scrolls horizontally. The AI dot should use the same pattern.

## Decision (owner-chosen)

**Right fixed column.** Give the AI dot its own fixed column (`.file-tree-ai-col`)
just **left of** the viewed-checkbox column, outside `.fileTreeScroll`, mirroring
`.fileTreeCheckCol`. The dot then stays visible at any horizontal scroll position,
and the two per-row affordances (AI signal + viewed) group into one right metadata
gutter. (Rejected: left-of-status-badge placement — visible at rest but scrolls
away with the row, and clutters the leading edge.)

## Mechanics

1. **New column, mirroring the checkbox column.** Render `.file-tree-ai-col` from
   the same `rows` sequence used by the tree and checkbox columns (row *i* lines up
   across all three). Column order in `.fileTreeBody`: `[tree scroll] [ai col]
   [check col]`. The two fixed columns **abut** (no inter-column gap) so they read as
   one metadata gutter; each centers its content via its own internal padding.
   - **File rows** → an AI slot (`.fileTreeAiSlot`, a wrapper class) containing the
     existing `.file-tree-ai` span (with its inner High/Medium dot).
   - **Directory rows** → an **empty `.fileTreeAiSlot` wrapper**, `aria-hidden`, with
     **no `.file-tree-ai` span inside**. The `.file-tree-ai` class must appear
     **exactly once per file row** (never on a dir slot), so the existing
     `count === files.length` test (`FileTree.test.tsx:423`) and the per-slot
     `aria-hidden` test (~line 497) stay green unmodified. This mirrors how only file
     rows get `CheckSlot` content while dir rows get a bare `.fileTreeCheckSlot` div.
   - **Slot geometry** mirrors `.fileTreeCheckSlot`: `display:flex; align-items:center;
     justify-content:center; height: var(--tree-row-h)`. The empty dir slot inherits
     its height from this shared row height (not an independent explicit height), so
     the AI column stays row-aligned with the tree and checkbox columns automatically.

2. **Move only the visual dot; re-wire its data lookup.** The `.file-tree-ai` span
   (its inner `fileTreeAiHigh`/`fileTreeAiMed` dot, `title`, `aria-hidden`, and
   per-span `data-on` gate) moves out of `FileCell` into the new AI slot. The new
   column's `rows.map` independently resolves the focus level via the existing
   `focusByPath.get(node.path)` (already in `FileTree` body scope) and reads
   `aiPreview` — same inputs `FileCell` used, just from the parent map. The dot's
   render condition (`focusLevel && focusLevel !== 'low'`), the `data-on`
   Preview/Live gate, the High/Medium styling, and the deep-link-on-click behavior
   are **unchanged** (scope guard).

3. **The dot is presentational — no focus/tab-order change.** The `.file-tree-ai`
   span is `aria-hidden` and carries no click/keyboard handler today; selection and
   any deep-link live on the **row** element, which stays in the tree column. Moving
   the dot to the new column therefore adds **no focusable target** and changes **no
   tab order** — the AI column cell is non-interactive, like the row's status badge.

4. **`sr-only` announcement stays in the row.** The trailing `sr-only` "AI focus:
   \<level\>" span remains in `FileCell`, immediately after the filename. The full
   row reading order is **status word → filename → AI-focus announcement** (the
   "status word" is the existing `sr-only` status prefix that sits between the hidden
   status badge and the name — unchanged). Only the *visual* dot relocates; the
   audible order is preserved. (`FileTree.test.tsx` has an explicit regression guard
   asserting the status `sr-only` word is a prefix and referencing the trailing AI
   `sr-only` span — both still hold.)

5. **Collapse-when-off, in lockstep with the scrollbar.** A single `data-ai-on`
   attribute on the `.fileTree` root (= `aiPreview ? '1' : '0'`, set **synchronously
   from the prop at render** so there is no post-mount empty-gutter flash) drives
   **both**:
   - the **AI column width** — `0` (with `overflow: hidden`) when off, so non-AI
     users (the default) see **no empty gutter**; a fixed `--ai-col-w` when on; and
   - the **synthetic-hscroll spacer** (`.fileTreeHScrollSpacerCol`), whose fixed
     width reserves the **whole right gutter**: `check-col` width when off,
     `check-col + --ai-col-w` when on.

   Because the footer mirrors the body's flex layout — `[bar flex:1]
   [spacerCol fixed = right gutter]` under `[scroll flex:1][ai col][check col]` — the
   `flex:1` bar resolves to exactly `.fileTreeScroll`'s width, so the synthetic
   scrollbar keeps spanning **only the tree column**. Driving the column width and
   the spacer off one signal keeps them aligned without JS.

   The **two gates are independent and compose**: root `data-ai-on` sets the
   *column-level* width + spacer reservation (the gutter); the retained, untouched
   per-span `data-on` keeps each outer `.file-tree-ai` slot collapsed/expanded
   *within* an open column (scope guard). The outer `.file-tree-ai` slot span is
   **always rendered, one per file row**, regardless of gate state — that is what the
   `count === files.length` test asserts.

6. **`--ai-col-w` value.** The dot's outer `.file-tree-ai` span is `16px`; the column
   adds a small symmetric inset so it sits comfortably beside the checkbox without
   crowding — start at `calc(16px + 2 * var(--s-2))` and confirm the exact gutter in
   the B1 live pass. The `.file-tree-ai-col` cell has **no background** (transparent,
   inheriting the same surface as the rows), so the unchanged `--accent` dot colors
   keep their current contrast in both themes — no color work.

## Acceptance criteria

- [ ] AI focus dot for High/Medium files is visible **without horizontal scrolling**,
      regardless of filename length, because the dot is outside `.fileTreeScroll`.
- [ ] Dot still reflects focus level (High vs Medium) and only shows in Preview/Live
      (`data-on` gate preserved).
- [ ] `sr-only` "AI focus: \<level\>" announcement preserved, read after the filename.
- [ ] Viewed checkbox column behavior unchanged.
- [ ] When AI is off, the AI column collapses to `0` width (no empty gutter) and the
      synthetic horizontal scrollbar still aligns under the tree column only.
- [ ] In both light and dark themes, at a narrow pane width with at least one long
      path (≥ ~60 chars), the High/Medium dot is fully visible in the fixed column at
      every horizontal scroll position. (B1 live visual assert.)

## Test plan (TDD, red-on-V2 first)

- **Regression (reds on V2):** with `aiPreview` on and a High focus entry, the
  `fileTreeAiHigh` dot is contained by `.file-tree-ai-col` and **not** by
  `.file-tree-scroll`. (On V2 the dot is inside the scroller → red; green after the
  move.)
- **Placement:** `.file-tree-ai-col` precedes `.file-tree-check-col` in document order.
- **Alignment / count guard:** the outer `.file-tree-ai` slot span appears exactly
  once per **file** row (an empty `.fileTreeAiSlot`, with no `.file-tree-ai` inside,
  per **dir** row), mirroring the checkbox-column alignment test — so
  `querySelectorAll('.file-tree-ai').length === files.length` holds whether AI is on
  or off (slots are always rendered; the per-span `data-on` only collapses them
  visually).
- Preserve the existing AI-dot tests unmodified (`.file-tree-ai` count = files,
  High/Medium dot, no dot for low, `aria-hidden` on the slot) and the `sr-only`
  reading-order guard.

## Out of scope

Ranker, focus-level thresholds, `data-on` Preview/Live gating logic, deep-link-on-click.
Layout/placement only. Visual-baseline regen for the moved dot (e2e parity baselines +
`ai-gating-sweep` still assert the dots are *visible*, which holds) is expected B1 work,
not a code-logic change.
