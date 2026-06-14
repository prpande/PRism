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

**Why both ship together (not prev/next first).** The two are complementary by design — the
issue asks for both ("the minimap shows the landscape, the prev/next buttons walk it").
Prev/next is the cheaper, fully-accessible *core* navigation; the rail is the *positional-
glance* layer that prev/next alone can't give (density, distribution, where-am-I). Splitting
them would ship the headline ask (#486 is titled "minimap + prev/next") half-done. They
share one change model (`computeChanges`), so the rail is incremental on top of the walker,
not a separate build.

## Non-goals (v1)

- **Minimap in hunks-only mode** — low value (the diff there *is* the changes). Prev/next
  *do* apply in hunks-only mode; the rail does not.
- **AI annotation markers on the rail** — deferred to #493.
- **Drag-to-scrub** the viewport box — click-to-jump + proportional rail-click already
  cover navigation.
- **Per-line markers** — we mark per contiguous change run, not per line.
- **Tick merging / clustering** on extreme density — v1 lets ticks pack by real position
  (min height keeps them visible). See the density note under Edge cases; clustering is the
  designated first fast-follow if the B1 gate finds the rail unusable on big diffs.

## Scope matrix

| Affordance | Whole-file mode | Hunks-only mode | Unified | Split |
|---|---|---|---|---|
| Minimap rail | ✅ | ❌ | ✅ | ✅ |
| Prev/next controls + `n`/`p` | ✅ | ✅ | ✅ | ✅ |

Both affordances are fundamentally *row-position → scrollTop* operations, so they work
across unified/split unchanged. The rail is gated to whole-file mode by product value, not
by a technical limit. **Note on split mode:** PRism's split (side-by-side) view is a single
4-column `<table>` inside the *one* vertical scroll container (`.diff-pane-body`) — it is
not two independent vertical panes. So there is exactly one rail, identical to unified; only
the table's column layout differs. Likewise, the Files tab mounts a **single `DiffPane`** for
the file-tree-selected file (not a GitHub-style all-files-expanded list), so there is exactly
one change-nav instance and one `n`/`p` listener — no multi-pane key-routing problem.

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

**Line-type → change-kind mapping** (the change model uses different vocabulary from
`DiffLine.type`, so implementers must translate, not compare directly):

| Run composition (`DiffLine.type`) | `DiffChange.kind` |
|---|---|
| all `insert` rows | `add` |
| all `delete` rows | `delete` |
| mixed `insert` + `delete` rows | `modify` |

**Derivation** — a pure function `computeChanges(lines: DiffLine[]): DiffChange[]`:
scan `allLines`; a run starts at the first `insert`/`delete` row and extends across
consecutive `insert`/`delete` rows; it ends at any `context` / `hunk-header` / filled row.
Context, filled context (`isFilled`), and hunk-header rows are never part of a run. The
function is DOM-independent and unit-tested in isolation.

**Block-replacements are one `modify` tick — by design.** Git unified hunks emit all
`delete` lines then all `insert` lines for a replaced block, with no context between, and
`parseHunkLines` preserves that order. So a "replace this block" edit is a single
contiguous mixed run → one **blue `modify`** tick. This matches VS Code's gutter, where a
changed block is "modified," not split into separate add/delete marks. Consequence:
`modify` (blue) is the most common kind on real diffs, and pure `add`/`delete` ticks appear
only for clean insertions/deletions. The B1 visual gate must validate the color mix on a
**modify-heavy** diff, not just a synthetic add+delete one.

This works identically in both modes: in hunks-only mode `allLines` is the parsed hunk
bodies (with `hunk-header` rows that break runs); in whole-file mode it is the interleaved
full file (no hunk-header rows, filled-context rows break runs). It is independent of
unified/split — those differ only in *rendering* of the same `allLines`. The change list is
**mode-stable**: the run set is the same set of `insert`/`delete` lines whether or not
context surrounds them, so `M` and the change ordering do not jump when the whole-file
toggle flips (one edge case: two *immediately adjacent* git hunks merge into one run in
whole-file mode while a `hunk-header` splits them in hunks-only mode — rare, off-by-one,
acceptable).

## Minimap rail

A **dedicated thin gutter element we own**, rendered as an **absolutely-positioned overlay
inside a new `position: relative` wrapper that wraps *only* `.diff-pane-body`**. This wrapper
is net-new DOM: `.diffPane` today is `position: static` and contains the header, the body,
the conditional `.diffHScroll`, and the truncation banner, so it cannot serve as the rail's
containing block. The wrapper holds exactly two children — the scroll body and the rail —
so the rail's `top%`/`height%` resolve against the body's box and the rail naturally matches
the body's bounds (the header, hScroll, and banner stay outside it). The rail is **not** a
flow child *inside* the overflow:auto scroll body (that would scroll away with the content).

We do **not** overlay the native scroll track: native scrollbars render differently on
Windows vs. macOS and cannot be painted into, so an overlay would force a full custom
scrollbar (much larger surface). To keep the rail clear of the scrollbar across OSes, set
`scrollbar-gutter: stable` on `.diff-pane-body` (reserves a stable scrollbar track on both
classic-Windows and overlay-macOS scrollbars) and position the rail `right: 0` of the
wrapper. The rail's vertical extent equals the **live `.diff-pane-body` `offsetHeight`**
(re-read on the same observer below), not the wrapper height — so the scrubber's `railHeight`
stays correct if the body box changes (e.g. the split-mode `.diffHScroll` appearing).

### Resting vs. hover

- **Resting (~5px wide):** ticks only — a positional glance at change density/location.
  Background `--surface-2`.
- **On hover of the rail (~48px wide):** the **width** animates open (`--ease-out`,
  ~`--t-med`) — the rail's **height is constant** (it always spans the scroll viewport;
  only width changes, so click-ratio math is unaffected by the hover state). Background
  lifts to `--surface-3`, ticks grow into comfortable click targets, and each change's
  **start line number** appears beside its tick (Geist Mono, `--text-3`, tabular figures).
  Collapses back on pointer-leave. Honors `prefers-reduced-motion` (no width transition).
