# File-tree visual polish — design

**Issue:** [#187](https://github.com/prpande/PRism/issues/187)
**Date:** 2026-06-05
**Tier:** T2 (medium; ~2 production files)
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

- **File-type icons.** Explicitly rejected (see Rejected alternatives). A PR
  shows only *changed* files; reviewers navigate by status/risk, not language.
  Per-type icons would add a competing second colored mark per row.
- No icon library is added. All glyphs are hand-authored inline SVG.
- No change to tree-building, selection, keep-alive, AI-focus, or viewed-state
  *behavior* — this is presentation only, except where item 6 changes the
  viewed *styling*.

## Design

All work is in two files:

- `frontend/src/components/PrDetail/FilesTab/FileTree.tsx`
- `frontend/src/components/PrDetail/FilesTab/FileTree.module.css`

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

Paired with the existing red `[D]` status badge, a deleted file is unmistakable.
This is the tree's **only** strikethrough (see item 6).

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

A file that is both deleted and viewed shows the danger strikethrough (item 5
wins the `text-decoration`) plus the dim — still clearly a deletion. (The
`--deleted` class and the `:has(:checked)` rule both set `text-decoration` /
`color`; the cascade must land deletion's strikethrough on top. Source-order the
`--deleted` rule after the viewed rule, or scope deletion with higher
specificity, so a viewed deleted file keeps its strike.)

### 7. Pinned viewed checkbox — truncate, never scroll sideways

**Invariant:** the file list never scrolls horizontally; long leaf names
ellipsize at the container boundary; the viewed checkbox stays at the tree's
right edge.

The name already has `flex: 1; min-width: 0; overflow: hidden; text-overflow:
ellipsis; white-space: nowrap`, which *should* truncate — yet the checkbox is
reported sliding off-screen, so a row is computing wider than its container
somewhere in the flex chain. The implementer must reproduce the overflow
(systematic-debugging) and fix the root cause, then lock it with a guard:

- Add `overflow-x: hidden` to the scroll container (`.fileTree` / the list) as a
  belt-and-suspenders clamp **after** the real cause is fixed (the clamp alone
  would just hide a still-too-wide row; the flex chain must actually shrink).
- Verify the `min-width: 0` chain holds from `.fileTree` down through any
  intermediate flex wrappers to `.fileTreeFileName` (a missing `min-width: 0` on
  an ancestor flex item is the usual culprit for "ellipsis won't kick in").
- Add a `title={node.name}` attribute to the file name span so the full leaf
  name is available on hover when truncated.

No `position: sticky` hack is needed once rows can't exceed the container.

## Accessibility

- Chevron and folder SVGs are `aria-hidden`; the toggle button keeps its
  `aria-label`, and the directory/file names remain the accessible text.
- **Contrast:** the chevron moves `--text-3 → --text-2`, strictly higher
  contrast. The accent folder icon is decorative, so it carries no text-contrast
  requirement (1.4.3); it should still be perceivable, which `--accent` is on
  both surfaces. Deleted/viewed name colors (`--text-2` / `--text-3`) are
  existing body-text tokens already cleared for AA on the tree surface.
- Deletion and viewed state are not conveyed by the name styling alone — the
  `[D]` badge (with its SR-only label) and the checkbox (with `aria-label`)
  remain the non-visual carriers, so the strikethrough/dim are reinforcement,
  not the sole signal.

## Testing

- **vitest (behavioral, where assertable):**
  - Directory rows render a chevron SVG (not the `▸` glyph) and a folder icon.
  - A `deleted` file's name span carries the `--deleted` class; a non-deleted
    file does not.
  - Toggling the viewed checkbox applies the gray treatment and **no**
    `line-through` (assert the class/style contract, not pixels).
  - Indentation uses the 12px unit (assert computed `padding-left` for a known
    depth, or that the shared constant is consumed).
  - File name span carries `title={node.name}`.
- **Layout (item 7):** a unit assertion on the truncation/overflow contract is
  brittle in jsdom (no real layout). Cover the *DOM contract* in vitest (name
  has the ellipsis classes + `min-width:0` chain present) and rely on the B1
  visual assert for the rendered "checkbox pinned, name truncated" proof.
- **Visual (B1):** before/after screenshots of the Files tree in **both** themes
  — covering a folder (expanded + collapsed), an added/modified/deleted file, a
  viewed file, and a long-name row — captured for the human assert. Parity
  baselines under `frontend/e2e/__screenshots__/` will shift; update them in the
  PR.

## Risks / tradeoffs

- **Truncation hides the end of long names.** Accepted: the tree already splits
  the path into folders, so the row name is just the leaf; end-ellipsis + the
  `title` tooltip matches GitHub. (Middle/left-ellipsis was considered and
  rejected as non-standard.)
- **Viewed styling change is a behavior change**, however small — anyone who
  associated the strike with "viewed" must relearn it as "deleted." The dim +
  checked box still clearly marks viewed, and the change *removes* an ambiguity,
  so net-positive.
- **Existing visual baselines break.** Expected for any visual change; refreshed
  in-PR and gated by the human visual assert.

## Rejected alternatives

- **Colored file-type icons (VS Code Seti-style).** Adds a second colored mark
  per row that competes with the status badge; high asset/maintenance cost
  (icon set + licensing) against a repo that deliberately minimized icon weight
  (PR #74). Low value when the file set is only the changed files.
- **Monochrome file-type icons.** Subtler, but still a per-row glyph whose
  per-type recognition earns little in a changed-files-only view; rejected for
  YAGNI.
- **Generic file glyph on every file row.** Even a single non-type file icon is
  visual weight with no information; the status badge already occupies that slot.
- **Color-differentiated strikethrough for viewed vs deleted** (red strike vs
  gray strike). Superseded by item 6 — dropping the viewed strike entirely is
  simpler and unambiguous.
- **`position: sticky` checkbox.** Unnecessary once rows can't overflow; would
  paper over the real flex-chain bug rather than fix it.

## Open questions

None.
