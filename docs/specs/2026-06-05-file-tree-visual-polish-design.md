# File-tree visual polish — design

**Issue:** [#187](https://github.com/prpande/PRism/issues/187)
**Date:** 2026-06-05
**Tier:** T2 (medium; ~3 production files)
**Risk:** B1 — UI-visual (gated on a human visual assert before merge)

## Problem

The PR-detail **Files** tab renders a file tree (`FileTree.tsx`) that reads as
plain and has two concrete usability defects:

1. **The expand/collapse indicator is hard to see.** Directory rows use a `▸`
   glyph (U+25B8 — the *small* right-pointing triangle) at `--text-3` (the
   lowest-contrast text token), sized at the row's `--text-sm`. It is tiny and
   low-contrast, so a reviewer can't tell at a glance which rows are expandable
   or what state they're in. (This is the original #187 report.)
2. **The viewed checkbox slides out of view.** On rows with long leaf names the
   checkbox at the right end is pushed past the tree container's right edge,
   forcing a horizontal scroll to reach it.

Beyond the defects, the tree could read more like an IDE explorer (VS Code's
Solution Explorer was the reference) without adding noise.

## Goals

- Make the expand/collapse affordance clearly legible in both themes.
- Give directories an IDE-like accent folder icon.
- Keep file rows calm — the existing colored status badge stays the only colored
  mark per row.
- Tighten indentation to GitHub's PR-tree density.
- Make deletions obvious from the name itself (strikethrough).
- Keep the viewed checkbox always reachable at the tree's right edge.

## Non-goals

- **Per-language file-type icons** (a Seti/material-style set). Explicitly
  rejected *for now* (see Rejected alternatives). We are choosing not to invest
  in a type-icon set: the status badge is the priority colored mark, and a
  per-type icon would add a competing second colored mark per row. The
  often-cited "reviewers don't need language discrimination in a changed-files
  list" is an *assumption*, not a measured fact — the decision rests on the
  competing-mark cost + YAGNI + the repo's prior icon-weight minimization (PR
  #74), not on a claim about reviewer behavior. The **directory accent icon**
  (item 2) is *not* a file-type icon and is in scope.
- No icon library is added. All glyphs are hand-authored inline SVG.
- No change to tree-building, selection, keep-alive, or AI-focus *behavior*.
  This is presentation-plus-a11y only. Two deliberate exceptions: item 6 changes
  the viewed *styling* (drops its strikethrough), and item 8 adds an SR-only
  status label (an accessibility addition, not a behavior change to existing
  flows). Both are called out where they occur.

## Design

All work is in three files:

- `frontend/src/components/PrDetail/FilesTab/FileTree.tsx`
- `frontend/src/components/PrDetail/FilesTab/FileTree.module.css`
- `frontend/src/components/PrDetail/FilesTab/FilesTab.module.css` — item 7 only;
  the grid container (`.filesTabContent` / `.filesTabTree`) that actually causes
  the checkbox overflow.

### 1. Chevron — larger SVG, higher contrast

Replace the `▸` text glyph in `DirectoryNodeComponent` (currently
`FileTree.tsx:255`) with an inline SVG chevron-right:

```html
<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
  <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.75"
        stroke-linecap="round" stroke-linejoin="round" />
</svg>
```

CSS (`.fileTreeChevron`): drop `width: 1em` / `text-align: center` (glyph-era
rules); set the SVG to a flex-none 15px box, `color: var(--text-2)` (up from
`--text-3`). Keep the existing `transition: transform var(--t-fast)` and the
`.fileTreeChevronOpen { transform: rotate(90deg) }` rotate — an SVG
chevron-right rotated 90° points down, matching the current affordance.

The chevron stays inside the existing `.fileTreeDirToggle` `<button>` (which
keeps its `aria-label="Toggle <name>"`), so keyboard/AT behavior is unchanged.

### 2. Folder icons (accent)

Add an inline SVG folder glyph in `DirectoryNodeComponent`, after the chevron,
before the directory name, inside the toggle button (so it shares the chevron's
hit target):

```html
<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
  <path d="M1.5 4.5a1 1 0 0 1 1-1H6l1.5 1.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"
        fill="currentColor" />
</svg>
```

New `.fileTreeFolderIcon` class: `color: var(--accent)`, `flex: none`,
`display: inline-flex`. The icon is decorative (`aria-hidden`); the directory
name remains the accessible label.

**Decided sub-points (raised in design review):**

- **Expanded vs collapsed folder glyph:** the folder icon is **static** — it
  does *not* swap to an open-folder shape. The enlarged chevron's rotation is
  the sole expand/collapse signal. (This intentionally diverges from VS Code's
  open-folder glyph; a single path is simpler and the chevron already carries
  state.)
- **Directory-row hover:** directory rows have no hover today; file rows do
  (`.fileTreeFile:hover { background: var(--surface-3) }`). Add a matching
  `.fileTreeDirHeader:hover { background: var(--surface-3) }` so the now-stronger
  directory affordance gives the same feedback as file rows.
- **Accent icon vs. selected-row background:** the selected row background is a
  muted same-hue tint (`accent-soft`-derived); the folder icon is full
  `--accent`. The icon stays `--accent` regardless of selection — the same-hue
  pairing is intentional and reads as related, not clashing. No
  selection-conditional icon recolor.
- **Keyboard focus target (known, not changed here):** the directory name stays
  *outside* the toggle button (its current structure), so the focus ring
  outlines the chevron+folder cluster, not the full row — unchanged from today.
  Making the whole header the toggle target would alter click semantics
  (clicking the name would expand/collapse) and is deferred out of this scope.

### 3. File rows — unchanged structure, no icons

File rows (`FileNodeComponent`) keep their current children: status badge →
name → AI-focus slot → viewed checkbox. **No file-type icon is added.** This is
a deliberate decision, not an omission.

### 4. Indentation — 12px / level

Indentation is currently `depth * 16px` for directories (`FileTree.tsx:245`)
and `(depth + 1) * 16px` for files (`FileTree.tsx:182`). Change the unit from
`16` to `12` in both places. Introduce a single shared constant
`INDENT_PER_LEVEL = 12` so the two sites can't drift.

### 5. Deleted files — strikethrough on the name

Add a `.fileTreeFileName--deleted` treatment, applied when
`node.file.status === 'deleted'`:

```css
text-decoration: line-through;
text-decoration-color: var(--danger-fg);
text-decoration-thickness: 1.5px;
color: var(--text-2);
```

Paired with the red `[D]` status badge (which gains a real SR-only label in
item 8), a deleted file is unmistakable both visually and to assistive tech.
This is the tree's **only** strikethrough (see item 6).

> Items 5 and 6 are a **user-requested pair** from the design session, not
> emergent scope creep: the request was explicitly "strike through deleted
> files" and "gray viewed files instead of striking them." They are bundled
> deliberately because item 5's new strikethrough is what frees item 6 to drop
> the viewed strikethrough.

### 6. Viewed files — gray out, drop the strikethrough

Today viewed files are styled by:

```css
.fileTreeFile:has(.fileTreeViewedCheckbox:checked) .fileTreeFileName {
  color: var(--text-3);
  text-decoration: line-through;
  text-decoration-color: var(--border-strong);
  text-decoration-thickness: 1px;
}
```

**Remove the `text-decoration*` declarations**, keep `color: var(--text-3)`.
Viewed now reads as "dimmed + checked box"; strikethrough is reserved entirely
for deletion. This removes the visual collision where a viewed file and a
deleted file both showed a struck name.

**Cascade — corrected from review.** Once the viewed rule no longer sets
`text-decoration` at all, there is *no* strikethrough collision: the item-5
`--deleted` rule is the only thing setting `text-decoration`, so a deleted file
keeps its red strike regardless of source order or specificity. Removing the
declaration *is* the protection — not source-ordering. (An earlier draft claimed
source-order would protect the strike; that was wrong on two counts: there's
nothing left to out-order, and a plain `.fileTreeFileName--deleted` at (0,1,0)
could never beat the viewed rule's (0,4,0) `:has()` specificity anyway.)

For a row that is **both deleted and viewed**, the two rules now collide only on
`color`: deletion sets `--text-2` (0,1,0), the viewed rule sets `--text-3`
(0,4,0). The viewed rule wins on specificity, so the name renders dim
(`--text-3`) **with** the red strike. That is the intended "deleted + already
looked at" look — acceptable, and explicitly *not* something to fight with
`!important`. No action needed beyond removing the viewed `text-decoration`.

### 7. Pinned checkbox — truncate names, never scroll sideways

**Invariant:** the tree never scrolls horizontally; long **file and directory**
names ellipsize at the container boundary; the viewed checkbox stays at the
tree's right edge.

**Root cause (diagnosed, not deferred).** The file name already has `flex: 1;
min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`,
so the *row*'s name column would shrink — but the **container** above it won't.
The tree lives in a CSS **grid**, not a flex chain:

- `.filesTabContent` is `display: grid; grid-template-columns: minmax(240px,
  320px) 1fr; overflow: hidden` (`FilesTab.module.css`).
- The tree is the first grid item, `.filesTabTree`, which sets `overflow-y:
  auto` but **no `min-width: 0`**. A grid item's automatic minimum size is its
  *min-content* on the inline axis; `overflow-y` does not relax the inline-axis
  minimum. So a long unbreakable name makes `.filesTabTree`'s min-content wide,
  the grid item refuses to shrink below it, and its content (including the
  right-edge checkbox) is pushed past the visible track — which
  `.filesTabContent`'s `overflow: hidden` then clips out of reach.
- `.fileTree` additionally pins `min-width: 240px; max-width: 360px`; the
  `max-width: 360px` exceeds the grid track's 320px max and should be reconciled
  (cap at the track or drop the max-width) so the inner tree can't exceed its
  track either.

**Fix:**

- Add `min-width: 0` to `.filesTabTree` (the grid item) — the load-bearing fix;
  this lets the track-constrained item shrink so the row's `flex: 1` name column
  can finally ellipsize.
- Reconcile `.fileTree`'s `max-width: 360px` against the 320px track (cap it).
- Belt-and-suspenders `overflow-x: hidden` on the list **after** the above — on
  its own it would only *clip* a still-too-wide row (hiding the name end under
  the clip instead of showing an ellipsis), so it is a guard, not the fix.
- **Directory names** (`.fileTreeDirName`) currently have *no* truncation
  styling (only `font-weight: 500`), so a long deep-nested folder name overflows
  the same way. Give `.fileTreeDirName` the same `min-width: 0; overflow:
  hidden; text-overflow: ellipsis; white-space: nowrap` and a `title` attribute.
  Without this the invariant holds for files but not directories.
- Add `title={node.name}` to both the file-name and directory-name spans so the
  full name is available on hover when truncated.

No `position: sticky` hack is needed once rows can't exceed the container.

### 8. Status badge — add the missing SR-only label

**Found in review:** the status badge today renders a bare glyph —
`<span ...>{STATUS_LABELS[status] ?? '?'}</span>` (`FileTree.tsx:186-190`) — with
**no** `aria-label`, `title`, or SR-only text. A screen-reader user hears just
the letter "D"/"A"/"M"/"R" with no meaning, and the new deletion strikethrough
(item 5) conveys nothing non-visually. So deletion (and every status) currently
has no real non-visual carrier — the original a11y claim was false.

Add an SR-only label alongside the badge, mapping status → word
(`added`/`modified`/`deleted`/`renamed`), e.g. a visually-hidden
`<span className="sr-only">Deleted </span>` (reusing the existing `.sr-only`
utility, same pattern as the AI-focus SR text already in this component at
`FileTree.tsx:205-207`). The visible badge stays the single letter. This makes
status — including deletion — a genuine non-visual signal, independent of the
color/strikethrough.

## Accessibility

- Chevron and folder SVGs are `aria-hidden`; the toggle button keeps its
  `aria-label`, and the directory/file names remain the accessible text.
- **Contrast:** the chevron moves `--text-3 → --text-2`, strictly higher
  contrast. The accent folder icon is decorative, so it carries no text-contrast
  requirement (1.4.3); it should still be perceivable, which `--accent` is on
  both surfaces. Deleted/viewed name colors (`--text-2` / `--text-3`) are
  existing body-text tokens already cleared for AA on the tree surface.
- **Not color-alone (1.4.1):** deletion and viewed state are conveyed by more
  than the name styling. Deletion → the `[D]` badge **plus its new SR-only label
  (item 8)**; viewed → the checkbox's `aria-label` and its checked state. The
  strikethrough (deleted) and the dim (viewed) are reinforcement, not the sole
  signal. This redundancy only holds *because* item 8 ships in the same change —
  without it, deletion would fail 1.4.1 for SR/low-vision users.

## Testing

- **vitest (behavioral, where assertable):**
  - Directory rows render a chevron SVG (not the `▸` glyph) and a folder icon.
  - A `deleted` file's name span carries the `--deleted` class; a non-deleted
    file does not.
  - Toggling the viewed checkbox applies the gray treatment and **no**
    `line-through` (assert the class/style contract, not pixels).
  - Indentation uses the 12px unit (assert computed `padding-left` for a known
    depth, or that the shared constant is consumed).
  - Both file-name and directory-name spans carry `title={node.name}` and the
    ellipsis class contract.
  - **Status SR-only label (item 8):** a `deleted` file's row exposes the
    accessible word "Deleted" (e.g. `getByText`/role query on the SR-only span);
    likewise added/modified/renamed. This is the regression guard for the a11y
    carrier the spec depends on.
- **Layout (item 7):** a unit assertion on real truncation is brittle in jsdom
  (no layout engine). Cover the *DOM contract* in vitest (name has the ellipsis
  classes; `.filesTabTree` carries `min-width:0`) and rely on the B1 visual
  assert for the rendered proof. The visual assert must distinguish **ellipsis**
  (name ends in "…", checkbox visible) from **clip** (name hard-cut with no
  ellipsis) — the latter means `overflow:hidden` is masking a still-too-wide row
  rather than the grid item actually shrinking. A long-name row in *both* a
  shallow and a deep-nested position is required in the screenshot set.
- **Visual (B1):** before/after screenshots of the Files tree in **both** themes
  — covering a folder (expanded + collapsed), an added/modified/deleted file, a
  viewed file, a long file-name row, and a long deep-nested *directory* name —
  captured for the human assert. The **loading state** (`isLoading` → `null`) is
  pre-existing and unchanged, so it is intentionally **out of scope** for this
  assert. Parity baselines under `frontend/e2e/__screenshots__/` will shift;
  update them in the PR.

## Risks / tradeoffs

- **Truncation hides the end of long names.** Accepted: the tree already splits
  the path into folders, so the row name is just the leaf; end-ellipsis + the
  `title` tooltip matches GitHub. (Middle/left-ellipsis was considered and
  rejected as non-standard.)
- **Viewed styling change trades scannability for unambiguity.** This is a real
  trade, not a free win (review flagged it). The strikethrough was the strongest
  *peripheral-vision* cue for "already viewed" — detectable without foveating the
  row. Dropping it leaves dim-color + the right-edge checkbox, both lower-salience
  for at-a-glance "which have I reviewed?" scanning. We accept this deliberately:
  deletion ambiguity is a correctness risk, viewed-scannability is a convenience,
  and the user explicitly chose gray-not-strike for viewed. If viewed scanning
  proves worse in practice, a non-strike high-salience cue (e.g. a check glyph or
  a left rail tint) can be added later without re-colliding with deletion.
- **Existing visual baselines break.** Expected for any visual change; refreshed
  in-PR and gated by the human visual assert.

## Rejected alternatives

- **Colored file-type icons (VS Code Seti-style).** Adds a second colored mark
  per row that competes with the status badge; high asset/maintenance cost
  (icon set + licensing) against a repo that deliberately minimized icon weight
  (PR #74). Low value when the file set is only the changed files.
- **Monochrome file-type icons.** Subtler, and carry *no* competing color — so
  the "second colored mark" argument doesn't apply to them. Rejected on YAGNI +
  per-row visual weight, not on the colored-mark argument. This is the closest
  rejected option; if type discrimination is later shown to matter, monochrome
  type glyphs are the path to revisit first.
- **Generic file glyph on every file row.** Even a single non-type file icon is
  visual weight with no information; the status badge already occupies that slot.
- **Color-differentiated strikethrough for viewed vs deleted** (red strike vs
  gray strike). Superseded by item 6 — dropping the viewed strike entirely is
  simpler and unambiguous.
- **`position: sticky` checkbox.** Unnecessary once the grid item shrinks; would
  paper over the real overflow bug rather than fix it.
- **Whole directory header as the toggle target** (so clicking the name expands
  /collapses, and the focus ring spans the full row). Better keyboard UX, but it
  changes click semantics and is out of scope here — see Deferred.

## Deferred (out of this scope)

- **Full-row directory toggle / focus target.** Today the toggle is the
  chevron+folder button only; the focus ring outlines that cluster, not the whole
  directory row. Worth doing, but it changes click behavior — track separately.
- **Higher-salience "viewed" cue** if the gray-only treatment proves hard to scan
  (see Risks).

## Open questions

None.
