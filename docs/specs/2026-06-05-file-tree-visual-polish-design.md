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
2. **Long directory names spill past the tree's right edge.** A long
   smart-compacted folder path overflows the tree container and makes the tree
   scroll sideways, because `.fileTreeDirName` has no truncation (only
   `font-weight: 500`). The *file*-row viewed checkbox does **not** have this
   problem — the existing file-name ellipsis already keeps it pinned at the edge
   (validated against the running app; see item 7). An earlier framing of this
   defect as "the viewed checkbox slides off screen" was an assumption that did
   not reproduce when measured.

Beyond the defects, the tree could read more like an IDE explorer (VS Code's
Solution Explorer was the reference) without adding noise. The design session
expanded the work accordingly — folder icons, tighter indentation, deletion and
viewed legibility, and a found accessibility gap (the status badge has no
screen-reader label). The **Goals** section below is the full scope; the two
defects above are just its origin.

## Goals

- Make the expand/collapse affordance clearly legible in both themes.
- Give directories an IDE-like accent folder icon.
- Keep file rows calm — the existing colored status badge stays the only colored
  mark per row.
- Tighten indentation to GitHub's PR-tree density.
- Make deletions obvious from the name itself (strikethrough).
- Keep long directory names from spilling past the tree's right edge (no
  sideways scroll). The file-name ellipsis already keeps the viewed checkbox
  reachable, so the checkbox itself needs no new work.

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
- No change to tree-building, selection, keep-alive, or AI-focus *logic*. This is
  presentation-plus-a11y only — item 5 (deleted strikethrough) and the visual
  parts of items 1–4, 6, 7 are additive styling. Two changes touch *existing*
  treatment rather than only adding new styling, and are called out where they
  occur: item 6 removes the viewed strikethrough, and item 8 re-labels the status
  badge for assistive tech (marking the visible letter `aria-hidden`).

## Design

All work is in three files:

- `frontend/src/components/PrDetail/FilesTab/FileTree.tsx`
- `frontend/src/components/PrDetail/FilesTab/FileTree.module.css`
- `frontend/src/components/PrDetail/FilesTab/FilesTab.module.css` — item 7 only;
  the grid container (`.filesTabTree`) gets a `min-width: 0` robustness guard
  (not the load-bearing fix — see item 7).

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

