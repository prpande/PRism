# File tree: full WAI-ARIA keyboard model on the flat row list (#200)

**Tier:** T2 (short spec, 1× doc-review, TDD). **Risk:** hands-off at intake — no rendered-output
change (focus indication reuses the browser/global focus-visible treatment file rows already
have; no new element, layout, color, or copy). The keyboard-interaction question goes to the
2-lens adversarial gate check on the committed diff before any self-merge.

## Problem

`FileTree.tsx` renders a flat `role="tree"` whose file rows carry a selection-keyed
`tabIndex={isSelected ? 0 : -1}` and whose directory rows have **no** `tabIndex` at all —
keyboard users cannot reach directory rows as treeitems (the inner chevron `<button>` sits in
the natural tab order instead), and no arrow-key model exists for anyone (#200, deferred from
#199). The ARIA scaffolding (`aria-level`/`setsize`/`posinset`/`expanded`) is already complete;
only the keyboard layer the pattern promises is missing.

## Behavior contract (acceptance criteria)

Per the [WAI-ARIA APG Tree View pattern](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/):

1. **One tab stop within `role="tree"`.** The tree's treeitem rows expose exactly one
   focusable row at a time (roving tabindex across ALL rows — directories included). The inner
   directory chevron button leaves the tab order (`tabIndex={-1}`) but stays mouse-clickable.
   The sibling checkbox column (`role="group"`, one native checkbox per file) keeps its
   pre-existing N natural tab stops — outside the tree role and untouched here (an APG
   embedded-widget consolidation is a possible future issue, deliberately not this one).
2. **ArrowDown / ArrowUp** move focus to the next / previous visible row in `rows` order,
   crossing file/directory boundaries; no wrap.
3. **ArrowRight** on a collapsed directory expands it; on an expanded directory moves focus to
   its first child (the next row); on a file, no-op.
4. **ArrowLeft** on an expanded directory collapses it; otherwise (collapsed directory or any
   file) moves focus to the nearest ancestor row (`depth < current.depth` scanning upward);
   no-op at depth 0 when collapsed/file.
5. **Home / End** move focus to the first / last visible row.
6. **Enter / Space** activate: file → `onSelectFile(path)`; directory → toggle. Handled keys
   `preventDefault()` (no page scroll on arrows/Space).
7. **Focus fallback.** The roving stop is the last-focused row when it still exists, else the
   selected file's row, else the first row. A row removed by collapse/refetch degrades to the
   fallback without throwing or losing the tree's tab stop. Deliberate limitation: if a
   background refetch removes the row that holds REAL DOM focus, `document.activeElement`
   falls to `<body>` and the user re-enters via Tab (the tree still exposes exactly one
   tab stop). No effect re-focuses the fallback — an automatic re-focus cannot distinguish
   this case from "focusedKey points at the tree while the user works elsewhere", where it
   would steal focus (AC 12). Strand-over-steal, per the focusout-ambiguity rule. Mouse
   collapse cannot strand: the activation gesture itself focuses the surviving dir row
   (AC 11).
8. **Focus indication = today's treatment, kept deliberately.** The focus-visible ring renders
   on the name-column row cell exactly as it does for the currently-focusable file rows —
   partial with respect to the four sibling columns. A full-row keyboard-focus wash (threading
   focus state through CommentSlot/AiSlot/CheckSlot like hover/selection) would be a NEW
   visual design and is explicitly out of scope; if wanted, it is its own design issue.
   Selection visuals, hover, columns, and copy are untouched. `aria-selected` stays
   file-row-only.
9. **The axe gate actually exercises the tree.** `a11y-audit.spec.ts` gains a case that mocks
   a diff with at least one nested directory and runs the unscoped axe check against the
   populated tree (today's suite renders the Files page with `files: []` or scopes to the diff
   pane, so it never sees a treeitem — AC would be vacuous without this).
10. **Directory rows announce their name, once.** The focused dir treeitem carries
    `aria-label={node.name}` (its accessible name today would otherwise concatenate the inner
    button's "Toggle <name>" with the visible name span). The chevron button becomes a
    pointer-only decoration: `tabIndex={-1}` + `aria-hidden="true"` (legal — it is no longer
    focusable), with the row's `aria-expanded` carrying the state semantics.
11. **Mouse and keyboard never desync.** Clicking any row (or the chevron) updates the roving
    `focusedKey` — implemented as an `onFocus` handler on both row cells (focusin-based,
    bubbles). Directory activation lives on the treeitem ROW's `onClick` (chevron clicks
    bubble to it; AT-synthesized clicks on the treeitem work too), which explicitly focuses
    the row from the gesture — the chevron's mousedown default is suppressed so real focus
    never parks on the aria-hidden button in any engine. An arrow press immediately after
    any click continues from the clicked row.
12. **Background refetches never steal focus.** Imperative `.focus()` runs ONLY inside the
    keydown handler, and every key's focus target already exists at keydown time (expand and
    collapse keep focus on the dir row itself; move-into fires only when the child row is
    rendered) — no post-render focus effect exists at all, so a poller-driven files refresh
    structurally cannot yank focus from elsewhere in the app.

