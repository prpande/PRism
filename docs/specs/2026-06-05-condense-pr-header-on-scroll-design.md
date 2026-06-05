---
title: Collapsible PR-detail header + toolbar density trim (#128)
status: draft
type: feat
issue: 128
tier: T2
risk: B1 (UI-visual)
date: 2026-06-05
---

# Collapsible PR-detail header + toolbar density trim (#128)

## Problem

In PR detail → Files, the chrome stack above the diff consumes ~half the
viewport before a single line of code is visible. Measured live on
`mindbody/Mindbody.BizApp.Bff#191` at a 773px viewport: App Header (52) +
PrTabStrip (45) + **PrHeader meta (102)** + Overview/Files/Drafts sub-tabs (41)
+ **Files toolbar (77)** + file-path header — leaving the diff body only **384px**.

Two reclaimable targets, each with a different right treatment:

- The **PrHeader meta** (repo·#, merge status, author, branch, CI/mergeability
  chips) is read-once orientation info. It does not earn ~100px while the
  reviewer reads diffs — but the reviewer may still want it on demand.
- The **Files toolbar** is over-padded: its 77px is ~56px of nested vertical
  padding (toolbar 12+12, iteration strip 8+8, each iteration chip 8+8) wrapping
  ~17px of actual content. That is wasted vertical space regardless of what the
  controls look like.

Reported from a UI review session 2026-06-03.

## What the issue asked for vs. what already shipped

The issue lists four acceptance criteria. Live verification (Playwright against
`#191`, viewport 773px) shows **three of the four are already delivered** by the
viewport-bound Files layout (#191/#149/#155/#156):

| Original criterion | Status | Evidence |
|---|---|---|
| File tree stays put while diff scrolls | ✅ shipped | Tree and diff are independent scrollers at a shared fixed `top`; `.diff-pane-body` is the diff's own `overflow:auto` scroller. |
| Vertical scroll confined to diff container (no full-page scroll) | ✅ shipped (with a documented escape hatch) | `document` is not page-scrollable and `[data-app-scroll][data-files-active]` does not overflow at normal viewports. It is `overflow-y:auto` (not `hidden`) **by design** — the #155 escape hatch lets the page scroll only when the rigid header stack exceeds the viewport. So "diff is the sole scroller" holds at normal sizes, not unconditionally. |
| Works in both desktop shell and browser | ✅ shipped | The `data-files-active` rules in `tokens.css` are **not** gated on `[data-shell="desktop"]`. |
| **Top bar collapses on scroll-down, restores on scroll-up** | ↺ reframed | See "Reframe of criterion 4" below. |

So this slice's net-new work is criterion 4 (reframed) plus a toolbar density
trim; criteria 1–3 get a **regression test** so the already-shipped behavior
cannot silently regress.

### Reframe of criterion 4 (must be recorded on the issue when closing)

The issue's criterion 4 ("collapses on scroll-**down** and restores on
scroll-**up**") is reframed three ways, all approved by the issue owner during
this design:

1. **collapse → collapse-to-compact** (not a total hide; keeps title + CI chip +
   actions).
2. **scroll-triggered → manually triggered** by a chevron button. Scroll-driven
   condense was prototyped and rejected: in this viewport-bound layout the diff
   scrolls *inside* `.diff-pane-body` (not the page), so a scroll trigger would
   require listening to that inner scroller and would introduce a content-jump
   under the reader's eye, max-scroll-clamp oscillation on short diffs, and a
   keep-alive scroll-restore/condense desync — all of which a user-initiated
   button eliminates (the reflow becomes expected feedback, not a surprise).
3. **"top bar(s)" (the whole stack) → PrHeader meta only**, plus a density trim
   of the toolbar. App Header + PrTabStrip stay (global chrome); the toolbar's
   *control form* is #185's job (see boundary).

Because the issue owner is also the reporter, this is a paper-trail concern, not
a stakeholder one — but the disposition (criterion 4 reframed, with this
rationale) **will be posted as a comment on #128 before it is closed** so the
issue history doesn't show four checked boxes under a silent redefinition.

## Decision A — Manual collapse toggle for the PrHeader meta

A small chevron button collapses/expands the PrHeader meta block on demand, like
an IDE panel-collapse control.

- **Affordance & placement.** A chevron button at the **right end of the
  Overview/Files/Drafts sub-tab row** (the `PrSubTabStrip` `role="tablist"`).
  That row is the stable anchor present in *both* states. The glyph is a **clean
  SVG double-chevron icon** (`»` rotated to point down when expanded / up when
  collapsed; themeable via `currentColor`, rotating 180° between states) — **not**
  a Unicode caret (a bare `⌃`/`⌄` was rejected as looking cheap). It is a real
  `<button>` with `aria-expanded`, `aria-controls` pointing at the collapsible
  meta region's id, and a label that flips between "Collapse PR details" /
  "Expand PR details".
- **Collapsed state** = the compact row already approved in the mock: the title
  (ellipsized, ~1rem) + the CI/mergeability chip + the action cluster
  (Submit/AskAi/Verdict) on one row; the sub-tab row + chevron below. Hidden:
  `repo · #`, the `Merged/Closed …` status line, author, branch.
  - **Keep the CI/mergeability chip** (revised from an earlier draft that dropped
    it): "is the build green / mergeable" is a *frequent glance*, not read-once
    orientation. It is the one piece of meta worth keeping pinned, and it sits
    inline next to the title in the compact row.
- **Expanded state** = today's full PrHeader, unchanged.
- **Default = expanded.** First open of any PR shows the full header.
- **State = per-PR, session-only, in-memory.** A module-level
  `Map<prRefKey, boolean>` (mirroring `useTabScrollMemory`'s store) holds each
  PR's collapsed flag. It is **not** persisted: closing/reopening the app resets
  every PR to expanded. Per-PR (not per-sub-tab): the flag applies to the shared
  PrHeader across all of a PR's sub-tabs.
- **Scope = all sub-tabs.** The chevron is present and functional on
  Overview/Files/Drafts. The diff-room payoff is largest on Files (viewport-bound
  layout), but collapsing on Overview/Drafts simply gives their normally-scrolling
  content more room — harmless and consistent.

### A.1 Wiring (plain React state — the scroll-driven complexity is gone)

Because the trigger is a click, not scroll, this is ordinary controlled state —
no scroll listener, no hysteresis, no imperative attribute, none of the
scroll-design hazards:

- `PrDetailView` owns `const [collapsed, setCollapsed] = useState(() => store.get(refKey) ?? false)`,
  seeded from the module store and re-seeded when `refKey` changes (keep-alive:
  switching the active PR must read that PR's flag). The toggle handler flips
  state **and** writes the store so the choice survives a tab switch within the
  session.
- `collapsed` is passed to `PrHeader`, which renders `data-collapsed` as a normal
  JSX attribute on its root (`<div className={styles.prHeader} data-collapsed={collapsed || undefined} …>`).
  CSS condense rules are scoped `.prHeader[data-collapsed] …`. No imperative
  `toggleAttribute`, no "React preserves attributes it didn't set" dependency.
- The collapse is a pure CSS state change. Because the Files view is already
  viewport-bound flex (`.pr-detail-page` column; the files slot is `flex:1 1 0`),
  shrinking PrHeader's height hands the reclaimed pixels straight to the diff —
  no overlay, no scroll math. On a click this reflow is expected user feedback.

### A.2 Visual mechanics + motion

- `data-collapsed` rules target `.prTitle`, `.prSubtitle`,
  `.statusMerged`/`.statusClosed` (module classes on the same root) and
  `:global(.pr-meta-repo)` (global class). The CI/mergeability chip is pulled out
  of the hidden subtitle line into the compact title row so it survives collapse.
- **The condensed title is the same `<h1 data-testid="pr-title">` node**,
  restyled smaller and ellipsized — *not* a second element. This preserves the
  heading landmark in the accessibility tree (a `display:none` on the full title
  + a separate `<span>` would drop the `h1`).
- **Overflow safety:** in the compact row the title is `flex:1; min-width:0`
  (ellipsizes) and the action cluster is `flex-shrink:0`. This prevents a wide
  open-PR action cluster (VerdictPicker "Request changes" ~100px +
  SubmitInProgressBadge + pending-review pill + Submit + AskAi ≈ 500–600px) from
  overflowing the row near the 900px breakpoint.
- **Motion:** content hides immediately; the header height eases over **≤150ms**,
  **suppressed under `@media (prefers-reduced-motion: reduce)`**.

## Decision B — Files toolbar density trim

Reduce the toolbar's wasted vertical space by trimming the three nested vertical
paddings. **This is always-on and the new default toolbar size for every user —
independent of the chevron (Decision A).** The chevron collapses only the
PrHeader meta; the toolbar is permanently shorter regardless of chevron state.
**CSS-only; no control is moved, relabeled, or converted to an icon.**

| Element | Vertical padding now | Trimmed to | Note |
|---|---|---|---|
| `.filesTabToolbar` | `12px` (`--s-3`) | `8px` (`--s-2`) | top + bottom |
| `.iterationTabStrip` | `8px` | `2px` | top + bottom |
| iteration chip | `8px` | `5px` | top + bottom |

Measured effect: toolbar **77px → ~51px (+~26px to the diff)**. Horizontal
padding, gaps, fonts, and the control set are untouched. The trim is always-on
(not tied to the chevron), and composes with the existing
`[data-density="compact"]` mode rather than fighting it. Exact px values are a
plan detail; the target is "~50px toolbar, no cramping."

## Scope boundary with #185

#185 ("convert the diff-toolbar text toggles to compact **icon** controls") and
this slice's Decision B are **orthogonal**: #185 changes the *form* of the toggle
controls (text → icons, a horizontal-space win); Decision B trims *vertical
padding* (a height win). Neither blocks the other and they compose. This slice
must **not** convert toggles to icons, relabel them, or restructure the toolbar
controls — that is #185. After this slice the toolbar is shorter but the controls
are unchanged; #185 later makes them narrower.

## Out of scope / disposition

- **Toolbar control-form / icon conversion** — #185.
- **App Header + PrTabStrip collapsing** — global chrome; out of scope. (A future
  unified "focus/reading mode" could let one control collapse meta + toolbar +
  global chrome together; the chevron here is a deliberate first increment toward
  that, not the whole thing.)
- **Small-viewport escape-hatch rework** — the `[data-app-scroll]` `overflow-y:auto`
  escape hatch (#155) stays. Collapsing the header *reduces* how often it engages
  but reworking it is not in scope.
- **Persisting the collapsed choice across app restarts** — deliberately
  session-only per the owner's decision; no prefs plumbing.
- **Closed/merged orientation in collapsed state** — the `Merged/Closed …` status
  line is hidden when collapsed (along with the rest of the meta). This is
  deliberate: the user explicitly chose collapse, and expanding restores it. The
  CI/mergeability chip (kept) still conveys state.

## Acceptance criteria

- [ ] A chevron toggle on the sub-tab row collapses the PrHeader meta to the
      compact row (title + CI/mergeability chip + actions) and expands it back.
- [ ] The toggle is a real button with `aria-expanded` reflecting state,
      `aria-controls` on the meta region, and a state-appropriate accessible label;
      reachable and operable by keyboard.
- [ ] Collapsed state hides repo·#, status line, author, branch; keeps the
      title (ellipsized, same `<h1>` node), CI/mergeability chip, and actions.
- [ ] State is per-PR and survives switching to another tab and back **within a
      session**; reopening the app resets to expanded.
- [ ] The chevron is present and functional on all three sub-tabs; default is
      expanded.
- [ ] Collapsing hands the reclaimed height to the diff (diff body taller when
      collapsed) — verified, no overlay.
- [ ] The action cluster never overflows the compact row at ≥900px (title
      ellipsizes, actions don't shrink).
- [ ] The Files toolbar vertical padding is trimmed (~77px → ~50px) with no
      change to the toggle controls or iteration tabs themselves.
- [ ] Under `prefers-reduced-motion: reduce`, the collapse transition is suppressed.
- [ ] **Regression (issue criteria 1–3):** in Files view the document is not
      page-scrollable, `[data-app-scroll]` does **not overflow at the test
      viewport**, the diff body is the diff's own scroller, and the file tree is
      an independent `overflow-y:auto` scroller.

## Test plan

- **Regression e2e (criteria 1–3, Playwright — jsdom has no layout):** extend the
  existing `frontend/e2e/diff-scroll-regression.spec.ts` (which already asserts
  `document`/`[data-app-scroll]` non-overflow and the diff-as-scroller). The only
  genuinely-new assertion is **file tree is a separate `overflow-y:auto`
  container**. Assert "does not overflow at this viewport," **not** "is not a
  scroll container" (the element is `overflow-y:auto` by design).
- **Collapse behavior e2e (Playwright):** click the chevron → assert
  `data-collapsed` on `[data-testid="pr-header"]`, the meta lines hidden, the CI
  chip + title still present, and the diff body `clientHeight` increased (use
  `waitForFunction` on the height to avoid transition-timing flake). Click again →
  reverts. Switch sub-tab → state persists; switch PR tab and back → per-PR state
  restored.
- **Toolbar trim:** assert the toolbar height dropped vs the pre-trim baseline and
  the three toggle buttons + iteration tabs are still present and clickable.
- **Visual (the B1 gate):** live before/after screenshots of the real running app
  — expanded, collapsed, and toolbar-trimmed — in light and dark. Human-gated proof.
- **a11y (Playwright `a11y-audit`):** no new serious/critical vs `main`; confirm
  the `h1` heading landmark persists in the collapsed state and the toggle button
  exposes `aria-expanded`.
- **Re-baseline:** any committed parity/screenshot baseline scoped to the PrHeader
  or Files toolbar will diff; re-capture with `--update-snapshots` and review the
  diff as part of the visual gate.
- **vitest:** PrHeader/PrSubTabStrip render tests — assert the chevron renders,
  toggles `data-collapsed`, and exposes the right `aria-expanded`. (No dedicated
  hysteresis unit test — the scroll design that needed it is gone.)
