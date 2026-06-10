# #300 — Inbox cohesion: search-bar card, two-layout toolbar, sort-control restyle

**Issue:** [#300](https://github.com/prpande/PRism/issues/300) · **Tier:** T2 · **Risk:** gated B1 (UI-visual)
**Date:** 2026-06-10 · **Branch:** `feature/300-inbox-cohesion`
**Owner sign-offs on record:** the two-layout model, the AC #2 override, the rail-hide-at-narrow-width behavior, and the direction-encoded sort labels were all confirmed by the owner during brainstorming and recorded in the [triage comment](https://github.com/prpande/PRism/issues/300#issuecomment-4665846771).

## Goal

Make the top of the inbox read as one cohesive, polished unit. Two changes:

1. The search-bar toolbar should read as a **rounded card** consistent with the section/accordion cards below it, and its layout should be coherent whether or not the activity rail is showing.
2. The **sort control** should match PRism's existing control language instead of looking like a generic native web control, and its labels should be self-consistent.

## Scope

**In scope**

- Card-treat the `InboxToolbar` and align it with the section column in both rail states.
- A single `showRail` predicate (toggle **and** viewport width) that drives both the grid columns and whether the rail renders. **This includes an intentional behavior change** — see "Rail-hide is an explicit, owner-approved behavior change" below.
- Restyle the Sort `<select>` to the filter-trigger family; drop the "Sort:" label; make the four sort labels direction-encoding.

**Out of scope (and why)**

- **PR-row state pills** — the issue's item 3. Already resolved by **#264**, which **removed the naked-text "Merged"/"Closed" state badge entirely** (not merely restyled it) and replaced it with a leading PR-state octicon, deliberately rejecting pill/circle enclosure. Verified: `grep` for `stateBadge` in `InboxRow.tsx` / `InboxRow.module.css` returns zero matches — there is no element left to pill-ify.
- **Filter facet triggers** (CI / Repo / Author) — already on-brand (`--surface-inset` / `--border-2` / `--radius-2`, accent-active). Left untouched.
- **Sort ascending/descending toggle** — a functional change requiring a persisted `sortDir` (the `inbox.defaultSort` config stores only the key today) plus a new control and tests. Direction is instead encoded in the labels; a true bidirectional sort, if ever wanted, is a separate issue. *(One-way-door note: if that toggle is later built, the four direction-encoded labels would need neutralizing back to plain nouns — a 4-string revert, accepted as cheap.)*
- **Manual refresh button** (#311, in flight) — lands in this toolbar but is owned separately. This spec only ensures the toolbar's structure can host it.

### Rail-hide is an explicit, owner-approved behavior change

Today (`InboxPage.module.css:14-18`) narrow viewports collapse the grid to one column and the rail **wraps to a full-width row below the sections** — it stays reachable. This spec instead **hides the rail (does not mount it) below 1180px**. The owner chose hide-over-wrap during brainstorming (recorded in the triage comment). This is named here as a deliberate scope addition, not smuggled in as a side effect, because it has a user-observable consequence (rail content is absent, not relocated, at narrow widths). Reachability impact is bounded: the web app and the desktop Electron shell both present the rail at normal widths (Electron's window defaults to **1280×860**, `desktop/src/main.ts:147` — ≥1180, so the rail shows by default); it only disappears when the user deliberately narrows below 1180, and the `inbox.showActivityRail` preference is preserved so widening restores it. (Cross-ref #284, which proposes a desktop minimum window size.)

## Current state (grounding)

- `InboxPage.tsx`: `const showActivityRail = preferences?.inbox.showActivityRail ?? false;` (line 29). `<InboxToolbar/>` is a sibling **above** `<div class="grid">`; the grid is `1fr auto` (sections | rail). The rail renders as `{showActivityRail && <ActivityRail/>}` (line 119). The cold-load early-return (lines 50-58, `isLoading && !data`) renders `<InboxSkeleton showRail={showActivityRail} />` (line 56) — a **separate branch** that also needs the viewport gate.
- `InboxPage.module.css`: `.page` is `max-width:1280px` centered with `--s-4` padding; `.grid` collapses to a single `1fr` column at `@media (max-width:1179px)` — but the rail, still rendered, wraps to a full-width row **below** the sections rather than disappearing.
- `InboxToolbar.module.css`: `.toolbar` is `--surface-1` with **only** a `border-bottom` and **no radius** — a squared strip, ~1px wider per side than the bordered section cards.
- `InboxSection.module.css`: `.section` is the reference card — `--surface-1`, full `1px --border-1`, `--radius-3`, **no `box-shadow`**.
- `InboxSkeleton.tsx`: already accepts `{ showRail }: { showRail: boolean }` (line 30) and is already passed it from `InboxPage.tsx:56`. Its toolbar placeholder is a bare `<Skeleton width="100%" height={36} radius={8} />` (line 34) with no border.
- `FilterBar.tsx` / `filters.module.css`: the Sort control is a native `<select>` preceded by a plain-text "Sort:" label (`.sort select`, `filters.module.css:258-271` — `border-color: var(--accent)` on `:focus`). The facet triggers (`.trigger`) are already on-brand.
- `applyInboxFilters.ts`: `SORT_OPTIONS` = `updated`→"Updated", `pushed`→"Recently pushed", `diff`→"Diff size", `comments`→"Comments". **All four comparators are fixed descending** (newest / largest / most first). Labels are mutually inconsistent today.
- `hooks/useMediaQuery.ts`: an existing, SSR-safe reactive `matchMedia` hook (legacy-Safari tolerant). Reused here.
- `ActivityRail` / `useActivity.ts`: the rail fetches `/api/activity` on mount (`useEffect([])`) and polls every 90s; it holds a transient `showBots` toggle (`ActivityRail.tsx`).
- **Existing tests that assume an always-rendered rail:** `frontend/__tests__/InboxPage.test.tsx` asserts the rail renders when `showActivityRail:true` at two sites (the `renders ActivityRail when inbox.showActivityRail is on` and `shows the activity rail when…is true` tests). The global setup mocks `matchMedia` to `matches:false` (`frontend/__tests__/setup.ts`), so under the new gate these tests will fail unless they override `matchMedia` to `matches:true`. The per-test override pattern to copy lives in `frontend/__tests__/DiscardAllDraftsButton.test.tsx` (a `beforeEach`/`afterEach` `window.matchMedia` swap). There is **no** `useMediaQuery.test.tsx`.

## Design

### 1. Toolbar as a card + two layouts

**Card treatment.** `.toolbar` adopts the section-card recipe exactly: `background: var(--surface-1)`, `border: 1px solid var(--border-1)`, `border-radius: var(--radius-3)`, **no `box-shadow`** (matching `.section`, which carries none). The lone `border-bottom` is removed. This rounds the bar **and** closes the ~1px-per-side width mismatch (it now has the same full border box as the section cards). *(Note: in dark mode `--surface-1` (0.21 L) sits on `--surface-0` (0.18 L) with low contrast and no shadow — this is intentional and identical to how the existing section cards read.)*

**Single source of truth for the rail.** In `InboxPage`, narrow the existing `showActivityRail` flag with a viewport predicate built on a shared constant:

```ts
// new shared module, e.g. frontend/src/components/Inbox/inboxLayout.ts
export const INBOX_RAIL_MIN_WIDTH = 1180; // keep in sync with InboxPage.module.css @media

// InboxPage.tsx
const wideEnoughForRail = useMediaQuery(`(min-width: ${INBOX_RAIL_MIN_WIDTH}px)`);
const showRail = (preferences?.inbox.showActivityRail ?? false) && wideEnoughForRail;
```

`showRail` drives **both** the rail render (`{showRail && <ActivityRail/>}`, line 119) **and** the cold-load skeleton — change line 56 from `<InboxSkeleton showRail={showActivityRail} />` to `<InboxSkeleton showRail={showRail} />` so the skeleton's rail column is viewport-gated too. Because the rail is gated in JS, below 1180px it is **not mounted** — it genuinely disappears (no background fetch/poll), rather than `display:none`.

*Accepted tradeoff (mount-vs-display):* JS-gating means crossing 1180px unmounts/remounts `ActivityRail`, so widening past the boundary re-fires the `/api/activity` fetch and resets the rail's transient `showBots` toggle. This is bounded — `matchMedia` fires one `change` event per boundary crossing (not per resize pixel), and the fetch is the same one a toggle-on already incurs. We accept this over `display:none` (which would keep the hidden rail polling every 90s for data the user can't see).

**The two layouts** (the toolbar is full content width in both — only the grid below changes):

- **Layout A — rail visible** (`showRail === true`): unchanged structure. Toolbar spans the full content width above a `1fr auto` grid (sections | rail). The toolbar intentionally caps **both** the repo list and the rail.
  - *Rationale (the load-bearing design claim):* the toolbar is **page-level chrome** for the whole inbox surface — paste-to-open, search, and the filter/sort controls frame the entire view, not just the results column — so it spans the full content width like a header band, with the section cards and the rail nested beneath it. This is the owner-approved alternative to the issue's "narrow to the sections column" direction (the **explicit override of issue AC #2**); the owner confirmed during brainstorming that spanning both is the desired design when the rail is on (recorded in the triage comment).
- **Layout B — rail hidden** (`showRail === false`, i.e. toggle off **or** viewport < 1180px): single `1fr` column. Toolbar is a rounded card directly above the section list, edges aligned with it.

The existing `@media (max-width:1179px)` grid rule remains compatible (the grid is single-column whenever the rail isn't a child). The `1180`/`1179` boundary lives in two places (the `INBOX_RAIL_MIN_WIDTH` const consumed by JS, and the CSS `@media`); a comment in each cites the other, and a unit test pins `INBOX_RAIL_MIN_WIDTH === 1180` so a future tweak forces a conscious update of both.

*Focus on unmount:* if `<ActivityRail>` holds keyboard focus and the viewport crosses below 1180px, the unmount drops focus to `<body>`. No focus-recovery is specified — acceptable because a viewport resize is an environmental event, not a user action on the rail (unlike a deliberate toggle-off click).

### 2. Sort control restyle (Option A) + label fix

**Markup.** Wrap the native `<select>` in a `position:relative` container, mirroring the existing `.search` icon-overlay pattern:

- A leading **sort glyph** — the three-decreasing-bars "sort" mark shown in the approved mockup (a neutral "this list is sorted" affordance, **not** Octicon `sort-asc`/`sort-desc`, which imply a clickable direction-flip the control does not have). `position:absolute; left`, `pointer-events:none`.
- A custom **caret** (chevron-down), `position:absolute; right`, `pointer-events:none`.
- The `<select>` itself: `appearance:none`, padded to clear both glyphs, styled to the `.trigger` family — `height:28px`, `--surface-inset`, `1px --border-2`, `--radius-2`, `--text-sm`.

**Focus treatment (explicit).** The `<select>` keeps its own focus indicator — `border-color: var(--accent)` on `:focus-visible` (the same pattern as today's `.sort select:focus` and `.searchInput:focus`) — plus `outline: none` to suppress the UA ring that some engines leave when `appearance:none` is set. The wrapping container does **not** get a `focus-within` ring; the focus indicator lives on the `<select>` so there's exactly one ring.

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
| `InboxToolbar.module.css` | `.toolbar` → card (surface-1, full border, radius-3, no shadow); drop `border-bottom`. |
| `components/Inbox/inboxLayout.ts` (new) | Export `INBOX_RAIL_MIN_WIDTH = 1180`. |
| `InboxPage.tsx` | `showRail = showActivityRail && useMediaQuery((min-width: ${INBOX_RAIL_MIN_WIDTH}px))`; gate `<ActivityRail/>` (line 119) **and** change the skeleton call (line 56) from `showRail={showActivityRail}` to `showRail={showRail}`. |
| `InboxPage.module.css` | Confirm grid/breakpoint align with the const; comment cross-refs the JS const. |
| `InboxSkeleton.tsx` | Toolbar placeholder bar gains `border: 1px solid var(--border-1)` so the load→content transition is seamless (it already gates its rail column on `showRail`). |
| `FilterBar.tsx` | Wrap Sort `<select>` with glyph + caret overlay; drop "Sort:" text; add `aria-label="Sort"`. |
| `filters.module.css` | Sort-control styles in the `.trigger` family; caret/glyph positioning; `:focus-visible` border + `outline:none`. |
| `applyInboxFilters.ts` | Four `SORT_OPTIONS` label strings. |

No backend, API, or config-schema changes.

## Testing

**Unit / component (vitest + RTL)**

- `applyInboxFilters` / `FilterBar`: the four new sort labels render; selecting each still sets the matching `SortKey` (keys unchanged); comparator order unchanged.
- Sort control exposes an accessible name "Sort" (`aria-label`) with the visible text label removed; `getByRole('combobox')` still resolves it.
- **Viewport gate** in `frontend/__tests__/InboxPage.test.tsx`:
  - The two existing rail-render tests must override `window.matchMedia` to `matches:true` (copy the `beforeEach`/`afterEach` swap from `__tests__/DiscardAllDraftsButton.test.tsx`) so they exercise Layout A and keep passing.
  - Add the symmetric proof: with `showActivityRail:true` and `matchMedia` `matches:false`, `ActivityRail` is **absent** (Layout B / viewport gate).
- Pin the breakpoint: a unit test asserts `INBOX_RAIL_MIN_WIDTH === 1180`.

**Visual / e2e (Playwright, B1 proof)**

- Before/after screenshots of the inbox top in **light + dark**:
  - Layout A (rail on, wide): rounded toolbar capping both columns.
  - Layout B (rail off): rounded toolbar aligned with the section list.
  - Narrow viewport with toggle on: rail absent, Layout B.
- Restyled sort control sits in the trigger family; facet triggers visually unchanged. The existing parity-baseline rail spec already runs at a 1440px viewport (≥1180), so Layout A is what it captures.

## Risks & mitigations

- **Visual regression baselines.** Toolbar rounding + sort restyle will shift inbox visual baselines; regenerate the affected Linux baselines from the CI artifact (per the repo's established baseline-regen flow). Header/full-page inbox baselines may ripple.
- **Existing test breakage (highest-likelihood trip).** The two `__tests__/InboxPage.test.tsx` rail-render tests fail under the gate unless given the `matches:true` override — named explicitly in Testing above.
- **Breakpoint drift.** The `1180` boundary is the `INBOX_RAIL_MIN_WIDTH` const (JS) + the CSS `@media`; a cross-ref comment in each plus the value-pinning unit test convert the old "comment-only" guard into an enforced one, preventing a dead band (e.g. CSS at 1200 / JS at 1180 → grid single-column but rail still mounted, reintroducing the orphaned-rail layout this fixes).
- **Rail mount/remount on resize.** Accepted tradeoff documented in §1: re-fetch + `showBots` reset on boundary crossing, bounded to deliberate crossings.
- **AC override is intentional.** Reviewers comparing against the issue's written AC #2 will see a deliberate divergence; it is documented here (with rationale), in the triage comment, and will be in the PR `## Proof`.

## Acceptance criteria

- [ ] Toolbar reads as a rounded card (`--radius-3`, full border, no shadow) matching the section cards, in both layouts.
- [ ] Rail visible iff `inbox.showActivityRail` **and** viewport ≥ 1180px; below that (or toggle off) the rail is not rendered and the page is single-column with the toolbar aligned to the list.
- [ ] Rail-on: toolbar spans full width capping repo-list + rail (override of issue AC #2, documented with rationale).
- [ ] Sort control matches the filter-trigger family (28px, `--surface-inset`, `--border-2`, `--radius-2`, accent `:focus-visible` border, `outline:none`), with the named non-directional sort glyph + caret; native `<select>` kept; "Sort:" text dropped; `aria-label="Sort"` present.
- [ ] Sort labels: Recently updated / Recently pushed / Largest diff / Most comments; keys and comparator order unchanged.
- [ ] Cold-load skeleton matches the new layout: toolbar bar carries the card border; its rail column is gated on `showRail`.
- [ ] Verified light + dark with before/after screenshots (B1).
