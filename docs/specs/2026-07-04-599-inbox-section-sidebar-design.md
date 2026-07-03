# #599 — Inbox layout: sections as a collapsible left sidebar (master-detail)

**Issue:** [#599](https://github.com/prpande/PRism/issues/599)
**Tier / risk:** T3, gated (**B1 UI-visual** — `design` / `needs-design`). This document is the
design/brainstorm deliverable the issue asks for; it goes through the human design-review gate.
**Branch:** `worktree-inbox-sidebar-599`
**Status:** **Design only.** No implementation lands under this issue (the issue scopes to a
design pass "before any implementation"). Implementation is a separate follow-up — see
[§ Implementation follow-up](#implementation-follow-up-out-of-scope-here).

## Problem

Users with many open PRs scroll the inbox **up and down to move between sections**. Today all
four work sections (`authored-by-me`, `review-requested`, `awaiting-author`, `mentioned`) plus
the `recently-closed` archive stack vertically in one scroll column, all work sections default
open. Reaching the fourth section means scrolling past the first three. The pain is reported by
users on #599 (heavy vertical scrolling across a busy inbox). The working ranking — that
**inter-section navigation by scrolling** is the primary pain, and long **intra-section** scroll
(one section holding many PRs) is secondary — is a design assumption, not a measured one. It
decides which mechanism does the heavy lifting (the sidebar for inter-section, the cap-collapse for
intra-section), so it is stated explicitly rather than left implicit; the mockups (§ Mockups) are
the check on it, and if intra-section volume dominates for a given user, the cap-collapse is what
carries that load.

## Goal / success criteria

1. Moving between sections costs **no scrolling** — it is a direct selection.
2. **Section-level at-a-glance triage survives:** without scrolling, a user can still tell *which*
   section needs attention and *how many* items it holds (per-section counts stay visible). Note the
   narrowing this accepts: today's stack also lets you glance the actual PRs across sections at once;
   that per-PR cross-section glance is deliberately traded away (§ Accepted tradeoffs), with
   whole-inbox filter/search as the "find X anywhere" escape hatch.
3. **Intra-section scroll is bounded on busy _multi-repo_ sections** without hiding the freshest
   work. A section dominated by a single repo is *not* capped (§ Cap-collapse "Applicability",
   § Accepted tradeoffs) — that case is a deferred follow-up, not a promise of this design.
4. **In-session position and state are preserved** across switching sections *and* round-trips
   into a PR-detail view and back (§ State persistence).
5. **No accessibility regression** — keyboard nav, focus management, and screen-reader semantics
   are specified up front (§ Accessibility plan).

## Options considered (and why this one)

The issue lists six candidates. The recommendation is a **refinement of Option 1 (tabs)** rendered
as a *vertical* sidebar, **combined with Option 2 (smarter collapse)** applied at the repo-accordion
level inside the selected section.

| # | Option | Verdict |
|---|--------|---------|
| **1** | **Tabs / segmented control** | **Chosen, as a vertical sidebar.** A horizontal tab strip has the cons the issue named — it hides other sections and loses the cross-section glance. Rendering the "tabs" as a **left sidebar** fixes the worst of both: every section's **count stays visible** in the sidebar, so at-a-glance triage is preserved even though one section's PRs show at a time. This directly kills inter-section scroll (goal 1). |
| **2** | **Smarter collapse** | **Chosen, scoped to repo accordions.** Not applied to the top-level sections (they move to the sidebar), but to the **repo accordions inside** the selected section — a cap-seeded collapse bounds intra-section scroll (goal 3). Builds on the accordions that already exist (`RepoGroupAccordion`). |
| 3 | Sticky section headers | **Complementary, not a substitute.** Pinning headers keeps context while scrolling but still leaves the user scrolling the whole stack — it does not remove inter-section navigation. This is #594's territory (the outer frame). The chosen design's per-section scroll pane *is* the inner scroll region #594 wants; the two should be coordinated, not both built. |
| 4 | Density / compact-row toggle | **Deferred / orthogonal.** Shrinking row height helps a little but a busy inbox is still a long scroll. Layerable on top of any layout later. |
| 5 | Within-section truncation ("show top N") | **Superseded by the cap-collapse**, which bounds scroll while preserving the repo grouping and needing one click to reveal. Row-level truncation remains the fallback for the single-flat-repo case (a follow-up, § Edge cases). |
| 6 | Virtualized list | **Not needed now.** A performance technique, not a layout answer, and it keeps the single-scroll model the user is explicitly moving away from. Can be layered under the main pane later if row counts ever demand it. |

**Why the sidebar over the lighter, self-effacing options.** Two graceful-degradation alternatives
deserve explicit comparison, because they cost far less state machinery: (a) **sticky section
headers + cap-collapse** — once each section is cap-bounded the stack is short, and pinned headers
give quick section jumps while keeping cross-section content visible; and (b) a **section-level
single-open accordion** — opening one section auto-collapses the others to count-bearing headers,
killing inter-section scroll and keeping counts visible without a tablist or a per-section state
model. Both are lighter and both cost ~nothing on a light inbox (they degrade to today's view). The
sidebar is chosen over them deliberately: it gives a **persistent, always-visible section index with
direct selection** — the stated pain is *scrolling up and down to move between sections*, and only a
fixed, always-present list (not a jump-to-anchor, not a stack that re-expands) makes every section
reachable in one click from the same place at any scroll depth. The cost — an always-on column and
the loss of cross-section content glance — is the accepted tradeoff (§ Accepted tradeoffs). This is
a product call, not a forced one; the lighter options remain viable if the always-on cost is judged
too high for the pain.

**One-line rationale:** the sidebar makes sections *navigable* instead of *scrollable*, the sidebar
counts preserve section-level triage, and the in-pane cap-collapse keeps a multi-repo section from
running off-screen.

## The recommended design

### Layout: three regions

```
┌──────────────────────────────────────────────────────────────┐
│  Filter…            [Repo] [Author] [Sort: Updated ▾]         │  ← toolbar (main-pane scoped)
├───────────────┬──────────────────────────────────┬───────────┤
│ SECTIONS      │  Review requested            8    │ ACTIVITY  │
│               │  ─────────────────────────────    │           │
│ ✎ Authored 6  │  ▾ Mindbody.BizApp.Bff   fresh 7  │ alice ✓   │
│ ◉ Review    8 │      · fix(api): pagination…      │ bob 💬    │
│ ⟳ Awaiting  3 │      · feat(auth): rotate PAT…    │ CI ✓      │
│ @ Mentioned 4 │  ▾ PRism                       5  │ carol ⇄   │
│ ───────────   │      · perf: memoize inbox rows   │           │
│ ✓ Closed   12 │  ▸ Mindbody.Clients    older   6  │           │
│         « │   │  ▸ Mindbody.Platform   older   4  │           │
└───────────────┴──────────────────────────────────┴───────────┘
   sidebar            selected section's PRs            existing
 (collapsible)      (repo accordions, cap-collapsed)      rail
```

1. **Left: the Section Sidebar** — the sections, as a vertical list. Collapsible to a slim icon
   rail. New.
2. **Center: the main pane** — the **selected** section's PRs, grouped into today's repo accordions.
3. **Right: the Activity rail** — unchanged (`ActivityRail`); still hidden below
   `INBOX_RAIL_MIN_WIDTH` as today (§ Responsive).

### The Section Sidebar

- One entry per section: **icon + label + count badge**; the active entry is highlighted (accent
  left-border + tinted surface).
- The four work sections in the user's configured order (`sectionOrder` / `orderInboxSections`),
  then a divider, then **`recently-closed`** as an archive entry pinned last (mirrors today's
  pinned-last rule).
- **Collapse control** shrinks the sidebar to an **icon rail**: labels hide, counts ride as small
  badges on the icons, entries stay clickable. A toggle expands it again. (Collapse target =
  icon rail, not fully-hidden — the counts must stay visible for triage.)
- Selecting an entry swaps the main pane to that section. No fetch (data for all sections is
  already in the inbox snapshot), so switching is instant.
- **Discoverability.** This replaces the always-visible scroll stack existing users know, so the
  change ships with a **one-time, dismissible hint** on first view of the new layout — *not*
  silently, because it breaks the "scroll past section N" muscle memory. The exact mechanism (a
  coach-mark on the sidebar vs. a changelog / onboarding note) is a plan-time detail
  (§ Open questions); PRism already has first-run onboarding machinery (`AiOnboardingDialog`) to
  build on.

### The main pane

- Renders **only the selected section's** PRs, grouped into repo accordions exactly as today
  (`groupByRepo` preference; a single-repo section still flattens, as today).
- A section header line shows the section name, its count, and — when the cap bites — a short
  "*N PRs · M shown · K repos collapsed*" note.

### Cap-collapse: bounding intra-section scroll

**Cap = 10 rows.** When a section is shown, its repo accordions are **seeded** open/closed by a
single deterministic rule:

> Walk the repo groups in display order (which follows the **current sort** — the backend emits
> in sort order, and `groupByRepo` preserves first-seen order). Keep a running total of the rows
> in already-opened repos. **Always open the first (top) repo.** For each subsequent repo, open it
> while the running total is `< cap`, otherwise seed it **collapsed**.

Consequences:

- A section whose total is **≤ cap shows every repo open** — identical to today. The rule only
  bites on genuinely busy sections.
- A **single fat repo** (all PRs in one repo) **stays open** — the top repo is always open, and
  there is nothing else to collapse. You scroll it; accepted (§ Accepted tradeoffs, § Edge cases).
- The **top-of-sort repos stay open**, so you land on the work the current sort ranks highest
  (on a cold open, default sort = updated-desc, i.e. the freshest repos).

**What the cap does and does not guarantee.** The initial open set is bounded at roughly the cap
*except* for the first repo, which is always fully open. So the real worst case is
`max(cap, rows-in-top-repo)` — a section that is one 40-PR repo still shows 40 rows. The cap bounds
the *multi-repo* case (many modest repos); it does **not** bound a single dominant repo. That gap is
accepted here and left to a row-level "show top N" follow-up (§ Accepted tradeoffs, § Applicability).

**Seeding vs. manual state.** The rule above computes the *default*, applied **once**, when a
section's accordions first mount in the session (using the sort in effect then). After that, a
user's manual expand/collapse is the only thing that changes an accordion's state, and it
**persists** (§ State persistence). Crucially, there is **no live re-seeding on sort change**:
because each accordion is keyed by its repo id, changing the sort merely **re-orders** the repos on
screen while every repo keeps whatever open/collapsed state it had. A **cold start** re-seeds from
the default sort.

> **Decision — no live re-seed on sort.** An earlier draft re-computed the fill-to-cap defaults on
> every sort change for repos the user hadn't touched. Review (feasibility + adversarial) showed
> that (a) it forces `RepoGroupAccordion` to become a controlled component, contradicting the
> non-goal, and (b) the "does a manually-opened repo count against the cap during re-seed, and what
> wins when the new top repo was manually collapsed" precedence is genuinely undefined. The user's
> requirement was only "the seed *depends on* the sort, and a cold open opens by freshest" —
> satisfied by seeding once at mount — so the live re-seed is dropped. Sort changes reorder; they do
> not collapse what you had open.

**Applicability.** The cap-collapse acts on repo accordions, so it only bounds scroll when a section
is grouped (`groupByRepo` on **and** >1 repo). A flat section (grouping off, or a single repo) has no
accordions to collapse and shows its flat list — bounding *that* case with a row-level "show top N"
is a deferred follow-up, not part of this design.

### State persistence (in-session)

The following survive **switching sections** and **round-trips into a PR-detail view and back**,
so the user never loses their place:

- which **section** is selected;
- the **sidebar** collapsed/expanded state;
- **per-section**, the manual repo **open/collapse** overrides;
- **per-section**, the main pane's **scroll position**.

A **cold start** (full app reload) resets these to defaults: default section selection, seeded
fill-to-cap accordions, top scroll. This matches the agreed "on cold open we open by freshest" —
**no on-disk / config persistence** is in scope; persistence is in-memory for the session only.

An explicit **sort change** is a deliberate reorganize action: it reorders the active section's
repos (each repo keeping its open/collapsed state, per § Cap-collapse) and **resets the active
pane's scroll to top**, so the user lands at the top of the freshly-ordered list rather than at a
now-meaningless pixel offset. Section-switch and PR round-trips, by contrast, restore the saved
scroll.

**Recommended mechanism (for the plan, not binding here):** extend the keep-alive idiom the app
already uses. `InboxHost` keeps the inbox mounted across PR round-trips; the natural fit is to keep
**all section panes mounted** and toggle visibility on switch, so accordion component state and DOM
`scrollTop` persist for free (the same pattern as `PrTabHost` / `useTabScrollMemory`). Dropping the
live sort re-seed (§ Cap-collapse) is what makes this route sufficient: the accordions stay
uncontrolled, so their local open state *is* the persisted state — no lifted store is required. A
lifted `{ selectedSection, perSection: { openOverrides, scrollTop } }` state remains a valid
alternative if the plan prefers it. Perf note: each mounted pane's open rows are cap-bounded **except
a single dominant repo**, so the honest worst case is the sum of each section's top repo across the
four work sections (recently-closed seeds collapsed, keeping its subtree small). That is expected to
be fine for real inbox sizes, but the bound is *not* hard — gate keep-all-mounted on a measured
row-count threshold at plan time, with virtualization (Option 6) as the named fallback above it.

### Filter & search scope

Filter/search keeps **today's whole-inbox scope** — it is not narrowed to the active section:

- Filtering evaluates across **all** sections.
- The **sidebar counts switch to match counts** while a filter is active (e.g. "Review requested · 3").
- **Zero-match sections** are disabled/greyed in the sidebar.
- The **main pane shows the active section's matches**; the cap-collapse still applies to the
  (smaller) matched set.
- **Cross-section matches are always surfaced — not only on an empty active pane.** Whenever a
  filter is active and *other* sections hold matches, the main pane shows a persistent
  "*N more matches in other sections*" affordance (linking to the highest-count other section).
  This is what makes filter a real "find X anywhere" escape hatch: without it, a user sitting on a
  section that happens to have unrelated matches would see a non-empty result and wrongly conclude
  the target does not exist. When the *active* section has zero matches, that same affordance fills
  the pane ("no matches here — N in other sections"), rather than auto-switching the user.
- Clearing the filter restores the full counts.

## Accessibility plan

The sidebar-swaps-the-panel interaction **is** the WAI-ARIA **Tabs** pattern, rendered vertically.
Specify it as tabs rather than inventing a bespoke nav:

- **Sidebar** = `role="tablist"`, `aria-orientation="vertical"`, labelled (e.g.
  `aria-label="Inbox sections"`).
- **Each section entry** = `role="tab"`, `aria-selected` on the active one, `aria-controls`
  pointing at the panel, with an accessible name that **includes the count** (e.g.
  "Review requested, 8 pull requests"). In the collapsed icon rail the label is visually hidden
  but the accessible name (with count) is retained.
- **Main pane** = `role="tabpanel"`, `aria-labelledby` the active tab, `tabindex="0"` so keyboard
  users can move focus into the content.
- **Roving tabindex:** only the active tab is in the tab order (`tabindex="0"`); the rest are
  `tabindex="-1"`. **↑/↓** move between tabs, **Home/End** jump to first/last.
- **Activation model:** because switching is instant (no fetch), **automatic activation**
  (selection follows focus) is acceptable and snappier. Align the exact keyboard/activation model
  with the app's existing tabs (`PrTabStrip`) for consistency — verify at plan time and match it.
- **Collapse toggle:** a `button` with `aria-expanded` reflecting the sidebar state and a clear
  label ("Collapse sections" / "Expand sections"). It sits **outside** the `role="tablist"` element
  (a sibling in the sidebar container), so it is not a `tab` and does not interrupt the roving
  tabindex sequence — the APG tabs pattern expects only `tab` elements as `tablist` children.
- **Touch targets:** in the collapsed icon rail, each section entry (and the collapse toggle) meets
  a minimum **44×44 CSS-px** target (WCAG 2.5.5 / 2.5.8) — the compact rail is otherwise an easy
  target-size failure on touch devices.
- **Empty vs. zero-match tabs (keyboard reachability):** a **genuinely empty** section (0 total
  PRs) stays a normal, activatable `tab` in the roving sequence — activating it shows today's
  empty-copy panel; it is **not** `aria-disabled` (its accessible name announces "0 pull requests",
  which is the signal). A **filter-driven zero-match** section is the transient case: greyed and
  `aria-disabled`, removed from activation until the filter clears. Keeping genuine-empty tabs
  reachable avoids arrow-key skip logic and matches today's "empty sections still render" behavior.
- **Focus management on switch:** focus stays on the tab (tabs pattern); scroll restoration on the
  incoming panel must not steal focus.
- **Live region:** when a filter changes the counts, announce politely — reuse the inbox's
  existing `sr-only` `role="status"` live-region pattern; do not add a competing region.
- **Tokens / contrast / motion:** selection and hover use existing design tokens; verify contrast
  live in **both** themes (oklch surface scales are theme-asymmetric — per-theme hover token), and
  honour `prefers-reduced-motion` for any collapse animation.

## Accepted tradeoffs

- **You can no longer see PRs from two sections at once — only their counts.** This is deliberate
  and is the entire point: it removes the all-sections scroll. At-a-glance **triage** (which
  section needs me, and how many) is preserved by the always-visible sidebar counts; at-a-glance
  **content** across sections is traded away, with whole-inbox filter/search as the escape hatch
  for "find X anywhere."
- **A single fat repo still scrolls.** Accordions are all-or-nothing; the top repo stays open, so a
  section that is one 24-PR repo shows 24 rows. Accepted for the common multi-repo workflow;
  row-level truncation is a follow-up.
- **Three columns at full width.** Sidebar + main + activity rail. Mitigated by the existing rail
  hide below `INBOX_RAIL_MIN_WIDTH` and by collapsing the sidebar to an icon rail (§ Responsive).

## Edge cases

- **Empty section (0 PRs):** shown in the sidebar with count 0 and **remains an activatable tab** —
  clicking it shows today's empty-copy panel (it is *not* `aria-disabled`; see § Accessibility
  plan). Distinct from the transient **filter-driven zero-match** case, which greys/disables the tab
  until the filter clears.
- **Single-repo section / `groupByRepo` off:** flat list, no accordions; cap-collapse cannot act;
  scroll accepted (row-level "show top N" deferred).
- **`recently-closed`:** a sidebar entry below the divider; its repos seed collapsed (as today's
  `defaultOpen=false`), keeping its mounted subtree small even if the archive is large.
- **All sections empty / cold load:** show the existing `EmptyAllSections` state; the sidebar
  reflects zero counts (or is suppressed until data arrives), consistent with today's skeleton.
- **Very large section under keep-all-mounted:** bounded and acceptable; virtualization available
  later if needed.

## Responsive behavior

- **Wide:** sidebar (expanded) + main + activity rail (three columns).
- **Medium:** activity rail hides (existing `INBOX_RAIL_MIN_WIDTH` behavior); sidebar may stay
  expanded or collapse to the icon rail.
- **Narrow / mobile:** sidebar collapses to the icon rail (or a top section-dropdown / slide-over —
  a plan-time detail); single-column main pane.

## What this does NOT change (non-goals)

- No implementation under this issue.
- No change to the **section set** or the backend inbox snapshot model.
- No change to `InboxRow` / `RepoGroupAccordion` internals — the accordion stays **uncontrolled**
  (its local `useState(defaultOpen)`), with `defaultOpen` derived from the cap rule at mount. (This
  holds only because the live sort re-seed was dropped, § Cap-collapse; a re-seed would have forced
  the accordion to become controlled.)
- No **on-disk / config** persistence (in-session only).
- No redesign of the **Activity rail** (retained as-is; #315 is independent).
- No AI-behavior changes. Density toggle, virtualization, and row-level truncation for flat
  sections are explicitly out — candidate follow-ups.

## Relationship to #594 / #315

- **#594 (sticky inbox frame — only PR rows scroll):** complementary and overlapping. This design's
  per-section main pane becomes the inner scroll region #594 wants; the sidebar and toolbar pin as
  the frame. Coordinate so the scroll container is built once, not twice.
- **#315 (activity-rail group/collapse/scroll):** independent (the right rail); unaffected here.

## Implementation follow-up (out of scope here)

File a **T3 implementation issue** (brainstorm-lite → writing-plans → executing-plans) covering:

1. the **vertical tablist** Section Sidebar component (+ collapse-to-icon-rail);
2. wiring the selected section's PRs into a **tabpanel** main pane in `InboxPage`;
3. **cap-collapse seeding** — derive each `RepoGroupAccordion`'s `defaultOpen` from the fill-to-cap
   rule (cap = 10, top-repo-always-open) at mount; key accordions by repo id so a sort change
   reorders without re-seeding (no live re-seed — § Cap-collapse decision note);
4. the **in-session state model** (selected section, sidebar state, per-section repo overrides,
   per-section scroll) via keep-alive-all-mounted or a lifted store;
5. **filter-scope wiring** — per-section match counts in the sidebar, greyed zero-match sections;
6. the **accessibility implementation** (tablist/tab/tabpanel, roving tabindex, live-region counts),
   aligned with `PrTabStrip`.

Pin the **accepted tradeoffs** and **cap = 10** in that plan.

## Open questions to resolve at plan time

- Automatic vs. manual tab activation — match `PrTabStrip`; confirm which it uses.
- Sidebar collapse target per breakpoint (icon rail vs. dropdown / slide-over on narrow).
- Toolbar placement, and that **sort is global** (applies to the active section's ordering; it
  reorders and resets pane scroll, and does **not** re-seed accordion open state).
- Discoverability mechanism for the layout change — coach-mark on the sidebar vs. changelog /
  onboarding note (§ The Section Sidebar).
- Optional: an **attention dot** on sidebar sections with new/unread activity — this is
  *new-activity*, which goal 2's count-based triage does not cover; confirm it against a goal before
  including it, rather than adding it by default.
- Mechanism choice for state persistence (recommend keep-alive-all-mounted — now sufficient, since
  the sort re-seed was dropped).

## Mockups

Three interactive mockups were produced during brainstorming (real PRism tokens, both themes):

1. **Baseline** — today's tall single-column stack (the reference point).
2. **Sidebar-nav** — sections as the collapsible left sidebar, expanded and icon-rail states.
3. **Cap-collapse** — a busy 24-PR section: the freshest repos open, the staler repos collapsed to
   one-click headers (the mockup illustrated the *mechanism* with an example cap; the chosen cap is
   **10**, per this design).

They are the visual basis for this design; the ASCII layout above captures the structure.