Add an inline SVG folder glyph as the **last child of the toggle button**, after
the chevron (so it shares the chevron's hit target). The directory name stays a
sibling *outside* the button, exactly as today — it does not move:

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
- **Spacing:** `.fileTreeDirHeader` has no `gap` today (the toggle button was
  chevron-only and sat flush to the name). With the folder icon now ending the
  button, add `gap: var(--s-2)` to `.fileTreeDirHeader` so the chevron+folder
  cluster doesn't collide with the directory name — mirroring the file row's gap.
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

### 7. Two-layer scrolling tree + fixed checkbox column — full names reachable by horizontal scroll

> **⚠️ DESIGN SUPERSEDED (2026-06-05, during implementation, user-directed).** The
> truncation approach below was abandoned after live iteration with the user. The
> shipped, user-approved design for item 7 is the **two-layer scrolling tree**
> described in this box; treat it as authoritative for item 7. The original
> truncation write-up is retained underneath for history (it still holds the useful
> empirical finding that the checkbox-slides-off-screen report was an assumption).
>
> **Why it changed:** the user explicitly wanted long names reachable by *scrolling*
> (not ellipsized away), the whole tree to scroll *as one object*, and the
> checkboxes to stay *perfectly* static as a "separate object" — none of which
> truncation delivers. `position: sticky` was tried and measurably drifts ~13px at
> scroll-end, so it was rejected.
>
> **Shipped design:**
> - **One horizontal scroll container** (`.file-tree-scroll`, `overflow-x: auto;
>   overflow-y: hidden`) wraps the whole tree; its inner (`.file-tree-inner`,
>   `width: max-content; min-width: 100%`) makes every row equal-width, so scrolling
>   shifts the entire tree (indent, chevron, folder, badge, name) uniformly — it
>   reads as one object and indentation stays aligned. No name truncation.
> - **Separate checkbox column** (`.file-tree-check-col`) renders OUTSIDE that
>   scroller, one slot per row (file → checkbox, dir → empty), so the checkboxes
>   never move horizontally (measured constant x across scroll 0/mid/max — the
>   property sticky failed). Both columns are rendered from one flat row list
>   (directory expand/collapse state lifted to `FileTree`, keyed by the NUL-joined
>   ancestor chain) and share a fixed `--tree-row-h` so they stay row-aligned.
> - **No inner vertical scroll and no seam** (user follow-up): vertical space uses
>   the outer `.files-tab-tree` pane scroll; the two columns are plain
>   content-height siblings (no JS sync, no border) so they read as one surface.
> - **a11y:** a single labeled `Viewed <name>` checkbox lives in the column;
>   reading order trails the tree (accepted tradeoff for a PoC).
> - **Consequence filed separately:** with the inner vertical scroll removed, an
>   abspos `.sr-only` descendant escapes the pane's clip and lets the *page* scroll
>   into empty space — tracked as issue #197 (pre-existing; not part of item 7).

**Invariant (original truncation framing — superseded):** the tree never scrolls
horizontally; long **file and directory** names ellipsize at the container
boundary; the viewed checkbox stays at the tree's right edge.

**Validated against the running app (BFF PR #191, tree at its 320px track, two
viewport widths).** Live measurement *corrected* the original diagnosis:

- **File rows are already fine — no new work needed for the checkbox.** Every
  file-row viewed checkbox renders at the same x, inside the tree's right edge
  (measured `cbRight 294 ≤ edge 320`, **zero** offenders), and long file names
  report `ellipsized: true`. The existing `.fileTreeFileName { flex: 1;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }`
  (present since the original port `aa1908a`) already shrinks the name and pins
  the checkbox. **The "viewed checkbox slides off screen" report did not
  reproduce** — it was an assumption, not an observation.
- **`.filesTabTree` (the grid item) does not overflow** (measured `scrollWidth ==
  clientWidth == 319`). So a grid-item `min-width: 0` is **not** the load-bearing
  fix — nothing is pushing the grid item wide.
- **Directory names are the real, reproducible defect.** `.fileTreeDirName` has
  *no* truncation (only `font-weight: 500`). A long smart-compacted path —
  `ApiClients/Mindbody.Scheduling.ApiClient/Models` — renders to a right edge of
  **344px**, 24px past the tree's 320px edge, driving `.fileTree`'s content to
  `scrollWidth 344` vs `clientWidth 309` (35px of horizontal overflow) and making
  the tree scroll sideways. Directory rows carry no checkbox, so this is a
  folder-path-spill / horizontal-scroll defect, not a checkbox defect.

**Fix (headline first):**

- **Truncate directory names — the load-bearing fix.** Give `.fileTreeDirName`
  the same treatment file names already have: `min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap`. This removes the only
  inline-axis content that exceeds the track, so the tree stops scrolling
  sideways.
- `title={node.name}` on **both** the file-name and directory-name spans so the
  full name is available on hover when truncated.
- **Robustness guards (explicitly *not* the fix — cheap insurance for a
  very-narrow-tree future).** Add `min-width: 0` to `.filesTabTree` (the grid
  item) and to `.fileTree`, and drop `.fileTree`'s inert `max-width: 360px` (it
  exceeds the 320px track). These matter only if the tree were ever forced below
  the dir-name min-content at an extreme width; directory-name truncation already
  removes that pressure, but the guards keep the invariant from regressing if the
  layout changes later. They are labeled guards, not load-bearing — the measured
  `.filesTabTree` state today is already non-overflowing.
- Belt-and-suspenders `overflow-x: hidden` on the list **after** the above — on
  its own it would only *clip* a still-too-wide row (hiding the name end under
  the clip instead of showing an ellipsis), so it is a final guard, not the fix.

No `position: sticky` hack is needed: the file-name ellipsis already pins the
checkbox, and directory-name truncation removes the sideways scroll.

### 8. Status badge — replace the bare letter for assistive tech

