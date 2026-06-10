# Inbox visual-polish cluster — #345 / #346 / #347

**Date:** 2026-06-10
**Issues:** #345 (CI glyph vertical offset), #346 (toolbar/card right-edge misalign), #347 (grouped-row hover merges into repo-header band)
**Surface:** Inbox (`frontend/src/components/Inbox/`, `frontend/src/pages/InboxPage`)
**Class:** UI-visual, `priority:p3`. Gated — owner B1 screenshot sign-off is the gate.

## Summary

Three same-day p3 inbox visual bugs, shipped as one cohesive slice because they share the
inbox surface and two of the three live in the same file (`InboxRow.module.css`). Two are
real CSS fixes (#345, #347); one (#346) is already resolved by #137 and is verified-and-closed
here rather than re-fixed.

---

## #345 — CI status glyph vertically offset from the leading PR-state octicon

### Problem

The two glyphs meant to read as a matched pair flanking a PR title (#264) reference different
vertical boxes:

- **Leading PR-state octicon** (`.status`, `InboxRow.module.css:42`) is a direct child of the
  `.row` grid (`align-items: center`, `:11`) → centered to the **full row height** (title line
  + meta line + padding).
- **Trailing CI octicon** (`.ciSuffix`, `:79`) sits inside `.titleRow` (`align-items: flex-start`,
  `:69`) with `align-self: flex-start; margin-top: 2px` → pinned to the **top of the title's
  first line**.

On a single-line row the row's vertical center sits *below* the title's first-line center (the
meta line pulls it down), so the two glyphs diverge by a few px. Two-line titles mask it.

### Decision (forced, not a free choice)

There are only two ways to give both glyphs one reference:

- Center the CI glyph to the row → **reintroduces the two-line-title midpoint drift** that the
  `margin-top: 2px` pin was added in #264 to fix. **Rejected** — contradicts a prior decision.
- Pin the leading glyph to the title's first line → both flank the first line, matched on 1-line
  *and* 2-line titles, no drift. **Chosen.**

### Mechanism

Give `.status` the same alignment treatment `.ciSuffix` already has:

```css
.status {
  /* was: relies on the row grid's align-items: center */
  align-self: start;
  margin-top: 2px;
}
```

Both glyphs are 14px and both `.status` (grid column 1) and `.titleRow` (first child of `.main`,
grid column 2) start at the same content-box top, so an identical `start + 2px` offset lands them
pixel-matched **by construction** — no per-row magic numbers. The `2px` is the single tunable;
adjust it live if the optical centering on the title's first line needs a nudge.

### Validation (running app, Playwright `getBoundingClientRect`)

- Single-line-title row: leading and trailing glyph vertical centers within ~1px.
- Two-line-title row: both glyphs on the first line, no midpoint drift.
- `@container inbox-sections (max-width: 560px)` regime: still matched.
- Grouped rows (`data-grouped='true'`, left-indented) and the unread accent bar
  (`[data-unread='true']::before`) unaffected.

---

## #347 — grouped PR-row hover repaints to the repo-accordion header color

### Problem

Row-hover and repo-header-resting both resolve to `--surface-2`:

| Element | State | Background |
|---|---|---|
| `.row` (PR row) | resting | `transparent` (over surface-1 card) — `InboxRow.module.css:14` |
| `.row` | **hover** | `var(--surface-2)` — `:23` |
| `.header` (repo band) | resting | `var(--surface-2)` — `RepoGroupAccordion.module.css:22` |
| `.header` | hover | `var(--surface-3)` — `:33` |

A hovered grouped row becomes pixel-identical to the header band directly above it, so the
"this is the group header" vs "this is a PR in the group" boundary disappears on hover.

### Decision: dedicated `--row-hover` token (B1)

Chosen over `surface-3` (B2: heavier global hover, equals header-hover) and grouped-only-divergence
(B3: splits the hover language). B1 gives one consistent, intentional hover everywhere.

The surface scale is theme-relative — light **descends** (`s1` 0.99 → `s2` 0.925 → `s3` 0.90; header
band is *darker* than rows), dark **ascends** (`s1` 0.21 → `s2` 0.235 → `s3` 0.27; header *lighter*).
Either way `surface-2` is one step off the resting row. A hover landing **between `surface-1` and
`surface-2`** darkens (light) / lightens (dark) the row enough to read as a hover while staying on
the rows' side of the header band — it never crosses into (`s2`, the merge bug) or past it (`s3`,
which would make a hovered row heavier than its own group header and invert the hierarchy).

### Mechanism

One theme-adaptive declaration — `var()` resolves lazily against the active theme's surface tokens,
so a single line covers both themes:

```css
/* tokens.css, :root */
--row-hover: color-mix(in oklch, var(--surface-1), var(--surface-2) 60%);
```

```css
/* InboxRow.module.css */
.row:hover { background: var(--row-hover); }   /* was: var(--surface-2) */
```

`60%` (toward the header from the card) is the live-tunable knob: perceptible as a hover, yet
distinct from the header band. `.row:hover .comments` stays `--surface-3` and contrasts *better*
under the lighter row hover — left unchanged.

### Validation (running app, both themes)

- Three-way separation holds: row-resting (transparent/surface-1) vs row-hover vs header-resting
  (surface-2) are all visually distinct — worst case is a row immediately under a header.
- The header's own `:hover` (surface-3) still reads as distinct from an adjacent hovered row.
- Flat (ungrouped) list: lighter hover is innocuous (no header to collide with), still reads as a hover.
- Both `[data-theme="light"]` and `[data-theme="dark"]`.

---

## #346 — toolbar right edge vs section cards (rail off, wide viewport)

### Status: already fixed by #137 — verify and close, no CSS change

The issue describes a `.grid { grid-template-columns: 1fr auto }` whose reserved column-gap inset
the section cards when the rail was off at wide viewports. That layout was superseded by
`9ffb7d81 fix(#137): reserve the fixed rail column only when the rail is shown` (merged 2026-06-10):

- `InboxPage.tsx:126` — `<div className={styles.grid} data-has-rail={showRail || undefined}>`
- `InboxPage.module.css:12` — grid is single-column `1fr` by default; the fixed 380px rail column
  is reserved **only** under `.grid[data-has-rail]` (`:21`).
- The toolbar (`InboxPage.tsx:117`) is a full-width child of `<main>`, **outside** the grid.

With the rail off the grid is one full-width column → `.sections` spans the full page width,
matching the full-width toolbar. The reserved-gap root cause no longer exists. #346 was filed
against the pre-#137 layout.

### Action

Run the app rail-off (`inbox.showActivityRail = false`) at >1179px, screenshot the toolbar and
section-card right edges, confirm alignment, and **close #346** referencing `9ffb7d81` with the
screenshot as proof. If a residual misalignment is observed live, reopen the design for it.

---

## Scope / non-goals

- No change to the 3-column row grid, grouped-row indent, or B1-tuned metrics tail (#227).
- No new behavior, no backend, no test-only seams. Pure CSS for #345/#347; verification-only for #346.
- `--row-hover` is inbox-row-scoped in use (`InboxRow.module.css .row:hover`); the token is added
  to `tokens.css` but no other call site is repointed in this slice.

## Testing

- **Unit (vitest):** these are presentation-only CSS changes with no logic; existing InboxRow /
  RepoGroupAccordion render tests must stay green. No new unit assertions on computed pixel offsets
  (jsdom has no layout) — alignment is verified via Playwright in the running app.
- **Visual (Playwright, B1):** the validation bullets above; capture before/after for #345 and #347
  in both themes, and the #346 rail-off/wide screenshot. Regenerate any affected linux parity
  baselines from the CI artifact if the inbox visual baselines shift.

## References

- `frontend/src/components/Inbox/InboxRow.module.css` — `.status` (#345), `.row:hover` (#347)
- `frontend/src/components/Inbox/RepoGroupAccordion.module.css` — `.header` resting/hover (#347 context)
- `frontend/src/styles/tokens.css` — surface scale + new `--row-hover` (#347)
- `frontend/src/pages/InboxPage.tsx` / `InboxPage.module.css` — #346 verification
- Prior art: #264 (flanking status glyphs), #300 (toolbar↔card edge match), #137 (rail column reserve fix)
