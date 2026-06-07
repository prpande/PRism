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

The fix for goal 2 is to **stop letting the tail be `auto`-width**. Give the tail a fixed width driven by a CSS variable:

```css
.row {
  grid-template-columns: 16px minmax(0, 1fr) var(--inbox-tail-w);
}
```

With a constant tail width, the main↔tail boundary sits at the same x on **every** row. Because rows are `width: 100%`, this alignment holds across separate `<section>` grids and inside `RepoGroupAccordion` with **no subgrid required** — every row independently resolves the same template to the same pixel positions.

Inside the fixed-width tail:

- The **metrics cluster** — diff bar · `+adds −dels` · comment count — is **right-pinned** (flush to the row's right edge) with **fixed sub-widths** and `font-variant-numeric: tabular-nums` (reuse the `.tnum` utility / existing pattern). Because the cluster is right-anchored with fixed widths, the numbers line up column-for-column across all rows regardless of digit count *and regardless of what sits to their left*.
- The **state badge** (Merged/Closed) and **AI category chip** flow in the leading space of the tail, to the *left* of the metrics. Their presence or absence does **not** move the metrics (which are right-pinned), so no per-row badge slot needs reserving for cross-row alignment. If a chip is wide it truncates within the tail rather than pushing the metrics.

### Reserve-and-collapse within the metrics cluster

Two metrics collapse today and would let their neighbours shift if left as-is. Each gets a **fixed-width slot that renders empty when the datum is absent** (mirrors the file-tree `fileTreeAi[data-on='0']` reserve-and-collapse):

- **Diff bar** — `DiffBar` returns `null` when `additions + deletions === 0`. Wrap it in a fixed-width slot so a zero-diff row keeps the +/− and comment columns at the same x. (The `null`-render stays; the *slot* is what's fixed-width.)
- **Comment count** — only rendered when `commentCount > 0`. Give it a fixed-width slot rendered empty at zero, so the diff/counts to its left stay put.
- **+/− counts** always render (even `+0 −0`), so they need only fixed width + tabular-nums, not a presence guard.

`--inbox-tail-w` is a single tunable token. Its value is sized to `max(badge/chip zone) + metrics cluster` and dialed in during the B1 visual pass; the *mechanism*, not the exact pixel count, is what this spec fixes.

## Title + meta bounding

- `.title`: replace `text-wrap: pretty` with a 2-line clamp — `display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-clamp: 2; overflow: hidden;`. Long titles cap at two lines + ellipsis; short titles render one line.
- `.meta`: drop `flex-wrap: wrap`; set `flex-wrap: nowrap; overflow: hidden`. The **author** span (most variable) gets `min-width: 0` + `text-overflow: ellipsis` and truncates first; `repo`, `iter`, `age` are short and effectively fixed. The line never wraps to a second row.

## Field set — conclusion

No field is removed; this change is layout, not amputation. The deliberate pass concludes:

- **Kept (earn their place):** status dot, title, repo (when not repo-grouped), author + avatar, iteration, age, diff bar, +/− counts, comment count, merged/closed badge, AI category chip, unread accent bar.
- **Promoted:** CI `pending` is now visible (amber dot) alongside `failing` (red dot).
- **Deferred (need backend):** review/approval state, draft status → **#259**. Mergeability/conflicts, base branch, labels were judged lower-value / clutter-risk and are not pursued.

### Status dot states

| `ci` (open PRs only) | Dot | Token |
|---|---|---|
| `failing` | red | `--danger-fg` (existing) |
| `pending` | amber | `--warning-fg` (existing) |
| `none` | invisible, slot reserved | — (existing `opacity: 0`) |

Done PRs (merged/closed) are terminal and never show a CI dot (unchanged). The dot's `title`/tooltip names the state ("CI failing" / "CI pending"); the state is also folded into the `aria-label` (see Accessibility).

## Responsive behavior

The inbox pane can be narrowed (split layouts), so the breakpoint is **pane-relative**: a **container query** on the inbox list container (preferred over a viewport media query precisely because the pane width is independent of the viewport). If a container context isn't already established on the list, add one (`container-type: inline-size`) as part of this work.

Below the narrow threshold, drop tail content in **priority order** and shrink `--inbox-tail-w` so the title column reclaims the space:

1. Drop the **diff bar** first (most decorative; numbers still convey magnitude).
2. Then the **AI chip**.
3. **+/− counts** and **comment count** are last and effectively never drop.

The meta line truncates (never wraps) at every width. No horizontal overflow at any width — verified in the B1 pass at a narrow pane.

## Accessibility

- The row stays a single actionable `<button>` with a complete `aria-label`. The label already carries the **untruncated** title, repo, iteration, and unread cue (`InboxRow.tsx:37-41`); extend it to name the CI state when `pending`/`failing` so the dot's meaning reaches AT.
- Add the full title to a **`title` attribute** on `.title` so the 2-line clamp is recoverable on hover. The `aria-label` already exposes the full title to AT, so truncation hides nothing.
- Tabular-nums and fixed slots are presentational only — no AT impact.

## Testing

**Vitest (`InboxRow.test.tsx`, extend):**
- Title clamp class applied; full title present in the `title` attribute and `aria-label` even when visually clamped.
- Meta renders single-line (no wrap container class / `nowrap`); author truncation class applied.
- Status dot: `failing` → danger class; `pending` → warning class; `none`/done → reserved-invisible. `aria-label` names `pending`/`failing`.
- Tail: metrics cluster present and right-pinned; **reserve-and-collapse** — with `additions+deletions === 0` the diff-bar slot is empty but +/− and (reserved) comment slots still render; with `commentCount === 0` the comment slot renders empty and the +/− stay positioned.
- Badge/chip presence does not change which metrics render (alignment invariant at the unit level).

**B1 visual proof (the real assertion):** screenshots against a real account (BFF repo — has long titles and varied diffs), **light + dark**, at a normal and a narrow pane width, showing: bounded row heights, numbers lining up down the column across sections, no horizontal overflow, pending/failing dots. Hosted on a throwaway `review-assets/pr-N` branch and embedded in the PR.

## Rejected alternatives

- **(A) Full table — fixed columns for every field, single-line truncated title.** Rejected: a strict table fights variable-length PR titles (over-truncates or wastes width), is the biggest visual departure, and the card/list row is the standard, defensible pattern for PR inboxes. The "reads like a card stack, not a table" framing in the issue treats a legitimate pattern as a defect.
- **(B2/B3) Fixed-height rows (every row identical height).** Rejected: pixel-uniform rhythm pads out the ~majority of rows whose titles fit one line. *Bounded* rhythm (max-clamp) kills the blowup without the whitespace tax.
- **CSS subgrid for alignment.** Rejected: subgrid only aligns within one subgrid parent — it would not align across the separate `<section>` grids, and the `RepoGroupAccordion` nesting breaks the chain. The fixed-tail-width approach aligns everywhere with less machinery.
- **Drop the diff bar (numbers suffice).** Considered, rejected by the owner — the bar's glanceable magnitude earns its place alongside the precise numbers.
- **Pull review/approval + draft into this slice.** Rejected: requires backend GraphQL/DTO/mapping work (per-viewer approval state widens the surface), which works against the "minimal disruption" intent of the bounded-rhythm choice. Split to #259, which inherits this row's column model and reserve-and-collapse slot pattern.

## Out of scope

- Backend payload changes of any kind (→ #259).
- The inbox de-dup across sections (#225) and repo-grouping toggle (#219) — they change *which/how many* rows render, not the row's internal layout; this work is compatible with both.
- Read-receipt / unread-comment specifics beyond the existing accent bar (#121/#122) — the inbox payload carries no latest-comment id, so comment-unread isn't derivable in the row (existing limitation, unchanged).
