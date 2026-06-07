# Inbox row layout — bounded-rhythm list with aligned metrics

**Issue:** [#227](https://github.com/prpande/PRism/issues/227) — Inbox rows: handle long titles + column-align fields + decide glance-value field set
**Tier / Risk:** T3 / gated B1 (UI-visual; `needs-design`)
**Date:** 2026-06-07
**Depends-on / spawns:** [#259](https://github.com/prpande/PRism/issues/259) (review/approval + draft state — backend payload expansion; deliberately out of scope here)

## Problem

Inbox PR rows have two layout defects and one open question:

1. **Long titles break vertical rhythm.** `.title` (`InboxRow.module.css:66`) has `text-wrap: pretty` and **no clamp**, so a long title wraps to N lines and that row grows taller than its neighbours.
2. **Fields don't column-align across rows.** The row is a per-row grid `16px 1fr auto` (`InboxRow.module.css:4`). The `auto` tail is sized *per row*, so its left edge — and therefore the diff bar, +/− counts, and comment count — starts at a different x on every row. The `meta` line is `flex-wrap: wrap`, compounding the drift and the height variance.
3. **Field set wants a deliberate glance-value pass** — decide what each row surfaces, without clutter.

## Decisions (from brainstorming)

These were settled with the owner before this spec; recorded here so the plan inherits them.

- **Row model: bounded-rhythm list, NOT a full table.** Keep the recognizable title-over-meta row shape. Fix the real bug (height blowups) and cheaply align the right-rail numbers. A strict table was explicitly rejected — see Rejected alternatives.
- **Scope: frontend-only.** Use only fields already in `PrInboxItem`. Review/approval state and draft status (the highest-signal "what needs me" fields) require backend payload work and are split to **#259**.
- **Title clamp: 2-line max, not a fixed height.** Short titles stay one line; long titles cap at two lines + ellipsis. Non-uniform row height between short/long rows is accepted — *bounded* rhythm is the goal, not pixel-uniform rhythm.
- **Meta line: single-line, no-wrap.** Soft fields truncate under width pressure rather than wrapping to a second line.
- **CI signal: surface both `failing` and `pending`.** The status dot gains a second state (amber) in addition to the existing failing (red). `none` stays invisible-but-reserved.
- **Diff bar: keep both the bar and the +/− numbers.** The bar gives glanceable magnitude; the numbers give precision.

## The alignment mechanism (load-bearing)

Cross-row, cross-section, cross-group alignment takes **two** changes together. A fixed tail width alone is *not* sufficient — the repo-group indent defeats it (see change 2).

### (1) Fix the tail width

Stop letting the tail be `auto`-width; drive it from a CSS variable:

```css
.row {
  grid-template-columns: var(--row-indent, 0) 16px minmax(0, 1fr) var(--inbox-tail-w);
}
```

Terminology: the **tail** is the fixed-width right *column*. Inside it, the **metrics cluster** (diff bar · `+adds −dels` · comment count) is right-pinned; the **state badge** (Merged/Closed) and **AI chip** flow to its *left*. The badge/chip's presence does not move the metrics (they're right-pinned), so no per-row badge slot needs reserving for alignment; a wide chip truncates within the tail rather than pushing the metrics.

With a constant tail width, the main↔tail boundary — and the metrics column — sits at the same x on every row **whose right edge is at the same x**. That caveat is change 2.

### (2) Move the repo-group indent off the row box

Today `RepoGroupAccordion.module.css:61-63` indents nested rows with `.body { padding-left: var(--s-4) }`. That shifts the *entire* grouped row — tail included — right by `--s-4`, so its right edge (and metrics column) lands `--s-4` short of a flat row's. A fixed tail width anchors the tail to *each row's own* right edge, not the list's, so this indent breaks cross-group alignment on its own.

Fix: **remove `.body`'s `padding-left` and apply the indent as the leading grid track on the row** — `--row-indent`, set to `var(--s-4)` for grouped rows (via a `data-grouped` attribute / prop) and `0` for flat rows. The row stays `width: 100%` of the *un-indented* `.sections` column, so its right edge — and the right-pinned metrics — stays flush with flat rows. The group still reads as nested because the status dot + title indent under the band; only the leading content moves, the metrics hold their global column.

With both changes, every row (flat or grouped, in any section) resolves to the same right edge inside the same-width `.sections` column, so the metrics align **across rows, across separate `<section>` grids, and across repo groups** — with **no subgrid required**.

### Reserve-and-collapse within the metrics cluster

**Cluster invariant:** the metrics cluster is **fixed-width slots in a fixed order, right-anchored** (an inner `grid` with fixed tracks, or fixed `flex-basis` per slot — *not* `auto`), with `font-variant-numeric: tabular-nums` on the numbers (reuse the `.tnum` utility). Order left→right: diff bar · `+adds −dels` · comment count. Every slot reserves its width whether or not its datum renders. This is what makes the numbers line up column-for-column regardless of digit count.

The two slots that collapse today (mirrors the file-tree `fileTreeAi[data-on='0']` reserve-and-collapse):

- **Comment count** (rightmost) — only rendered when `commentCount > 0`. Because it's the right-anchored element, a zero-comment row would let `+/−` slide to the right edge unless this slot holds its width. **Load-bearing for the counts' position.**
- **Diff bar** (leftmost) — `DiffBar` returns `null` when `additions + deletions === 0`. Its slot reserves width so the **diff-bar column itself** stays aligned across rows; with the cluster right-anchored this does *not* move +/− or comments — the `null`-render stays, the slot is what's fixed-width.
- **+/− counts** always render (even `+0 −0`), so they need fixed width + tabular-nums, no presence guard.

`--inbox-tail-w` is a single tunable token. Start it at **~200px** (≈ a 56px diff bar + two ~3-char tabular counts + a comment pill + gaps ≈ 140px of metrics, plus a ~60px badge/chip zone) and dial it in during the B1 visual pass; the *mechanism*, not the exact pixel count, is what this spec fixes.

## Title + meta bounding

- `.title`: replace `text-wrap: pretty` with a 2-line clamp. The **operative mechanism is the `-webkit-box` trio** — `display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;` — which all current targets honor (the app runs in Chromium/Electron and modern browsers all support `-webkit-line-clamp`). Include the standard `line-clamp: 2` as a forward-compat alias only; it is not yet the load-bearing declaration. Long titles cap at two lines + ellipsis; short titles render one line.
- **Row height contract.** `.row` stays `align-items: center`; the tail vertical-centers against the title block. There is **no fixed row height** — a one-line-title row is ~1 line-height shorter than a two-line-title row, by design (bounded rhythm, not pixel-uniform; see Decisions). Do not reach for a fixed row height.
- `.meta`: drop `flex-wrap: wrap`; set `flex-wrap: nowrap; overflow: hidden`. The **author** span (most variable) gets `min-width: 0` + `text-overflow: ellipsis` and truncates first; `repo`, `iter`, `age` are short and effectively fixed. The line never wraps to a second row.

## Field set — conclusion

No field is removed; this change is layout, not amputation. The deliberate pass concludes:

- **Kept (earn their place):** status dot, title, repo (when not repo-grouped), author + avatar, iteration, age, diff bar, +/− counts, comment count, merged/closed badge, AI category chip, unread accent bar.
- **Promoted:** CI `pending` is now visible (amber dot) alongside `failing` (red dot).
- **Deferred (need backend):** review/approval state, draft status → **#259**. Mergeability/conflicts, base branch, labels were judged lower-value / clutter-risk and are not pursued.

### Status dot states

CI state must read **irrespective of the user-chosen accent** and without relying on hue. Two guarantees:

- **Semantic colour, never accent-derived.** The dot uses fixed semantic tokens (`--danger-fg`, `--warning-fg`) that do **not** reference `--accent`, so changing the accent cannot recolour or wash out the CI signal. The accent only ever paints the unread bar — a separate element in a separate position (the 2px left edge), never the status dot.
- **Shape distinguishes state, not just colour.** `failing` and `pending` differ in **shape**, so they're distinguishable in greyscale / for colour-blind users / against any accent. Colour is the secondary, reinforcing cue.

| `ci` (open PRs only) | Shape | Colour token |
|---|---|---|
| `failing` | **solid** filled dot | `--danger-fg` (existing) |
| `pending` | **hollow ring** dot (transparent fill, ~1.5px border) | `--warning-fg` (existing) |
| `none` | invisible, slot reserved (existing `opacity: 0`) | — |

Done PRs (merged/closed) are terminal and never show a CI dot (unchanged). The dot's `title`/tooltip names the state ("CI failing" / "CI pending"); the state is also folded into the `aria-label` (see Accessibility). The shape + semantic-colour + label combination means CI state is conveyed three ways, none of them dependent on the accent.

## Responsive behavior

The row must respond to **its own width**, not the viewport. The inbox sections-column width is not a simple function of viewport width: `InboxPage.module.css:7-18` lays out `.grid` as `1fr auto` (sections + right rail) collapsing to `1fr` below 1179px — so the sections column is *narrower* when the rail is present (wide viewport) and *wider* when it collapses (narrow viewport). A viewport media query would therefore be a poor proxy for the row's actual width.

So: establish a **container** on the `.sections` column — `container-type: inline-size` (inline-axis containment only; `.sections` is width-driven, not content-height-driven, so this is side-effect-free) — and drive the row with a `@container` query. This is new work (no container context exists today). The narrow threshold is a token, tuned in the B1 pass.

Below the narrow threshold, drop tail content in **priority order** and shrink `--inbox-tail-w` so the title column reclaims the space:

1. Drop the **diff bar** first (most decorative; numbers still convey magnitude).
2. Then the **AI chip**.
3. **+/− counts** and **comment count** are last and effectively never drop.

**Alignment is a within-regime invariant.** At the breakpoint `--inbox-tail-w` changes, so the metrics column x shifts *once* across the breakpoint — by design, not a defect. Within either regime, every row's metrics align. The meta line truncates (never wraps) at every width. No horizontal overflow at any width — verified in the B1 pass at a narrow pane.

## Accessibility

- The row stays a single actionable `<button>` with a complete `aria-label`. The label already carries the **untruncated** title, repo, iteration, and unread cue (`InboxRow.tsx:37-41`) — **no change needed there** (the title-in-label is pre-existing baseline, not work for this slice).
- **CI state in the label (new).** The label has two branches today: done PRs (`title · repo · doneState`) and open PRs (`title · repo · iteration N [· unread]`). Done PRs have no CI dot, so they stay unchanged. For **open PRs only**, append the CI state to the open branch: ` · CI failing` when `ci === 'failing'`, ` · CI pending` when `ci === 'pending'`, nothing when `none`. This carries the dot's meaning to AT.
- Add the full title to a **`title` attribute on the `.title` span** (not the button — the button already has its `aria-label`) so the 2-line clamp is recoverable on hover. The `aria-label` already exposes the full title to AT, so truncation hides nothing.
- Tabular-nums and fixed slots are presentational only — no AT impact.

## Testing

**Vitest (`InboxRow.test.tsx`, extend):**
- Title clamp class applied; full title present in the `title` attribute and `aria-label` even when visually clamped.
- Meta renders single-line (no wrap container class / `nowrap`); author truncation class applied.
- Status dot: `failing` → solid + danger class; `pending` → hollow-ring + warning class (distinct shape class, not only colour); `none`/done → reserved-invisible. Open-PR `aria-label` names `pending`/`failing`; done-PR label unchanged (no CI state). The shape class is what proves state is conveyed without relying on hue.
- Tail reserve-and-collapse — **two distinct cases**:
  - Diff bar absent (`additions + deletions === 0`): diff-bar slot renders empty; `+/−` and comment slots still render and stay positioned.
  - Comment count absent (`commentCount === 0`): comment slot renders empty; `+/−` stay positioned (don't slide to the right edge).
- Badge/chip presence does not change which metrics render (alignment invariant at the unit level).
- Grouped vs. flat row: a `data-grouped` row carries `--row-indent` on its leading track; its tail/metrics slot renders at the same structure as a flat row (the right edge is not indented).

**B1 visual proof (the real assertion):** screenshots against a real account (BFF repo — has long titles and varied diffs), **light + dark**, at a normal and a narrow pane width, showing: bounded row heights, numbers lining up down the column across sections, no horizontal overflow, pending/failing dots. Hosted on a throwaway `review-assets/pr-N` branch and embedded in the PR.

## Rejected alternatives

- **(A) Full table — fixed columns for every field, single-line truncated title.** Rejected: a strict table fights variable-length PR titles (over-truncates or wastes width), is the biggest visual departure, and the card/list row is the standard, defensible pattern for PR inboxes. The "reads like a card stack, not a table" framing in the issue treats a legitimate pattern as a defect.
- **(B2/B3) Fixed-height rows (every row identical height).** Rejected: pixel-uniform rhythm pads out the ~majority of rows whose titles fit one line. *Bounded* rhythm (max-clamp) kills the blowup without the whitespace tax.
- **CSS subgrid for alignment.** Rejected: subgrid only aligns within one subgrid parent — it would *not* align across the separate sibling `<section>` grids (they aren't children of one grid), even after the repo-group indent is moved off the row box. The fixed-tail-width approach (change 1) plus the indent move (change 2) aligns everywhere with less machinery. Note: a fixed tail width *alone* shares subgrid's nesting problem — the `RepoGroupAccordion` `.body` indent — which is exactly why change 2 is required, not optional.
- **Drop the diff bar (numbers suffice).** Considered, rejected by the owner — the bar's glanceable magnitude earns its place alongside the precise numbers.
- **Pull review/approval + draft into this slice.** Rejected: requires backend GraphQL/DTO/mapping work (per-viewer approval state widens the surface), which works against the "minimal disruption" intent of the bounded-rhythm choice. Split to #259, which inherits this row's column model and reserve-and-collapse slot pattern.

## Out of scope

- Backend payload changes of any kind (→ #259).
- The inbox de-dup across sections (#225) and repo-grouping toggle (#219) — they change *which/how many* rows render, not the row's internal layout; this work is compatible with both.
- Read-receipt / unread-comment specifics beyond the existing accent bar (#121/#122) — the inbox payload carries no latest-comment id, so comment-unread isn't derivable in the row (existing limitation, unchanged).
