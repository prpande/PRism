# #214 — File-tree pinned/sticky horizontal scrollbar

**Issue:** [#214](https://github.com/prpande/PRism/issues/214) · **Tier:** T2 · **Risk:** gated B1 (UI-visual) · **Date:** 2026-06-06

## Problem

In the **Files** tab, the file-tree column (`.fileTreeScroll`) scrolls horizontally
when long paths/filenames extend a row, but its **native** horizontal scrollbar
sits at the bottom of the *entire tree content*. Because the tree grows to its
full content height (`.fileTree` is `overflow: visible`; the outer `.filesTabTree`
pane owns vertical scrolling — the #187 architecture), that scrollbar is below the
fold whenever the tree is taller than the viewport. Reaching it requires vertically
scrolling the whole tree to its end. The diff pane already solves the identical
problem with a **synthetic** bottom-pinned scrollbar; the tree should match it.

## Acceptance criteria (from the issue)

1. The file-tree horizontal scrollbar is visible/reachable **without** vertically
   scrolling to the end of the tree.
2. It is pinned at the bottom of the **visible** tree pane (sticky). **Parity scope:**
   the *pinning* matches the diff view (always reachable, bottom of the visible
   pane). One deliberate divergence from the diff is accepted — see
   **Known tradeoff** below — and is surfaced for the B1 visual gate.
3. Horizontal scroll position stays in sync with the tree content — **no drift**
   between the bar and the rows.
4. The static checkbox column stays row-aligned with the tree rows (the #187
   invariant holds).
5. The bar appears **only** when the tree actually overflows horizontally (parity
   with the diff bar's `display` toggle).
6. Behaviour verified in the running app (vertical-position independence + no
   horizontal drift), per the validate-in-app rule.

## Approach — Approach A (synthetic bar, keep #187's vertical model)

Replicate the diff pane's proven mechanism. The diff drives a CSS variable from a
synthetic scrollbar's `scrollLeft`; the content reads it via `transform: translateX`,
so the pane shifts as one unit, and the bar stays pinned at the bottom
(`useLockedPaneScroll` + `DiffPane` `.diffHScroll` + `DiffPane.module.css`).

Concretely for the tree:

1. **Clip instead of native-scroll.** `.fileTreeScroll` becomes `overflow-x: hidden`
   (was `overflow-x: auto`). It remains the horizontal *viewport* — its `clientWidth`
   is the measured viewport width, and it is the element the CSS var is written on,
   the wheel handler attaches to, and `ResizeObserver` observes.
2. **Transform-shift the inner.** `.fileTreeInner` (already `width: max-content`)
   gets `transform: translateX(calc(var(--file-tree-hscroll, 0px) * -1))`. One inner
   element shifts — structurally simpler than the diff, which shifts N table cells in
   lockstep. `--file-tree-hscroll` is set on `.fileTreeScroll` (its parent) and
   inherits down; both elements unmount on the empty/skeleton render paths, so the
   var re-mounts clean (no stale-offset cleanup needed beyond the hook's own
   null-guarded teardown).
3. **Synthetic sticky bar — constrained to the tree column.** A new footer row,
   the last child of `.fileTree` after `.fileTreeBody`, that **mirrors `.fileTreeBody`'s
   two-column flex layout**: a `flex: 1 1 auto; min-width: 0` bar cell aligned under
   `.fileTreeScroll`, plus a fixed spacer cell the same width as `.fileTreeCheckCol`.
   The bar cell is `overflow-x: auto; overflow-y: hidden; height: 14px` with an inner
   spacer (mirrors `.diffHScroll` / `.diffHScrollSpacer`). The footer row is
   `position: sticky; bottom: 0`. Because `.fileTree` is `overflow: visible`, the
   sticky resolves against the nearest scroll ancestor — the already viewport-bounded
   `.filesTabTree` — so it pins to the bottom of the *visible* pane and settles at the
   true bottom when the user reaches the end.

   *Why constrained to the tree column (not full pane width):* the bar's thumb
   proportion (`clientWidth / scrollWidth`) must honestly represent the
   *tree-column's* visible fraction. A full-pane bar (spanning the checkbox column
   too) would still scroll to the right max-offset — the spacer math is width-
   independent (see below) — but its thumb would misrepresent the overflow ratio.
   Aligning the bar to `.fileTreeScroll`'s width keeps the thumb honest and matches
   the diff exactly. (Adversarial review A3.)
4. **Dedicated tree hook — do NOT generalize `useLockedPaneScroll`.** The tree's
   measurement is trivial (one element: `inner.scrollWidth` vs `scroll.clientWidth`),
   whereas the diff's "hard-won machinery" lives almost entirely in its *per-cell*
   measurement (`querySelectorAll('td[data-side]')`, per-cell max-width loop,
   `apply(0)`-reset-before-measure). Parameterizing that measurement out of the diff
   hook — to serve a structurally-simpler one-consumer case — would refactor the
   diff's load-bearing code and widen the diff-regression surface on a gated B1 issue,
   for an abstraction with exactly one new consumer. Instead, add a focused
   `useTreeHScroll` (≈30 lines) that reuses the *pattern* — rAF-throttled
   `scrollLeft → CSS var`, horizontal-intent `wheel` handler, jsdom-guarded
   `ResizeObserver`, spacer-sizing + `display` toggle, clamp-on-resize — but is
   self-contained and never touches the diff path. The duplicated plumbing is
   low-risk and small; the duplication is intentional and the hook cites
   `useLockedPaneScroll` as its model. (Adversarial review A4: this *reverses* the
   first draft's "generalize" recommendation.)

The static checkbox column (`.fileTreeCheckCol`) is **untouched** — it already never
scrolls horizontally, so criterion 4 holds by construction. `translateX` is
paint-time only (does not affect layout height or `scrollWidth`), so row alignment
between the two columns is unchanged.

5. **Clear the sticky bar for keyboard / programmatic scroll.** Add
   `scroll-padding-bottom: 14px` (bar height) to `.filesTabTree`. Without it, a
   `scrollIntoView` (e.g. selected-row reveal) or keyboard navigation can land the
   target row *under* the sticky bar. This is required, not optional. (Design review
   D1.) Note: this does not eliminate the mid-scroll overlap (see Known tradeoff) —
   it only guarantees the end-of-list clearance.

### Shared spacer math (verified, width-independent)

`spacer = (maxScroll − viewport) + bar.clientWidth` ⇒
`bar.maxScrollLeft = spacer − bar.clientWidth = maxScroll − viewport = overflow`,
for **any** bar width. The longest path's end is reachable regardless of the bar's
own width. A one-line code comment at the measurement site will note that `viewport`
is measured from `.fileTreeScroll.clientWidth` (not the bar width) so a future reader
doesn't "fix" the intentional bar-vs-viewport relationship. (Feasibility F4.)

### Keyboard & a11y

The bar is `aria-hidden="true"` and **not** in the tab order — matching the existing
diff bar (`DiffPane.tsx` `.diffHScroll` is `aria-hidden`). Full filenames remain
reachable to assistive tech via the existing per-row `title` attribute and the
`role=tree` row semantics; the synthetic bar is a pointer/trackpad affordance, like
the diff's. A dedicated keyboard horizontal-pan affordance is **out of scope** (it
would diverge from the diff bar and belongs to a broader tree-keyboard pass, cf.
#200); recorded as a deferral, not silently dropped. (Design review D5 — deferred
with rationale.)

### Why not Approach B (restructure the tree pane)

B gives fuller diff parity — the bar reserves its own strip (no overlap) — by making
the tree column a bounded flex container `[header][scrolling body flex:1][bar]`, i.e.
moving the vertical scroll **off** `.filesTabTree` into an inner body. Costs:

- It **reverses #187's deliberate "outer pane owns vertical scrolling"** decision.
- `useTabScrollMemory` persists `.filesTabTree`'s `scrollTop` (`useTabScrollMemory.ts:28,37`);
  moving the scroller inward breaks Files-tab scroll restoration unless that wiring
  is also migrated.
- It breaks `diff-scroll-regression.spec.ts:181`'s assertion that `files-tab-tree`
  has `overflowY: auto`.

More blast radius than a T2 warrants, and the issue itself recommends A and defers B
"only if (A) proves insufficient." Reserve B for if the overlap reads poorly at the
visual gate.

### Known tradeoff (accepted; surfaced at the B1 visual gate)

A `position: sticky` footer floats **over** the bottom ~14px of content while stuck
(sticky does not reserve space mid-scroll the way the diff's bounded flex sibling
does). The bar is an opaque 14px strip (`background: var(--surface-1)` + a top
border), so it reads as an intentional pinned footer covering a sliver of the
bottom-most visible row mid-scroll. This is the one deliberate divergence from the
diff under criterion 2, and the price of "least disruption to #187."

Considered and rejected within Approach A: reserving the strip via `padding-bottom`
on `.fileTreeInner` does **not** fix the *mid-scroll* overlap (it only adds clearance
at the true end of the list, which `scroll-padding-bottom` already covers) — the bar
still floats over a real row while the user is scrolled up. There is no free lunch
inside A; true no-overlap requires Approach B. (Adversarial review A1/A2 — evaluated,
overlap accepted, escalation path to B documented.)

### Prior-art caveat (#187 "drift") — verified

#187 abandoned `position: sticky` because it "measurably drifts ~13px at scroll-end"
(`docs/specs/2026-06-05-file-tree-visual-polish-design.md:220-221`). That sticky was
used to **horizontally pin the checkbox column over a native horizontal-overflow
scroller** — the exact naive scheme this design avoids. Here, horizontal sync is the
`translateX`-driven synthetic bar (the proven diff mechanism); `position: sticky`
only **vertically** pins the bar *element*, and the checkbox column is never touched.
So the #187 drift mode cannot recur. (Adversarial review A6 — attribution verified
against the #187 doc.)

## Test strategy

- **e2e (the durable guard + criterion 6).** Add `tree-scroll-regression.spec.ts`
  modelled on `diff-scroll-regression.spec.ts`. The tree overflows on long **paths**,
  not file content — and the current fake (`FakePrReader.GetDiffAsync`) is hardcoded
  to a single file `src/Calc.cs`, so there is **no existing seam** to inject long
  paths (feasibility F1, verified). Add a minimal **test-only backend seam**: a list
  of extra file paths on `FakeReviewBackingStore` that `GetDiffAsync` emits as
  trivial single-line `FileChange`s, set via a new `/test/seed-tree-files` endpoint
  (or an added field on `/test/advance-head`). Production code is untouched. Then the
  spec, at a viewport where the tree is wider than the column and taller than the
  pane, asserts:
  - the bar (`data-testid="file-tree-hscroll"`) is visible **only** when the tree
    overflows, and its bottom edge is within the viewport **without** scrolling the
    tree (criteria 1, 2, 5);
  - at a non-zero bar `scrollLeft`, `.fileTreeInner` carries a real negative
    `translateX` (DOMMatrix `m41`) — rows shifted in sync (criterion 3);
  - the checkbox column's x-position is constant across scroll 0/mid/max
    (criterion 4);
  - the page itself does not scroll vertically (Files-view invariant);
  - **edge case (adversarial A5):** a horizontally-overflowing but vertically-short
    tree (one long path, ≤3 files) — the bar still shows and its vertical position is
    acceptable (no dead gap / not below fold).
- **unit (RTL/jsdom).** jsdom has no layout, so geometry lives in the e2e. The unit
  test asserts the **structure**: `FileTree` emits the bar element (aria-hidden),
  `.fileTreeScroll` is the clip (`overflow-x: hidden`), the footer mirrors the
  two-column layout, and the hook is wired. Light by design.
- **manual in-app (criterion 6).** Reproduce the below-the-fold native scrollbar on a
  real deep-path PR first (the BFF repo has deep namespaces) — red — then confirm the
  pinned bar is reachable and drift-free after the fix — green. Screenshots for the
  B1 visual gate, **explicitly calling out the mid-scroll overlap** so the user judges
  it.

## Out of scope

- Sub-1180px collapsible tree sheet (#146), tree keyboard nav incl. horizontal-pan
  affordance (#200), and the sticky-tree/confine-scroll idea (#128).
- Vertical stickiness of the tree header.
- Fixing the pre-existing Windows "always-visible scrollbar thumb (~17px) > 14px bar
  height" cosmetic — it affects the diff bar identically today and is not introduced
  here. (Design review D4 — noted, not in scope.)

## Files

- `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` (+ `.module.css`) — footer
  bar + spacer cell, refs, `overflow-x` flip, `translateX` on inner.
- `frontend/src/hooks/useTreeHScroll.ts` — **new**, dedicated (not a change to
  `useLockedPaneScroll`).
- `frontend/src/components/PrDetail/FilesTab/FilesTab.module.css` —
  `scroll-padding-bottom` on `.filesTabTree`.
- `PRism.Web/TestHooks/FakeReviewBackingStore.cs`, `FakePrReader.cs`,
  `TestEndpoints.cs` — **test-only** seam to inject long-path files for the e2e.
- `frontend/e2e/tree-scroll-regression.spec.ts` (+ `helpers/`) — new.