- **Touch / coarse pointer:** under `@media (pointer: coarse)` the rail renders
  **permanently expanded** (48px, line numbers shown, no width transition) so tick targets
  are usable without a hover event — a 5px rail is unreachable by touch.

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
`--border-strong` (the border carries the visible affordance and must clear WCAG 1.4.11
non-text 3:1 against `--surface-2/3` in both themes — verify at the B1 gate), fill
`color-mix(--text-1 ~7%, transparent)`. `pointer-events: none`.

### Pointer interactions

- **Click a tick** → scroll that change into view and make it current (updates the live
  region — see Accessibility).
- **Click empty rail** → proportional jump: `scrollTop = (clickY / railHeight) * scrollHeight`,
  where `railHeight` is the measured live body `offsetHeight` (the rail doubles as a scrubber).
- **Hover a tick** → it highlights, cursor `pointer`, and a **tooltip** appears (a local
  absolutely-positioned element inside `ChangeMinimap` — **not** a new shared Tooltip
  primitive) styled `--surface-1` bg, `--border-2`, `--shadow-3`, `--radius-2`, Geist,
  reading `change N of M · L<startLine> · +<adds> −<dels>`. ~100ms show delay (avoids flash
  on a fast pass), closes immediately on pointer-leave; the show-delay timer is cleared on
  pointer-leave **and** on rail collapse/unmount (so it can't fire onto a now-hidden tick);
  no show delay under `prefers-reduced-motion`. The tooltip surfaces the focused tick's
  *full detail* (counts + position) that the expanded rail's per-tick line numbers alone
  don't; it is a pointer-only supplement (see Accessibility).

### Position measurement

Rows are plain DOM (not virtualized) but heights vary, so tick offsets are **measured**,
not estimated from a fixed row height. Each change's first row's `<tr>` (the row element,
not a cell — unambiguous in split mode) is tagged `data-change-start="<changeIdx>"`. The
hook reads each tagged row's offset relative to the scroll container and the container's
`scrollHeight`.

**Re-measure triggers.** Several height changes fire *after* initial layout without changing
`allLines` or the container's own size, so a single `ResizeObserver` on the scroll container
is insufficient:

- **Syntax highlighting** (shiki) tokenizes asynchronously, changing wrapped-line heights.
- **AI annotation rows** mount as interleaved `<tr>`s keyed on `annotationsByRowIdx`, not
  `allLines`.
- **Inline comment / composer rows** mount on user action between diff rows.

To catch all of these, **observe the inner content `<table>` with a `ResizeObserver`** (its
`offsetHeight` changes on any of the above and on `allLines` change — this requires adding a
ref to the `<table>`, see wiring), **and** observe the scroll container itself (its
`clientHeight` changes when the locked-horizontal-scroll bar appears in split mode). The
observer fires once synchronously on observation, which covers **initial mount** (measure
after paint — `useLayoutEffect` / the observer's initial call — never synchronously before
layout settles). Scroll updates (viewport box + current-change) are read on `scroll`,
throttled with `requestAnimationFrame`.

**jsdom note (testing seam):** `ResizeObserver` does not exist in jsdom (as the existing diff
hooks already handle). Guard with `typeof ResizeObserver !== 'undefined'`; unit tests inject
offsets directly and drive a deps-array manual re-measure path, while the real observer path
is verified at the B1 / Playwright pass — the testing strategy reflects this split.

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
  - **Focus:** a visible `:focus-visible` ring (the app's focus-ring token / `--accent-ring`)
    at ≥3:1 contrast against `--surface-1/2` in both themes — the ghost-button idiom
    suppresses the native outline, so the focused state must be defined explicitly or
    keyboard focus is invisible.
- **Counter:** `N / M` (Geist Mono, `--text-1`, tabular), current change index (1-based)
  over total. When no change is current (scrolled above the first), shows `— / M`. To avoid
  layout jitter as the index portion changes between `—` and digits, reserve the counter
  width (`min-width` sized to the widest form, `M / M`) and right-align the index portion.
- **Clamp at ends:** prev disabled at the first change (and above it), next at the last
  (`disabled` attribute → `--text-disabled`, no hover). No wrap-around — the disabled state
  communicates "you're at an edge" more clearly than a silent jump to the other end.

### Current-change + navigation semantics

- **currentIdx** ∈ `[-1, M-1]` = the index of the last change whose start offset is at or
  **below** `scrollTop + 8px` (i.e. the most recently passed change). It is **-1** when
  scrolled above the first change (no change passed yet).
- **Counter** shows `currentIdx + 1 / M` when `currentIdx ≥ 0`, and `— / M` when `-1`.
- **next()** scrolls to `changes[currentIdx + 1]`. From `-1` this targets change 1 (so the
  first change is never skipped). Disabled when `currentIdx === M-1`.
- **prev()** scrolls to `changes[currentIdx - 1]`. Disabled when `currentIdx ≤ 0`.
- **Scroll-to** uses `scrollContainer.scrollTo({ top, behavior: 'smooth' })` (instant under
  `prefers-reduced-motion`), placing the change's first row 8px below the viewport top. To
  stop the counter/announcement flickering through intermediate changes during the smooth
  animation, set `currentIdx` to the target immediately and **suppress the scroll-driven
  recompute** until the move settles. **Settle/interrupt detection** (a fixed timer or
  `scrollTop === target` check are both unsafe — the latter strands the flag forever if the
  user interrupts): clear suppression on the native **`scrollend`** event, **or** on the
  first user-initiated scroll/wheel/keydown/pointerdown (interrupt), **or** after a 400ms
  safety cap — whichever fires first. Also clear the flag on `selectedPath`/`wholeFileEnabled`
  change so the existing file-switch `scrollTop = 0` reset can't strand it.

### Keyboard

- **`n`** = next change, **`p`** = previous change — a within-file vertical parallel to the
  existing across-file `j`/`k` (verified: `useFilesTabShortcuts` binds only `j`/`k`/`v`/`d`,
  so `n`/`p` are free).
- Naked keys only (no modifier), suppressed in text inputs via the **shared input-guard
  helper** (see seam below). Respect the same clamp (no-op at ends). Single naked-letter keys
  are only safe behind that input guard plus the single-DiffPane scope.

## Accessibility

- The **prev/next buttons + `n`/`p` keys are the full accessible navigation path** — fully
  labeled, keyboard-operable, and they reach **every** change (`next` from `-1` walks to the
  last). That parity is what licenses hiding the rail.
- The **rail (ticks + viewport box) is `aria-hidden`** — a pointer-only enhancement that
  would otherwise add a noisier second path to the SR tree. Its pointer-only extras
  (proportional rail-click scrub, direct tick-jump, the hover tooltip) have **no keyboard/SR
  equivalent by design** — they are conveniences on top of the complete button/key nav, and
  the per-tick tooltip detail (line + counts) is supplementary, not essential (the counter +
  announcement carry the essential N-of-M).
- **Live region:** the `sr-only` `role="status"` / `aria-live="polite"` region in
  `ChangeNavControls` reads from `currentIdx` (the shared hook state). *Any* change to
  `currentIdx` — button, key, **or `goToChange` from a tick/rail click** — re-renders it with
  the new `change N of M` text; no separate per-source announcement trigger is needed
  (`aria-hidden` on the rail suppresses it from the SR *tree* but not these JS-driven
  live-region updates). No announcement on a clamped no-op. Reuse the `.sr-only` pattern;
  mirror the live-region approach from #312/#450.

## Theming

All colors are existing tokens (`--success` / `--danger` / `--info` for ticks,
`--surface-2/3` for the rail, `--accent` for the icon, `--text-*`, `--border-*`,
`--shadow-3`, `--accent-ring` for focus), so both themes derive automatically. Exact final
shades are verified live against the running app in both themes before sign-off (the B1
visual gate).

## Component breakdown (units & seams)

New components live in a **`DiffChangeNav/` subdirectory** (not dropped into `DiffPane.tsx`,
already the largest component in the codebase).

1. **`diffChanges.ts`** — `computeChanges(lines): DiffChange[]` + `DiffChange` type. Pure,
   no DOM. *Depends on:* `DiffLine`. *Tested:* standalone.
2. **`useChangeNavigation` hook** — inputs: scroll-container ref + content-`<table>` ref +
   `changes`. Owns offset measurement (via `data-change-start` query), the two
   `ResizeObserver`s (content `<table>` + scroll container, both jsdom-guarded), and the rAF
   scroll listener + the scroll-suppression flag with `scrollend`/interrupt/400ms-cap
   clearing. Returns `{ currentIdx, total, canPrev, canNext, goToPrev, goToNext,
   goToChange(i), scrollToRatio(r), ticks: {topPct,heightPct,kind,startLineNum,addCount,delCount}[],
   viewport: {topPct,heightPct}, hasOverflow }`. *Tested:* with a fake container exposing offsets +
   a deps-array re-measure path for jsdom.
3. **`ChangeMinimap` component** — presentational; given `ticks`, `viewport`, hover state,
   and `goToChange`/`scrollToRatio`. Renders rail (rest/expand), ticks, viewport box,
   expanded line numbers, tooltip. Whole-file mode only, and only when `hasOverflow`.
4. **`ChangeNavControls` component** — the header cluster; given `currentIdx`, `total`,
   `canPrev`, `canNext`, `onPrev`, `onNext`. Renders icon + chevrons + counter + the
   sr-live region (reads `currentIdx`). Both modes.
5. **`DiffPane.tsx` wiring** — add a `position: relative` **wrapper div around only
   `.diff-pane-body`** with the rail as its sibling overlay; add a ref to the content
   `<table>`; `computeChanges(allLines)` (memoized); mount `useChangeNavigation(diffBodyRef,
   tableRef, changes)`; render `ChangeNavControls` in `diff-pane-header`, render
   `ChangeMinimap` in the wrapper (whole-file + overflow only); tag each change's first `<tr>`
   with `data-change-start` in the row renderers.
6. **Keyboard seam — committed: a DiffPane-scoped key listener** (a `useEffect` document
   listener mounted with DiffPane) that calls the hook's `goToNext`/`goToPrev`. This keeps
   the change-nav state and its keys co-located where the data lives. The rejected
   alternative — extending `FilesTabShortcutHandlers` and exposing `goToNext`/`goToPrev`
   upward via a ref handle — would require converting DiffPane to `forwardRef` +
   `useImperativeHandle`, patterns absent from the codebase, for no real benefit. Do not bind
   `n`/`p` in `useFilesTabShortcuts` (avoids double-binding).
   - **Input-guard sharing:** `isInputTarget` is currently a module-private helper in
     `useFilesTabShortcuts.ts` (not exported). **Extract it to a shared keyboard-guard util**
     that both `useFilesTabShortcuts` and the new DiffPane listener import, so the guard
     (including the `.diff-view-toggle` radio carve-out) stays single-sourced and can't drift.
7. **Discoverability wiring** — register `n` (next change) and `p` (previous change) in the
   Cheatsheet `SHORTCUTS` source (`Cheatsheet/shortcuts.ts`, "Diff" group) and update the
   `ReviewFilesCta` footer hint, so the keys surface alongside `j`/`k`/`v`/`d` instead of
   being source-only.

## Edge cases

- **0 changes:** rail and controls hidden (shouldn't occur for a file in the diff, but
  guard on `changes.length === 0`).
- **1 change:** counter `1 / 1` once reached (`— / 1` above it), both chevrons disabled,
  single tick.
- **No scroll overflow** (`clientHeight >= scrollHeight` — the whole file fits in the
  viewport): hide the rail. Ticks convey no positional information when everything is
  visible at once, and the viewport box would fill 100%. The header controls remain (the
  counter is still informative; `scrollTo` is a harmless no-op).
- **Whole-file loading vs. error:** in **both** states the rail stays hidden and prev/next
  operate on the current `allLines` (the hunks fallback — `allLines` always falls back to
  parsed hunks). Because the change list is mode-stable (see the change model), the counter
  does **not** discontinuously jump when whole-file content arrives mid-session; `currentIdx`
  re-derives from the current scroll position against the new offsets on the next rAF tick.
- **Very large / dense diffs:** hundreds of ticks render as cheap absolutely-positioned
  divs; min-height keeps them visible but at extreme density (roughly >1 change per ~6px of
  rail) ticks abut and the positional glance degrades. v1 ships without clustering; the B1
  gate must exercise a large, dense real diff, and clustering is the designated first
  fast-follow if it reads as unusable.
- **Split mode:** one rail on the single scroll container (see Scope matrix);
  `computeChanges` runs on logical `allLines` independent of visual pairing. `renderSplitRows`
  pairs a `delete` with the next row only when that next row is a single `insert`; a
  multi-line block-replacement therefore renders as consecutive **solo-delete then
  solo-insert** rows (not paired). `data-change-start` lands on the run's first `<tr>` in
  **both** layouts, so the tag is correct regardless — the integration test covers the
  multi-line-block split case explicitly.
- **Resize / theme / density change:** the `ResizeObserver`s re-measure; theme is pure CSS.

## Testing strategy

- **Unit (`diffChanges`):** pure adds, pure deletes, block-replacement → single `modify`,
  multiple runs within one hunk, context-separated runs, filled-context boundaries, empty
  input; verify the line-type → kind mapping.
- **Hook (`useChangeNavigation`):** currentIdx math at/above/below changes (including the
  `-1` above-first state and that `next()` from `-1` lands on change 1), prev/next clamping,
  tick positions and viewport ratio from injected offsets, `hasOverflow=false` path, and the
  deps-array re-measure path (jsdom has no `ResizeObserver`).
- **Component:** `ChangeNavControls` counter text (`— / M` and `N / M`), disabled-at-ends,
  aria-labels, focus-visible ring presence, handler calls, sr announcement on move (and
  *not* on clamped no-op); `ChangeMinimap` tick color-by-kind, positioning, tick-click →
  `goToChange` (+ announcement), rail-click → proportional scroll, rest/expand on hover,
  permanently-expanded under `pointer: coarse`, hidden when `!hasOverflow`.
- **Integration (`DiffPane`):** rail renders only in whole-file mode + overflow; controls
  render in both; `data-change-start` tagging on first rows including a **split multi-line
  block-replacement**; rail hidden during whole-file load/error.
- **Keyboard:** `n`/`p` invoke next/prev, suppressed in inputs, respect clamp.
- **Visual (B1, human-gated):** Playwright baselines for rail (rest + expanded) and the
  header controls, both themes; a **modify-heavy** diff (color mix), a **dense** diff (tick
  legibility), and **rail-to-scrollbar alignment on both macOS (overlay) and Windows
  (classic) scrollbars** are required checks.

## Acceptance criteria

- [ ] In whole-file mode, changed runs are marked along the diff scroll track, colored by
      kind (add/delete/modify), positioned by location in the full file; the rail stays
      pinned beside the scrollbar (does not scroll with content).
- [ ] Clicking a tick jumps to that change; clicking empty rail scrolls proportionally;
      hovering expands the rail with line numbers + a tooltip.
- [ ] Prev/next controls (chevrons + `n`/`p`) move the viewport change-to-change, clamped
      at the ends, with an `sr-only` "change N of M" announcement on each move; the focused
      chevron shows a visible focus ring.
- [ ] The counter always matches the number/order of ticks on the rail (`— / M` above the
      first change).
- [ ] Prev/next work in hunks-only mode too; the rail appears only in whole-file mode.
- [ ] `n`/`p` are discoverable in the shortcuts cheatsheet and the Review-files CTA hint.
- [ ] Everything works with AI features off.
- [ ] Markers/counter stay correct as the selected file and the whole-file toggle change.
- [ ] Both themes verified live, including a modify-heavy and a dense diff, and
      rail-to-scrollbar alignment on macOS and Windows (B1 visual gate).

## Open decisions for the plan

- Whether the expanded-rail line number is a **single start line** (chosen) or a range
  (deferred unless review pushes back).
