# Inbox visual-polish cluster — #345 / #346 / #347

**Date:** 2026-06-10
**Issues:** #345 (CI glyph vertical offset), #346 (toolbar/card right-edge misalign), #347 (grouped-row hover merges into repo-header band)
**Surface:** Inbox (`frontend/src/components/Inbox/`, `frontend/src/pages/InboxPage`)
**Class:** UI-visual, `priority:p3`. Gated — owner B1 screenshot sign-off is the gate.

## Summary

Inbox visual-polish grouped because the items share the inbox surface. The **deliverable** is three
CSS fixes — #345 (glyph alignment), #347 (row-hover token), and a **section-spacing rhythm** fix
folded in during live review (owner request) — across `frontend/src/components/Inbox/`,
`frontend/src/pages/InboxPage.module.css`, and `frontend/src/styles/tokens.css`. #346 carries **no
CSS** — it was already resolved by #137 (`9ffb7d81`); owner confirmed it resolved live, so it is a
verification-only close, not a code change in this PR.

All four were verified live against the real inbox at 1920×1080 (real token store, no mocks).

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

### Decision (revised after live review)

The CI glyph isn't visually paired with the leading octicon — it sits at the **right edge of the
title column, immediately left of the diff bar**, reading as part of the right-side metrics cluster.
Owner observed the first-line pin left it floating ~11.5px **above** the row-centered metrics it sits
beside, looking out of place. So the reference is the **row center the metrics already use**, not the
title's first line:

- ~~Pin both glyphs to the title's first line~~ — initial choice; **reversed**. It aligned the CI glyph
  with the leading octicon but left it misaligned with the adjacent metrics (the more salient
  neighbor) and pushed the leading glyph off the row center too.
- **Row-center everything** — leading octicon, CI glyph, and metrics all share the row's vertical
  center. **Chosen.** This also still satisfies #345's original "matched pair" concern (leading == CI),
  just anchored to the metrics' center line. The #264 two-line "optically center on the first line"
  intent is dropped in favor of metric alignment (owner call).

### Mechanism

`.status` stays grid-row-centered (revert — no `align-self`/`margin-top`). The CI glyph is the harder
case: it lived inside `.titleRow` at the top of `.main`, so it could only ever pin to the first line.
Move it **out of `.titleRow`** to be a sibling of `.main` inside a new row-centering flex wrapper
`.midCol` (grid column 2):

```
.midCol (flex, align-items: center)     ← row-centers its children
  .main (flex: 1, column: titleRow + meta)
  .ciSuffix (flex: none)                 ← lands at the column's right edge, row-centered
```

`.main { flex: 1 }` fills the column so the `flex: none` CI glyph sits at its right edge — the same
x it occupied before (≈ left of the diff bar). `align-items: center` on `.midCol` puts the glyph on
the row's vertical center. `.ciSuffix` drops its `align-self: flex-start; margin-top: 2px` pin.

### Validation (running app, Playwright `getBoundingClientRect`) — DONE

Verified live at 1920×1080 on real CI-bearing rows: leading octicon, CI glyph, and metrics
(diff/counts/comments) vertical centers **all identical (ΔY 0)** — CI vs metrics and CI vs leading
both 0. The CI glyph kept its horizontal position (x≈1091, just left of the diff bar at x≈1124). No
two-line-title CI row existed in live data; the row-centering is title-height-independent
(`.midCol align-items: center` centers on `.main`'s full height regardless of title lines).
- Grouped rows (`data-grouped='true'`, left-indented) and the unread accent bar
  (`[data-unread='true']::before`) unaffected — verified.

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
These are **not symmetric**, and that asymmetry forces a **per-theme** token rather than one derived
line. The original "land between `surface-1` and `surface-2` in both themes" idea was verified live
and **rejected for dark**: dark's steps are ~4× more compressed (resting→header ΔL 0.025 vs light's
0.065), so a between-`s1`/`s2` dark hover (L 0.225) sits only ΔL 0.010 off the header — visually it
nearly merges with the band (the exact bug). Worse, in dark the header is *lighter* than the rows, so
"between" can't separate from it. The hover must go the **opposite direction per theme**:

- **Light** — header is darker than rows; hover darkens *between* `s1` and `s2`, staying lighter than
  the header band. Verified: hover L 0.951 vs resting 0.99 (ΔL 0.039) vs header 0.925 (ΔL 0.026).
- **Dark** — header is lighter than rows; hover lightens *past* the header toward `s3`, lifting clearly
  above both. Verified: hover L 0.2595 vs resting 0.21 (ΔL 0.0495) vs header 0.235 (ΔL 0.0245), and it
  lands just under `s3` (0.27, header-hover) so it never equals a resting header.

### Mechanism

`:root` carries the light/default value; `[data-theme="dark"]` overrides it. Both derive from the
active surface scale via lazy `var()`:

