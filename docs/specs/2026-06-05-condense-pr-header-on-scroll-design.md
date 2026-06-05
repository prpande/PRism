---
title: Condense PR-detail header on diff scroll (#128)
status: draft
type: feat
issue: 128
tier: T2
risk: B1 (UI-visual)
date: 2026-06-05
---

# Condense PR-detail header on diff scroll (#128)

## Problem

In PR detail → Files, the chrome stack above the diff consumes ~half the
viewport before a single line of code is visible. Measured live on
`mindbody/Mindbody.BizApp.Bff#191` at a 773px viewport: App Header (52) +
PrTabStrip (45) + **PrHeader meta (102)** + Overview/Files/Drafts sub-tabs (41)
+ Files toolbar (77) + file-path header — leaving the diff body only **384px**.
The PR-meta block is mostly read-once orientation info (repo·#, merge status,
author, branch, CI/mergeability chips) that does not earn its ~100px while the
reviewer is actually reading diffs and comments.

Reported from a UI review session 2026-06-03.

## What the issue asked for vs. what already shipped

The issue lists four acceptance criteria. Live verification (Playwright against
`#191`, viewport 773px) shows **three of the four are already delivered** by the
viewport-bound Files layout (#191/#149/#155/#156):

| Original criterion | Status | Evidence |
|---|---|---|
| File tree stays put while diff scrolls | ✅ shipped | Tree and diff are independent scrollers at a shared fixed `top`; `.diff-pane-body` is the diff's own `overflow:auto` scroller. |
| Vertical scroll confined to diff container (no full-page scroll) | ✅ shipped | `document` not scrollable; `[data-app-shell]` pinned to `100dvh`; `[data-app-scroll]` not scrollable when `[data-files-active]`. |
| Works in both desktop shell and browser | ✅ shipped | The `data-files-active` rules in `tokens.css` are **not** gated on `[data-shell="desktop"]`. |
| **Top bar collapses on scroll-down, restores on scroll-up** | ❌ not built | No scroll-driven condense exists anywhere. |

So this slice's net-new work is the **fourth** criterion only, reframed (per the
issue owner) from a *total collapse* to a *condense*: shrink the title, drop the
read-once meta, hand the reclaimed pixels to the diff. Criteria 1–3 get a
**regression test** so the already-shipped behavior cannot silently regress.

## Decision

### A. Condense, not collapse (Approach 1 — threshold-driven)

When the diff body is scrolled past a threshold, the **PrHeader meta block**
switches to a condensed state:

- **Title** → single-line, ellipsized, ~1rem, sitting on the actions row.
- **Hidden:** `repo · #`, the `Merged/Closed …` status line, and the
  `author · branch → base · CI/mergeability` subtitle line (the CI chip goes
  with it — scrolling back up to check the build is cheap, and one lone chip
  reads as visual debris).
- **Kept, always visible:** Submit/AskAi/Verdict actions, and the
  Overview/Files/Drafts sub-tab strip.

Live mock measured the reclaimed space: diff body **384px → 455px (+71px,
~18% taller diff)**, achieved purely by the existing flex layout (see below).

**Trigger is scroll *position*, not scroll *direction*.** Condense when the diff
body `scrollTop > 48px`; re-expand when `scrollTop < 8px`. The two thresholds
give hysteresis so the header does not flicker when the user hovers near the
boundary. Direction-aware auto-hide (hide-on-down / show-on-up) was explicitly
rejected: it is the classic "disappearing header" that reviewers find janky, it
re-triggers on any small upward scroll, and it would remove the title entirely.

### B. The reclaim is free — no overlay, no scroll math

The Files view is already viewport-bound flex: `.pr-detail-page` is a column,
its children are `flex-shrink:0` **except** the files slot which is `flex:1 1 0`.
Shrinking PrHeader's height therefore hands the reclaimed pixels straight to the
diff slot — no `position:sticky`, no absolute overlay, no manual height
arithmetic. The condense is a pure CSS state change; the layout reflows the diff
automatically.

Consequence to accept: as the header condenses, the diff content shifts up by
~70px on screen (the diff body's top moves up). This is the standard
sticky-condense behavior and is smoothed by a short transition. The diff body's
`scrollTop` is **not** changed by the reflow (content above the viewport stays
above it), so the user's reading position is preserved.

### C. Wiring — imperative `data-condensed`, consistent with `data-files-active`

Scroll events are high-frequency; driving React state on every event would
re-render the whole PR detail subtree. The codebase already solves the identical
problem imperatively: `PrDetailView` toggles `data-files-active` on
`[data-app-scroll]` in a layout effect, and `useTabScrollMemory` writes
`scrollTop` imperatively. This slice follows that pattern:

- A new hook (working name `useCondenseHeaderOnScroll`), wired by the **active**
  `PrDetailView` (same `if (!active) return` guard as the `data-files-active`
  effect, so only one view ever drives it), attaches a **passive, capture-phase**
  `scroll` listener on the stable `[data-subtab='files']` slot.
  - Capture phase is required because `scroll` does not bubble, and the inner
    `.diff-pane-body` element is **recreated when the selected file changes** —
    a capture listener on the stable slot catches scroll from whatever diff-body
    element is current without re-attaching. The handler filters on
    `e.target.matches('.diff-pane-body')` so the file-tree's own scroll and
    other inner scrollers don't trigger condense.
- On each scroll the handler applies the hysteresis and toggles a `data-condensed`
  attribute on the **PrHeader root** element. React preserves data-* attributes
  it did not set across re-renders, so an unrelated PrHeader re-render (e.g. a
  session change) will not clear it.
- Cleanup (deactivation, sub-tab change away from Files, unmount) removes both
  the listener and `data-condensed`, so a non-Files view / inactive tab always
  renders the full header.

The hysteresis decision is a tiny pure function (`shouldCondense(prev, scrollTop)`)
so it is unit-testable without layout.

### D. Visual technique + motion

- `data-condensed` lives on the PrHeader root (which already carries the
  `.prHeader` module class + `data-testid="pr-header"`). CSS condense rules are
  scoped `.prHeader[data-condensed] …`, targeting `.prTitle`, `.prSubtitle`,
  `.statusMerged`/`.statusClosed` (module classes) and `:global(.pr-meta-repo)`.
- Meta lines hidden via `display:none` cannot animate height. Acceptable
  techniques (final choice left to the plan): wrap the collapsible meta in a
  container animating `max-height`/`opacity`, or accept an instant meta hide with
  the title font-size + row height transitioning. Either way the transition is
  **≤150ms** and **suppressed under `@media (prefers-reduced-motion: reduce)`**.

## Scope boundary with #185

#185 ("convert the diff-toolbar text toggles to compact icon controls") owns the
**Files toolbar** real estate (the 77px `Side-by-side / Show full file / Wrap
long lines` row + iteration strip). This slice touches **only the PrHeader meta
block** and must not restyle or collapse the toolbar — otherwise the two issues
collide. The App Header and PrTabStrip are likewise out of scope (global chrome;
condensing them would affect non-Files views and is jarring).

## Out of scope / disposition

- **Files toolbar / iteration strip condensing** — #185's job (see boundary
  above). Not folded in.
- **App Header + PrTabStrip condensing** — out of scope; global chrome.
- **Small-viewport escape-hatch case** — when the rigid header stack exceeds the
  viewport, `[data-app-scroll]` becomes scrollable and the whole page (including
  the tree top) scrolls; that is the intentional #155 dead-end-avoidance escape
  hatch. Condensing the header *reduces* how often it engages, but reworking the
  escape hatch is not in scope. Noted, not changed.
- **Persisting condensed state across tab switches** — condense is ephemeral
  view state derived from the live scroll position; it resets to expanded on
  re-entry. No persistence.

## Acceptance criteria

- [ ] In Files view, scrolling the diff body past the threshold condenses the
      PrHeader: title shrinks to a single ellipsized line, and repo·#, status,
      and the author/branch/CI-chip line are hidden.
- [ ] Scrolling the diff body back to the top re-expands the full header.
- [ ] The condense/expand boundary does not flicker (hysteresis: condense >48px,
      expand <8px).
- [ ] Submit/AskAi/Verdict actions and the Overview/Files/Drafts tabs remain
      visible and functional in both states.
- [ ] The diff body gains the reclaimed height when condensed (verified > full
      state) — no overlay; the file tree and diff stay independent scrollers.
- [ ] Switching to Overview/Drafts, or to another PR tab, renders the full
      (non-condensed) header.
- [ ] Under `prefers-reduced-motion: reduce`, the condense transition is
      suppressed.
- [ ] **Regression (criteria 1–3 from the issue):** in Files view the document
      is not page-scrollable, `[data-app-scroll]` is not scrollable, the diff
      body is the diff's own scroller, and the file tree is an independent
      scroller — asserted so the #191 layout cannot silently regress.

## Test plan

- **Regression e2e (criteria 1–3, Playwright — jsdom has no layout):** open a
  multi-file PR's Files view; assert `document.scrollingElement` is not
  scrollable, `[data-app-scroll]` is not scrollable, `.diff-pane-body` is the
  scroller, and the file tree is a separate `overflow-y:auto` container. This is
  the guard that locks in the already-shipped behavior.
- **Condense behavior e2e (Playwright):** scroll `.diff-pane-body` past 48px →
  assert `data-condensed` appears on `[data-testid="pr-header"]`, the meta lines
  are hidden, and the diff body's `clientHeight` increased vs the un-condensed
  measurement; scroll back to <8px → assert it reverts. Verify boundary
  hysteresis (a scroll to ~30px after condensing keeps it condensed).
- **Hysteresis unit test (vitest):** the pure `shouldCondense(prev, scrollTop)`
  function across the threshold band (0, 8, 30, 48, 60) for both prior states.
- **Visual (the B1 gate):** live before/after screenshots of the real running app
  (full vs condensed) in light and dark. This is the human-gated proof.
- **a11y (Playwright `a11y-audit`):** no new serious/critical violations vs
  `main`; condensing must not orphan focus or hide a focused control (the hidden
  meta lines are non-interactive text, so this is low-risk — confirm anyway).
- **Reduced-motion:** confirm the transition is suppressed under
  `prefers-reduced-motion: reduce`.
