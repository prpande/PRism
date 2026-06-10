# #300 — Inbox cohesion: search-bar card, two-layout toolbar, sort-control restyle

**Issue:** [#300](https://github.com/prpande/PRism/issues/300) · **Tier:** T2 · **Risk:** gated B1 (UI-visual)
**Date:** 2026-06-10 · **Branch:** `feature/300-inbox-cohesion`

## Goal

Make the top of the inbox read as one cohesive, polished unit. Two changes:

1. The search-bar toolbar should read as a **rounded card** consistent with the section/accordion cards below it, and its layout should be coherent whether or not the activity rail is showing.
2. The **sort control** should match PRism's existing control language instead of looking like a generic native web control, and its labels should be self-consistent.

## Scope

**In scope**

- Card-treat the `InboxToolbar` and align it with the section column in both rail states.
- A single `showRail` predicate (toggle **and** viewport width) that drives both the grid columns and whether the rail renders.
- Restyle the Sort `<select>` to the filter-trigger family; drop the loose "Sort:" label; make the four sort labels direction-encoding.

**Out of scope (and why)**

- **PR-row state pills** — the issue's item 3. Already resolved by **#264**, which replaced the naked-text state badge with a leading PR-state octicon and deliberately rejected pill/circle enclosure. There is no `.stateBadge` element left to restyle.
- **Filter facet triggers** (CI / Repo / Author) — already on-brand (`--surface-inset` / `--border-2` / `--radius-2`, accent-active). Left untouched.
- **Sort ascending/descending toggle** — a functional change requiring a persisted `sortDir` (the `inbox.defaultSort` config stores only the key today) plus a new control and tests. Direction is instead encoded in the labels; a true bidirectional sort, if ever wanted, is a separate issue.
- **Manual refresh button** (#311, in flight) — lands in this toolbar but is owned separately. This spec only ensures the toolbar's structure can host it.

## Current state (grounding)

- `InboxPage.tsx`: `<InboxToolbar/>` is a sibling **above** `<div class="grid">`; the grid is `1fr auto` (sections | rail). `showActivityRail = preferences.inbox.showActivityRail ?? false`. The rail renders as `{showActivityRail && <ActivityRail/>}`.
- `InboxPage.module.css`: `.page` is `max-width:1280px` centered with `--s-4` padding; `.grid` collapses to a single `1fr` column at `@media (max-width:1179px)` — but the rail, still rendered, wraps to a full-width row **below** the sections rather than disappearing.
- `InboxToolbar.module.css`: `.toolbar` is `--surface-1` with **only** a `border-bottom` and **no radius** — a squared strip, ~1px wider per side than the bordered section cards.
- `InboxSection.module.css`: `.section` is the reference card — `--surface-1`, full `1px --border-1`, `--radius-3`.
- `FilterBar.tsx` / `filters.module.css`: the Sort control is a native `<select>` preceded by a plain-text "Sort:" label (`.sort select`). The facet triggers (`.trigger`) are already on-brand.
- `applyInboxFilters.ts`: `SORT_OPTIONS` = `updated`→"Updated", `pushed`→"Recently pushed", `diff`→"Diff size", `comments`→"Comments". **All four comparators are fixed descending** (newest / largest / most first). Labels are mutually inconsistent today.
- `hooks/useMediaQuery.ts`: an existing, SSR-safe reactive `matchMedia` hook (legacy-Safari tolerant). Reused here.

## Design

### 1. Toolbar as a card + two layouts

**Card treatment.** `.toolbar` adopts the section-card recipe: `background: var(--surface-1)`, `border: 1px solid var(--border-1)`, `border-radius: var(--radius-3)`. The lone `border-bottom` is removed. This rounds the bar **and** closes the ~1px-per-side width mismatch (it now has the same full border box as the section cards).

**Single source of truth for the rail.** In `InboxPage`:

```ts
const wideEnoughForRail = useMediaQuery('(min-width: 1180px)');
const showRail = (preferences?.inbox.showActivityRail ?? false) && wideEnoughForRail;
```

`showRail` drives **both** the rail render (`{showRail && <ActivityRail/>}`) **and** the cold-load skeleton (`<InboxSkeleton showRail={showRail} />`). Because the rail is gated in JS, below 1180px it is **not mounted** — it genuinely disappears (no wasted data fetch), rather than `display:none`.

**The two layouts** (the toolbar is full content width in both — only the grid below changes):

- **Layout A — rail visible** (`showRail === true`): unchanged structure. Toolbar spans the full content width above a `1fr auto` grid (sections | rail). The toolbar intentionally spans **over both** the repo list and the rail. *(This is the explicit override of the issue's AC #2, which asked to narrow the toolbar to the sections column. Owner-confirmed: spanning both is the desired design when the rail is on.)*
- **Layout B — rail hidden** (`showRail === false`, i.e. toggle off **or** viewport < 1180px): single `1fr` column. Toolbar is a rounded card directly above the section list, edges aligned with it.

The existing `@media (max-width:1179px)` grid rule remains compatible (grid is single-column whenever the rail isn't a child); the breakpoint constant `1180px` is shared between the CSS media query and the `useMediaQuery` call.

### 2. Sort control restyle (Option A) + label fix

**Markup.** Wrap the native `<select>` in a `position:relative` container, mirroring the existing `.search` icon-overlay pattern:

- A leading **sort glyph** (octicon `sort-asc`/three-bars), `position:absolute; left`, `pointer-events:none`.
- A custom **caret** glyph, `position:absolute; right`, `pointer-events:none`.
- The `<select>` itself: `appearance:none`, padded to clear both glyphs, styled to the `.trigger` family — `height:28px`, `--surface-inset`, `1px --border-2`, `--radius-2`, `--text-sm`, accent border on focus.

The native `<select>` is kept (full keyboard + AT semantics; the OS dropdown popup is acceptable). The visible "Sort:" text label is removed; an `aria-label="Sort"` is added to the `<select>` so the control stays labeled for assistive tech.

**Label copy.** `SORT_OPTIONS` labels become direction-encoding so each reads consistently and conveys its (fixed) direction without a toggle:

| key | old label | new label |
|---|---|---|
| `updated` | Updated | **Recently updated** |
| `pushed` | Recently pushed | **Recently pushed** |
| `diff` | Diff size | **Largest diff** |
| `comments` | Comments | **Most comments** |

Comparators are unchanged (all descending). Keys are unchanged, so persisted `inbox.defaultSort` values keep working.

## Components touched

| File | Change |
|---|---|
| `InboxToolbar.module.css` | `.toolbar` → card (surface-1, full border, radius-3); drop `border-bottom`. |
| `InboxPage.tsx` | `showRail` predicate via `useMediaQuery`; gate `<ActivityRail/>` and `<InboxSkeleton showRail>` on it. |
| `InboxPage.module.css` | Confirm grid/breakpoint align with the 1180px constant; no rail-wrap remnants. |
| `FilterBar.tsx` | Wrap Sort `<select>` with glyph + caret overlay; drop "Sort:" text; add `aria-label`. |
| `filters.module.css` | Sort-control styles in the `.trigger` family; caret/glyph positioning. |
| `applyInboxFilters.ts` | Four `SORT_OPTIONS` label strings. |

No backend, API, or config-schema changes.

## Testing

**Unit / component (vitest + RTL)**

- `applyInboxFilters` / `FilterBar`: the four new sort labels render; selecting each still sets the matching `SortKey` (keys unchanged); comparator order unchanged.
- Sort control exposes an accessible name "Sort" (`aria-label`) with the visible text label removed.
- `InboxPage`: with `showActivityRail` true and `matchMedia('(min-width:1180px)')` **true** → `ActivityRail` renders (Layout A); with the media query **false** → `ActivityRail` does **not** render (Layout B), proving the viewport gate. Mock `matchMedia` per the existing `useMediaQuery` test pattern.

**Visual / e2e (Playwright, B1 proof)**

- Before/after screenshots of the inbox top in **light + dark**:
  - Layout A (rail on, wide): rounded toolbar spanning both columns.
  - Layout B (rail off): rounded toolbar aligned with the section list.
  - Narrow viewport with toggle on: rail absent, Layout B.
- Restyled sort control sits in the trigger family; facet triggers visually unchanged.

## Risks & mitigations

- **Visual regression baselines.** Toolbar rounding + sort restyle will shift inbox visual baselines; regenerate the affected Linux baselines from the CI artifact (per the repo's established baseline-regen flow). Header/full-page inbox baselines may ripple.
- **Breakpoint drift.** The `1180px` constant lives in two places (CSS media query + `useMediaQuery` argument). Keep them in sync; a comment in each cites the other. (Single-constant extraction is possible but a JS constant can't feed a CSS `@media`; a shared comment is the pragmatic guard.)
- **Hidden-rail data semantics.** Gating render (not CSS) means narrowing the window unmounts the rail and remounts it on widening — an extra fetch on widen. Acceptable: the rail is decorative/secondary and the fetch is the same one a toggle-on already incurs.
- **AC override is intentional.** Reviewers comparing against the issue's written AC #2 will see a deliberate divergence; it is documented here, in the triage comment, and will be in the PR `## Proof`.

## Acceptance criteria

- [ ] Toolbar reads as a rounded card (`--radius-3`, full border) matching the section cards, in both layouts.
- [ ] Rail visible iff `inbox.showActivityRail` **and** viewport ≥ 1180px; below that (or toggle off) the rail is not rendered and the page is single-column with the toolbar aligned to the list.
- [ ] Rail-on: toolbar spans full width over repo-list + rail (override of issue AC #2, documented).
- [ ] Sort control matches the filter-trigger family; native `<select>` kept; "Sort:" text dropped; `aria-label="Sort"` present.
- [ ] Sort labels: Recently updated / Recently pushed / Largest diff / Most comments; keys and comparator order unchanged.
- [ ] Verified light + dark with before/after screenshots (B1).