```css
/* tokens.css :root — light / default */
--row-hover: color-mix(in oklch, var(--surface-1), var(--surface-2) 60%);

/* tokens.css [data-theme="dark"] — overrides; goes toward surface-3, not between */
--row-hover: color-mix(in oklch, var(--surface-2), var(--surface-3) 70%);
```

```css
/* InboxRow.module.css */
.row:hover { background: var(--row-hover); }   /* was: var(--surface-2) */
```

`.row:hover .comments` stays `--surface-3` and contrasts fine under both hovers — left unchanged.
`.row` keeps relying on the global `:focus-visible` ring for keyboard focus (no per-row background
tint) — intentional: the ring is the focus affordance; adding a focus background is out of scope.

### Validation (running app, both themes) — DONE

Verified live against the real inbox (grouped, row directly under a repo header) at 1920×1080:
three-way separation (row-resting / row-hover / header-resting) holds in **both** light and dark with
the ΔL figures above; the real `.row:hover` rule resolves to the correct per-theme value; the header's
own `:hover` (`surface-3`) stays distinct.

---

## Section-spacing rhythm — toolbar→first gap ≠ section→section gap (folded in, live review)

### Problem (measured live)

The gap above the first section card (toolbar→first) did not match the gaps between section cards.
Measured at 1920×1080 (compact density): toolbar→first = **10px**, section→section = **24px**.

Root cause is a **double-spacing mechanism**: each `InboxSection .section` carried
`margin-bottom: var(--s-4)` (14px) **and** the `.sections` flex container added `gap: var(--s-3)`
(10px), stacking to 24px *between* cards — but the toolbar→first gap is only the grid's
`margin-top: var(--s-3)` (10px), with no margin-bottom stacking on top of it.

### Decision (owner)

Collapse to **one** spacing mechanism and unify the value on a **density-scaling** token (`--s-4`):

- Remove `InboxSection .section { margin-bottom }` — the flex `gap` is the sole owner of inter-card spacing.
- `.sections { gap: var(--s-4) }` and `.grid { margin-top: var(--s-4) }` — same token, so toolbar→first
  and section→section are guaranteed equal and scale together across densities.

Owner chose `--s-4` (density-scaling, 14px compact / 16px comfortable) over `--s-6` (fixed 24px that
would preserve the current looser rhythm but not scale).

### Validation — DONE

Verified live: toolbar→first = section→section = **14px** (compact), driven by a single `--s-4`;
`.section` margin-bottom is `0`; the footer gap follows the same flex gap.

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

### Action — DONE (owner-confirmed)

Verified live at 1920×1080: the grid uses `data-has-rail` and resolves to a single full-width `1fr`
column when the rail is off, so `.sections` spans the full page width and matches the full-width
toolbar. Owner confirmed the issue is resolved. **Close #346** referencing `9ffb7d81`, no CSS change.

---

## Scope / non-goals

- No change to the 3-column row grid, grouped-row indent, or B1-tuned metrics tail (#227).
- No new behavior, no backend, no test-only seams. CSS + one presentational DOM rewrap for #345
  (CI glyph relocated within the row, no markup-visible/aria change); pure CSS for #347/spacing;
  verification-only for #346.
- `--row-hover` is inbox-row-scoped in use (`InboxRow.module.css .row:hover`); the token is added to
  `tokens.css` (`:root` + `[data-theme="dark"]` override) but no other call site is repointed in this slice.
- The spacing fix removes `InboxSection .section { margin-bottom }`; `.section` renders only inside the
  `.sections` flex column, so the flex `gap` fully replaces it (no other consumer relies on that margin).

## Testing

- **Unit (vitest):** these are presentation-only CSS changes with no logic; existing InboxRow /
  RepoGroupAccordion / InboxSection render tests must stay green. No new unit assertions on computed
  pixel offsets (jsdom has no layout) — geometry is verified via Playwright in the running app.
- **Visual (Playwright, B1):** verified live against the real inbox at 1920×1080 (see per-item
  "Validation — DONE"). Regenerate any affected linux parity baselines from the CI artifact if the
  inbox visual baselines shift.

## References

- `frontend/src/components/Inbox/InboxRow.tsx` — CI glyph moved out of `.titleRow` into `.midCol` (#345)
- `frontend/src/components/Inbox/InboxRow.module.css` — `.midCol`/`.main`/`.ciSuffix` row-center (#345), `.row:hover` (#347)
- `frontend/src/components/Inbox/RepoGroupAccordion.module.css` — `.header` resting/hover (#347 context)
- `frontend/src/components/Inbox/InboxSection.module.css` — `.section` margin-bottom removed (spacing)
- `frontend/src/styles/tokens.css` — `--row-hover` (`:root` light + `[data-theme="dark"]` override)
- `frontend/src/pages/InboxPage.module.css` — `.grid` margin-top + `.sections` gap unified on `--s-4` (spacing)
- `frontend/src/pages/InboxPage.tsx` — #346 verification (`data-has-rail`)
- Prior art: #264 (flanking status glyphs), #300 (toolbar↔card edge match), #137 (rail column reserve fix)
