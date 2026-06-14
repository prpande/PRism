# Diff change-navigation: scroll-track minimap + prev/next controls

- **Issue:** [#486](https://github.com/prpande/PRism/issues/486)
- **Date:** 2026-06-15
- **Tier / Risk:** T3 (net-new, cross-cutting UI) · **Gated B1 (UI-visual)** — carries `needs-design`; correctness of layout/color/motion needs a human eyeball.
- **Follow-up:** [#493](https://github.com/prpande/PRism/issues/493) — overlay AI hunk-annotation markers on the same rail (blocked on this).

## Problem

In the Files tab, "show whole file" mode (`wholeFileEnabled`) interleaves the changed
rows into the full file content (`interleaveWholeFile`). Great for context, but it buries
the changes: a reviewer scrolls blind through long stretches of unchanged lines with no
signal of where the next change is or how many remain. The taller the file, the worse the
"where did the diff go?" problem. Unified hunk mode avoids this only because it shows
*nothing but* changed regions; whole-file mode reintroduces the needle-in-a-haystack scroll.

This is **non-AI** navigation — it must work with AI features off — and is complementary
to the AI review-guidance track (#136 hotspots, #468 per-hunk attention): those decide
*what* deserves attention; this is plain *navigation to the changes* regardless of AI mode.

## Goals

1. A passive **scroll-track minimap** in whole-file mode: a thin gutter rail beside the
   scrollbar marking where changes sit in the full file, colored by change kind,
   click-to-jump, with a current-viewport indicator.
2. Active **prev/next-change controls** (buttons + keyboard) that walk the changes
   hunk-to-hunk, scrolling each into view and announcing position for screen readers.
3. The two share one source of truth, so the counter the buttons show always matches the
   ticks on the rail.

## Non-goals (v1)

- **Minimap in hunks-only mode** — low value (the diff there *is* the changes). Prev/next
  *do* apply in hunks-only mode; the rail does not.
- **AI annotation markers on the rail** — deferred to #493.
- **Drag-to-scrub** the viewport box — click-to-jump + proportional rail-click already
  cover navigation.
- **Per-line markers** — we mark per contiguous change run, not per line.
- **Tick merging / clustering** on extreme density — v1 lets ticks pack by real position
  (min height keeps them visible); clustering can come later if needed.

## Scope matrix

| Affordance | Whole-file mode | Hunks-only mode | Unified | Split |
|---|---|---|---|---|
| Minimap rail | ✅ | ❌ | ✅ | ✅ |
| Prev/next controls + `n`/`p` | ✅ | ✅ | ✅ | ✅ |

Both affordances are fundamentally *row-position → scrollTop* operations, so they work
across unified/split unchanged. The rail is gated to whole-file mode by product value, not
by a technical limit.

## The "change" model (shared source of truth)

A **change** is one **contiguous run of changed lines** in the rendered `allLines`
(`DiffLine[]`) array — finer than a git hunk, because a single hunk can hold several runs
separated by context lines. Both the rail ticks and the prev/next walker iterate this one
list, so "change N of M" always matches the visible ticks.

```
interface DiffChange {
  kind: 'add' | 'delete' | 'modify';
  startRowIdx: number;   // index into allLines of the run's first changed row
  endRowIdx: number;     // inclusive
  startLineNum: number;  // new-side line number of the first row (old-side if pure delete)
  addCount: number;      // # insert rows in the run
  delCount: number;      // # delete rows in the run
}
```

**Derivation** — a pure function `computeChanges(lines: DiffLine[]): DiffChange[]`:
scan `allLines`; a run starts at the first `insert`/`delete` row and extends across
consecutive `insert`/`delete` rows; it ends at any `context` / `hunk-header` / filled row.
Classify: all-insert → `add`, all-delete → `delete`, mixed → `modify`. Context, filled
context (`isFilled`), and hunk-header rows are never part of a run. The function is
DOM-independent and unit-tested in isolation.

This works identically in both modes: in hunks-only mode `allLines` is the parsed hunk
bodies (with `hunk-header` rows that break runs); in whole-file mode it is the interleaved
full file (no hunk-header rows, filled-context rows break runs). It is independent of
unified/split — those differ only in *rendering* of the same `allLines`.

## Minimap rail

A **dedicated thin gutter element we own**, rendered as the last flex child of the diff
scroll area, just left of the native scrollbar. We do **not** overlay the native scroll
track: native scrollbars render differently on Windows vs. macOS and cannot be painted
into, so an overlay would force a full custom scrollbar (much larger surface) to do well.

### Resting vs. hover

- **Resting (~5px):** ticks only — a positional glance at change density/location.
  Background `--surface-2`.
- **On hover of the rail (~48px):** width animates open (`--ease-out`, ~`--t-med`),
  background lifts to `--surface-3`, ticks grow into comfortable click targets, and each
  change's **start line number** appears beside its tick (Geist Mono, `--text-3`, tabular
  figures). Collapses back on pointer-leave. Honors `prefers-reduced-motion` (no width
  transition).

### Ticks

- One tick per `DiffChange`, absolutely positioned: `top% = rowTopOffset / scrollHeight`,
  height `∝ runPixelHeight / scrollHeight`, **min height 3px** so a 1-line change stays
  clickable.
- Color by kind (VS Code's familiar diff-gutter convention, via app tokens):
  **add → `--success`** (green), **delete → `--danger`** (red), **modify → `--info`**
  (blue). These solid state colors read clearly at any tick size against the rail surface
  (the `--diff-*-bg` row tints are too pale for a thin marker).

### Viewport indicator

A translucent box on the rail showing the current scroll position:
`top% = scrollTop / scrollHeight`, `height% = clientHeight / scrollHeight`. Border
`--border-strong`, fill `color-mix(--text-1 ~7%, transparent)`. `pointer-events: none`.

### Pointer interactions

- **Click a tick** → scroll that change into view and make it current.
- **Click empty rail** → proportional jump: `scrollTop = (clickY / railHeight) * scrollHeight`
  (the rail doubles as a scrubber).
- **Hover a tick** → it highlights, cursor `pointer`, and a **tooltip card** appears
  (`--surface-1` bg, `--border-2`, `--shadow-3`, `--radius-2`, Geist) reading
  `change N of M · L<startLine> · +<adds> −<dels>`.

### Position measurement

Rows are plain DOM (not virtualized) but heights vary (wrapped lines, AI annotation rows),
so tick offsets are **measured**, not estimated from a fixed row height. Each change's
first row is tagged `data-change-start="<changeIdx>"`; after layout, the rail reads each
tagged row's offset relative to the scroll container and the container's `scrollHeight`.
Re-measure on: `allLines` change, container resize (`ResizeObserver`), and font/density
change. Scroll updates (viewport box + current-change) are read on `scroll`, throttled
with `requestAnimationFrame`.

## Prev/next controls

Rendered in the per-file **`diff-pane-header`** (right side, where the path already lives) —
adjacent to the diff and the top of the rail. Present in **both** modes.

Cluster (right-aligned): **git-compare lead icon** + **prev chevron (▲)** + **counter** +
**next chevron (▼)**.

- **Lead icon:** a git-compare glyph (two nodes + branch) in the app's stroke-icon style
  (24×24, `currentColor`, matching `diffIcons.tsx`). Colored **`--accent`** (always).
  Carries `aria-label="changes"`.
- **Chevrons:** ghost icon buttons, **neutral (`--text-2`) at rest, `--accent` on hover**
  (background `--surface-3` on hover, per the app's ghost-button idiom). `aria-label`
  "Previous change" / "Next change".
- **Counter:** `N / M` (Geist Mono, `--text-1`, tabular), current change index (1-based)
  over total.
- **Clamp at ends:** prev disabled on the first change, next on the last (`disabled`
  attribute → `--text-disabled`, no hover). No wrap-around — the disabled state
  communicates "you're at an edge" more clearly than a silent jump to the other end.

### Current-change + navigation semantics

- **currentIdx** = the last change whose start offset is at or above `scrollTop` + a small
  top margin; clamped to `[0, M-1]` (0 when scrolled above the first change). The counter
  shows `currentIdx + 1 / M`.
- **next()** scrolls to `changes[currentIdx + 1]` (no-op/disabled at the last).
- **prev()** scrolls to `changes[currentIdx - 1]` (no-op/disabled at the first).
- **Scroll-to** places the change's first row near the top of the viewport with a small
  margin; smooth behavior, instant under `prefers-reduced-motion`.

### Keyboard

- **`n`** = next change, **`p`** = previous change — a within-file vertical parallel to the
  existing across-file `j`/`k`. Both keys are currently free in `useFilesTabShortcuts`.
- Naked keys only (no modifier), suppressed in text inputs — reuse the existing
  `isInputTarget` guard in `useFilesTabShortcuts`. Respect the same clamp (no-op at ends).

## Accessibility

- The **prev/next buttons + `n`/`p` keys are the accessible navigation path** — fully
  labeled and keyboard-operable.
- Each *actual* move (button, key, or tick click that changes position) updates an
  `sr-only` `role="status"` / `aria-live="polite"` region with `change N of M` (reuse the
  `.sr-only` pattern; mirror the live-region approach from #312/#450). No announcement on a
  clamped no-op.
- The **rail is a pointer-only enhancement** and is marked `aria-hidden` — it duplicates
  navigation already exposed accessibly via the buttons/keys, so it should not add a second
  (noisier) path to the SR tree.

## Theming

All colors are existing tokens (`--success` / `--danger` / `--info` for ticks,
`--surface-2/3` for the rail, `--accent` for the icon, `--text-*`, `--border-*`,
`--shadow-3`), so both themes derive automatically. Exact final shades are verified live
against the running app in both themes before sign-off (the B1 visual gate).

## Component breakdown (units & seams)

1. **`diffChanges.ts`** — `computeChanges(lines): DiffChange[]` + `DiffChange` type. Pure,
   no DOM. *Depends on:* `DiffLine`. *Tested:* standalone.
2. **`useChangeNavigation` hook** — inputs: scroll-container ref + `changes`. Owns offset
   measurement (via `data-change-start` query), `ResizeObserver`, rAF scroll listener.
   Returns `{ currentIdx, total, canPrev, canNext, goToPrev, goToNext, goToChange(i),
   scrollToRatio(r), ticks: {top,height,kind,startLineNum,addCount,delCount}[], viewport:
   {top,height} }`. *Tested:* with a fake container exposing offsets.
3. **`ChangeMinimap` component** — presentational; given `ticks`, `viewport`, hover state,
   and `goToChange`/`scrollToRatio`. Renders rail (rest/expand), ticks, viewport box,
   expanded line numbers, tooltip. Whole-file mode only.
4. **`ChangeNavControls` component** — the header cluster; given `currentIdx`, `total`,
   `canPrev`, `canNext`, `onPrev`, `onNext`. Renders icon + chevrons + counter + the
   sr-live region. Both modes.
5. **`DiffPane.tsx` wiring** — `computeChanges(allLines)` (memoized), mount
   `useChangeNavigation(diffBodyRef, changes)`, render `ChangeNavControls` in
   `diff-pane-header`, render `ChangeMinimap` inside the scroll area (whole-file only), tag
   each change's first row with `data-change-start` in the row renderers.
6. **Keyboard seam** — `n`/`p` register where the change-nav state lives. Recommended:
   extend `FilesTabShortcutHandlers` with `onNextChange`/`onPrevChange`, and have
   `DiffPane` expose its `goToNext`/`goToPrev` to `FilesTab` (e.g. via a ref handle) so all
   naked-key shortcuts stay centralized in `useFilesTabShortcuts`. **Final seam confirmed
   in the plan** — the alternative is a DiffPane-local key listener reusing `isInputTarget`;
   avoid double-binding `n`/`p`.

## Edge cases

- **0 changes:** rail and controls hidden (shouldn't occur for a file in the diff, but
  guard on `changes.length === 0`).
- **1 change:** counter `1 / 1`, both chevrons disabled, single tick.
- **Whole-file not yet loaded / failed:** rail hidden until interleaved `allLines` is
  ready; prev/next still operate on the current `allLines` (hunks fallback).
- **Very large diffs:** hundreds of ticks render as cheap absolutely-positioned divs;
  min-height keeps them visible.
- **Split mode:** `computeChanges` runs on logical `allLines`, independent of the
  delete+insert visual pairing; `data-change-start` lands on the first row of the run.
- **Resize / theme / density change:** `ResizeObserver` re-measures offsets; theme is pure
  CSS.

## Testing strategy

- **Unit (`diffChanges`):** pure adds, pure deletes, mixed→modify, multiple runs within one
  hunk, context-separated runs, filled-context boundaries, empty input.
- **Hook (`useChangeNavigation`):** currentIdx math at/above/below changes, prev/next
  clamping, tick positions and viewport ratio from injected offsets.
- **Component:** `ChangeNavControls` counter text, disabled-at-ends, aria-labels, handler
  calls, sr announcement on move (and *not* on clamped no-op); `ChangeMinimap` tick
  color-by-kind, positioning, tick-click → `goToChange`, rail-click → proportional scroll,
  rest/expand on hover.
- **Integration (`DiffPane`):** rail renders only in whole-file mode; controls render in
  both; `data-change-start` tagging on first rows.
- **Keyboard:** `n`/`p` invoke next/prev, suppressed in inputs, respect clamp.
- **Visual (B1, human-gated):** Playwright baselines for rail (rest + expanded) and the
  header controls, both themes.

## Acceptance criteria

- [ ] In whole-file mode, changed runs are marked along the diff scroll track, colored by
      kind (add/delete/modify), positioned by location in the full file.
- [ ] Clicking a tick jumps to that change; clicking empty rail scrolls proportionally;
      hovering expands the rail with line numbers + a tooltip.
- [ ] Prev/next controls (chevrons + `n`/`p`) move the viewport change-to-change, clamped
      at the ends, with an `sr-only` "change N of M" announcement on each move.
- [ ] The counter always matches the number/order of ticks on the rail.
- [ ] Prev/next work in hunks-only mode too; the rail appears only in whole-file mode.
- [ ] Everything works with AI features off.
- [ ] Markers/counter stay correct as the selected file and the whole-file toggle change.
- [ ] Both themes verified live (B1 visual gate).

## Open decisions for the plan

- The exact **keyboard seam** (ref handle up to `useFilesTabShortcuts` vs. DiffPane-local
  listener) — pick one, no double-binding.
- The small **top-margin epsilon** for current-change detection and scroll-to landing.
- Whether the expanded-rail line number is a **single start line** (chosen) or a range
  (deferred unless review pushes back).