## Design

- **State:** `focusedKey: string | null` (a `RenderRow.key`). Effective focus =
  `focusedKey`-if-present → selected file's row → `rows[0]`. `tabIndex` derives from it on
  both cell kinds.
- **Handler:** one `onKeyDown` on the `role="tree"` container, switching on `e.key` with the
  current index computed from the effective focused key against `rows` (single source of
  truth; no per-row handlers).
- **Imperative focus:** a `Map<rowKey, HTMLElement>` keyed by the existing `RenderRow.key`
  (one identity scheme — do not invent a second alongside #513's `data-row-*`), populated by
  ref callbacks with braced bodies (React 19 ref callbacks must not return `Map.set`'s value).
  NOT `querySelector` — directory keys contain the NUL separator, which attribute selectors
  cannot match.
- **Scrolling:** every row `.focus({ preventScroll: true })` — native focus-scroll would write
  `scrollLeft` on the `overflow-x: hidden` viewport and desync the #214 synthetic h-scrollbar,
  whose CSS-var/translateX mechanism is the sole horizontal authority. Vertical visibility is
  restored by a small helper that walks to the nearest scrollable-Y ancestor and adjusts
  `scrollTop` only (block-nearest math; never touches any `scrollLeft`).
- **No deferred focus:** every key's target row is already in the DOM when the key is handled
  (expand/collapse keep focus on the dir row; move-into requires the child row to be present),
  so focus moves synchronously in the keydown handler and no post-render focus effect exists
  (AC 12 holds structurally).
- **ArrowLeft parent scan** walks `rows` upward for the first row with smaller `depth` —
  correct for the flat list since ancestors always precede descendants.
- **Out of scope** (APG-optional, not required by the issue): type-ahead, `*` expand-all,
  multi-select. Recorded here so the omission is deliberate.

## Test plan (TDD, red first)

`FileTree.test.tsx` additions (RTL + userEvent keyboard):
- directory rows carry a roving `tabIndex` (red today: no tabIndex at all).
- ArrowDown/ArrowUp traverse files AND directories in visual order; no wrap at the edges.
- ArrowRight expands a collapsed dir (children appear), then moves into it when pressed again;
  no-op on files.
- ArrowLeft collapses an expanded dir; from a child (file or collapsed dir), jumps to the
  parent dir row; no-op at the top level.
- Home/End jump to first/last visible row.
- Enter/Space on a file calls `onSelectFile`; on a dir toggles collapse; arrows/Space prevent
  default (no scroll).
- Chevron button is `tabIndex={-1}` + `aria-hidden`; the tree has exactly one `tabIndex=0` row
  in every state (including after collapsing the focused subtree — fallback rule).
- Focused dir row's accessible name is exactly the directory name (no "Toggle" concatenation);
  expanded/collapsed states assert `aria-expanded` on the row.
- Click-then-arrow continuity: click a row (and separately the chevron), press ArrowDown —
  focus continues from the clicked row (AC 11).
- Rows-identity churn without a pending key does NOT call focus (AC 12): rerender with a new
  files array while focus is elsewhere; assert no focus movement.

`frontend/e2e/a11y-audit.spec.ts`: populated-tree case (nested directory in the files mock,
unscoped axe run) per AC 9.

## Files

- `frontend/src/components/PrDetail/FilesTab/FileTree.tsx`
- `frontend/src/components/PrDetail/FilesTab/FileTree.test.tsx`
- `frontend/e2e/a11y-audit.spec.ts`
