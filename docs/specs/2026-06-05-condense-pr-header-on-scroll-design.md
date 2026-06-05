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

- **Affordance & placement.** A chevron button anchored to the **right end of the
  Overview/Files/Drafts sub-tab row**, which is the stable anchor present in *both*
  states. **Critical a11y constraint:** the button is a **sibling of the
  `role="tablist"`, never a child of it.** Adding a non-`role="tab"` child inside
  the tablist trips axe `aria-required-children` (critical) — the exact violation
  the project already deferred and *masked only for `[data-testid="pr-tabstrip"]`*
  (`a11y-audit.spec.ts`); a second offending tablist would fail the "no new
  serious/critical" gate (AC) and re-spread debt #174 contains. So `PrHeader`
  wraps `<PrSubTabStrip>` and the chevron in a flex row; the chevron is
  right-anchored (`margin-left:auto`, `flex-shrink:0`) so the tabs can't crowd it
  out at narrow widths.
- **Icon.** A **double-chevron SVG**, authored at rest pointing **down** (the
  expanded state, "more below"); collapsed state rotates it **180°** to point up.
  Themeable via `currentColor`. Not a Unicode caret (`⌃`/`⌄` rejected as cheap).
- **Button semantics & states.** A real `<button>` with `aria-expanded` reflecting
  state, `aria-controls` → the collapsible meta region's id, a `title` tooltip +
  matching accessible label that flips "Collapse PR details" / "Expand PR details",
  and explicit `:hover` / `:focus-visible` / `:active` treatments in existing
  tokens (the button has no parent style to inherit — the sub-tab row holds only
  `role="tab"` buttons — so its states must be specified, aligned with the row
  idiom: `--text-3` resting → `--text-1` on hover, standard focus ring).
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
  seeded **once** from the module store. No re-seed effect is needed:
  `PrTabHost` renders one `PrDetailView` *keyed by `prRefKey`* per open tab
  (`PrTabHost.tsx`), so `refKey` is immutable for an instance's lifetime — the
  instance is never reused across PRs. This mirrors the existing `initialSubTab`
  "read once as the useState seed" pattern in `PrDetailView`; an effect that
  re-seeds on `refKey` change would be dead code. The toggle handler flips state
  **and** writes the store so the choice survives a tab switch (the keyed instance
  stays mounted under keep-alive; the store backstops a future unmount).
- `collapsed` is passed to `PrHeader`, which renders `data-collapsed` as a normal
  JSX attribute on its root (`<div className={styles.prHeader} data-collapsed={collapsed || undefined} …>`).
  CSS collapse rules are scoped `.prHeader[data-collapsed] …`. No imperative
  `toggleAttribute`, no "React preserves attributes it didn't set" dependency.
- The *meta hide / title restyle* is a CSS state change driven by `data-collapsed`
  (see A.2 for the one JSX move it requires). Because the Files view is already
  viewport-bound flex (`.pr-detail-page` column; the files slot is `flex:1 1 0`),
  shrinking PrHeader's height hands the reclaimed pixels straight to the diff —
  no overlay, no scroll math. On a click this reflow is expected user feedback.

### A.2 Visual mechanics + motion

- `data-collapsed` rules hide `.prSubtitle` (author + branch), the
  `.statusMerged`/`.statusClosed` line, and `:global(.pr-meta-repo)` (repo·#), and
  restyle `.prTitle` small + ellipsized.
- **One required JSX move (not pure CSS).** The CI/mergeability chips currently
  live *inside* `.prSubtitle` (`PrHeader.tsx`, interleaved with author/branch), so
  hiding `.prSubtitle` would hide them too. To keep them in the compact row the
  `ciSummary`/`mergeability` `<span>`s must be **moved out of `.prSubtitle` in the
  JSX** into a slot that stays visible when collapsed (the title row), in a way
  that preserves the expanded-state layout (chips on the subtitle line today). The
  plan must define the chip's home in *both* states. This is the one spot that is
  a structure edit, not a scoped CSS rule.
- **The condensed title is the same `<h1 data-testid="pr-title">` node**,
  restyled smaller and ellipsized — *not* a second element. This preserves the
  heading landmark in the accessibility tree (a `display:none` on the full title
  + a separate `<span>` would drop the `h1`).
- **Overflow safety:** in the compact row the title is `flex:1; min-width:0`
  (ellipsizes) and the action cluster is `flex-shrink:0`. This prevents a wide
  open-PR action cluster (VerdictPicker "Request changes" ~100px +
  SubmitInProgressBadge + pending-review pill + Submit + AskAi ≈ 500–600px) from
  overflowing the row near the 900px breakpoint.
- **Motion:** the meta region's height + opacity transition **together** over
  **≤150ms** (content fades *as* the row collapses — avoids a content-gone /
  empty-box-still-shrinking intermediate frame), **suppressed under
  `@media (prefers-reduced-motion: reduce)`**.

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
padding, gaps, fonts, and the control set are untouched.

**Density-token interaction (pin in the plan).** `.filesTabToolbar` currently uses
`var(--s-3)` vertical padding, which `[data-density="compact"]` overrides to 10px.
The trimmed values here (8/2/5px) are **deliberately density-independent** — they
sit below compact's 10px, so compact mode no longer shrinks the toolbar height
(its `--s-3` override simply stops reaching this axis). That is intentional, not a
regression; the plan should state it explicitly (and may add a `[data-density="compact"]`
override pushing the toolbar lower still if cramping allows). Don't describe this
as "composing with compact" — it supersedes compact on the vertical axis. Exact px
are a plan detail; target "~50px toolbar, no cramping."

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
  deliberate: the user explicitly chose collapse, and expanding restores it; the
  open-PR-tab-strip chip and the kept CI/mergeability chip still hint at state.
  Noted as a conscious trade because reviewing already-merged PRs is a primary
  PRism workflow — if the human gate decides the merged/closed status deserves to
  survive collapse, the cheapest fix is to keep it as a compact pill in the title
  row alongside the CI chip (same mechanism). Left out by default per the owner's
  "drop the status meta" decision.

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
  scroll container" (the element is `overflow-y:auto` by design). Note the
  existing spec's single-file fixture yields a one-row tree that won't overflow —
  the tree-independence check needs a **multi-file fixture** (or asserts the tree
  is a distinct scroll container from the diff body, independent of whether it
  currently overflows).
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
- **a11y (Playwright `a11y-audit`):** no new serious/critical vs `main`. Explicitly
  confirm the chevron-in-PrHeader (sibling of, not child of, the tablist)
  introduces **no `aria-required-children`** finding, the `h1` heading landmark
  persists in the collapsed state, and the toggle exposes `aria-expanded`.
- **Reduced-motion:** assert the collapse height/opacity transition is suppressed
  under `prefers-reduced-motion: reduce` (covers AC 9 explicitly).
- **Re-baseline:** the toolbar trim + collapsed header will diff specific committed
  baselines — expect `pr-detail-files-diff.png`, `pr-detail-files-diff-whole-file.png`
  (diff container grows as the toolbar shrinks), and `pr-detail-header.png`
  (`parity-baselines.spec.ts`) to drift. Re-capture with `--update-snapshots` and
  review each diff as part of the visual gate (a stale baseline must not read as a
  regression).
- **vitest:** PrHeader/PrSubTabStrip render tests — assert the chevron renders,
  toggles `data-collapsed`, and exposes the right `aria-expanded`. (No dedicated
  hysteresis unit test — the scroll design that needed it is gone.)