**Found in review:** the status badge today renders a bare glyph —
`<span ...>{STATUS_LABELS[status] ?? '?'}</span>` (`FileTree.tsx:186-190`) — with
**no** `aria-label`, `title`, SR-only text, *or* `aria-hidden`. A screen-reader
user hears just the letter "D"/"A"/"M"/"R" with no meaning, and the new deletion
strikethrough (item 5) conveys nothing non-visually. So deletion has no real
non-visual carrier — the original a11y claim was false.

The fix must **replace, not stack.** Because the letter is unguarded text,
adding an SR-only word *next to it* would make AT announce both ("D Deleted
Program.cs"). Mark the visible letter `aria-hidden` and add the word so AT reads
the word *instead of* the letter. Exact structure, SR word **before** the name
so it reads as a prefix:

```jsx
<span className={`file-status ... ${styles.fileStatus} ...`} aria-hidden="true">
  {STATUS_LABELS[node.file.status] ?? '?'}
</span>
<span className="sr-only">{STATUS_WORD[node.file.status]} </span>
```

`STATUS_WORD` maps `added/modified/deleted/renamed →
"Added"/"Modified"/"Deleted"/"Renamed"`. `.sr-only` already exists (tokens.css);
the AI-focus SR text at `FileTree.tsx:205-207` is the same recipe — but place
this span *before* the name span, not after (the AI span trails its row by
design). Reading result: "Deleted Program.cs".

**Scope note:** only `deleted` is strictly *required* for 1.4.1 — its
strikethrough is the color-alone signal item 5 introduces. Labeling all four
statuses is a consistency choice (uniform markup + cheap a11y hygiene), not four
separate correctness fixes; we do all four because the per-status branch is the
same code either way.

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
  - **Status SR-only label (item 8):** assert **both** that a `deleted` row
    exposes the accessible word "Deleted" *and* that the visible letter span
    carries `aria-hidden` (i.e. the bare "D" is absent from the row's accessible
    name) — otherwise the double-announce regression slips through. Likewise
    added/modified/renamed. This is the regression guard for the a11y carrier the
    spec depends on.
- **Layout (item 7):** a unit assertion on real truncation is brittle in jsdom
  (no layout engine), and the grid `min-width:0` is now a robustness guard rather
  than the load-bearing fix, so the meaningful proof is visual. Cover the *DOM
  contract* in vitest (both name spans carry `title`; the directory-name span
  carries the ellipsis-class contract) and rely on the B1 visual assert for the
  rendered proof. The visual assert must show a long **directory** name
  ellipsizing (ends in "…") with the tree no longer scrolling sideways, and must
  distinguish **ellipsis** from **clip** (a hard-cut name with no ellipsis means
  `overflow:hidden` is masking a still-too-wide row). It must also **confirm the
  file-row checkbox stays pinned** — that is already-correct behavior, captured
  as a regression guard, not as proof of a new fix. A long name in *both* a
  shallow and a deep-nested position is required in the screenshot set.
- **Visual (B1):** before/after screenshots of the Files tree in **both** themes
  — covering a folder (expanded + collapsed), an added/modified/deleted file, a
  viewed file, a long file-name row, and a long deep-nested *directory* name —
  captured for the human assert. The **loading state** (`isLoading` → `null`) is
  pre-existing and unchanged, so it is intentionally **out of scope** for this
  assert. Parity baselines under `frontend/e2e/__screenshots__/` will shift;
  update them in the PR.

## Risks / tradeoffs

- **Truncation hides the end of long names.** Accepted, for both file and
  directory names: the tree already splits the path into folders, so a file row's
  name is just the leaf, and a truncated directory path keeps its left (highest)
  segments visible; end-ellipsis + the `title` tooltip matches GitHub.
  (Middle/left-ellipsis was considered and rejected as non-standard.)
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
- **`position: sticky` checkbox.** Unnecessary — the file-name ellipsis already
  pins the checkbox at the right edge (measured against the running app); the
  real overflow is directory names, fixed by truncation. Sticky would paper over
  a bug the checkbox does not actually have.
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
