---
title: Open-PR tab-strip chrome (#126)
status: draft
type: fix
issue: 126
tier: T2
risk: B1 (UI-visual)
date: 2026-06-04
---

# Open-PR tab-strip chrome (#126)

## Problem

The open-PR tab strip (Row 2, below the Header) renders **inactive** tabs as
plain text with no visible tab chrome — they read as labels "floating in the
air" rather than tabs. The strip should look like real browser/terminal tabs,
with active / inactive / hover visually distinct.

Reported from a UI review session 2026-06-03 (before #124 merged).

## Root cause (the issue's hypothesis is wrong)

The issue speculates the CSS-module class wiring is broken ("`wrapperClassName`
isn't getting `styles.tab`"). It is **not**. `PrTabStrip.tsx` already composes
`styles.tab` (+ `tabActive`/`tabUnread`) onto the outer wrapper, and
`PrTabStrip.module.css` is a faithful port of `design/handoff/screens.css`.

The actual cause is the design itself: the inactive `.tab` rule is
`background: transparent` + `border: 1px solid transparent` — **zero chrome by
design**. Only `.tabActive` and `:hover` paint a surface/border. So every
non-active tab is just text on the strip. Compounding it, before #124 the active
tab was `--surface-1` = pure white (1.0) on a near-white page (0.985), so even
the active tab's chrome was nearly invisible. #124's surface rebalance already
fixed the active-tab case; this issue is the residual inactive-tab case.

## Decision

Adopt **Option B — filled browser-style chips** (chosen from a 3-option visual
render across both themes; A = outline-only, C = segmented connected bar):

- **Inactive tab** gets a recessive fill + visible border so it always reads as
  a tab.
- **Hover** lifts the fill to the lightest surface.
- **Active** keeps its existing treatment (lightest surface + accent top border +
  weight + `-1px` merge with the page below).

Plus a **4px top gap** between the Header's bottom edge and the tab tops (the
tabs currently butt directly against the nav bar, which flattens the "tabs hang
below the bar" read). 4px chosen over 2px from the render comparison.

### Token mapping

| State | background | border | border-top |
|-------|-----------|--------|------------|
| Inactive | `--surface-2` | `1px --border-2` | `2px transparent` |
| Hover (light) | `--surface-1` | `1px --border-1` | `2px transparent` |
| Hover (dark) | `--surface-3` | `1px --border-1` | `2px transparent` |
| Active | `--surface-1` | `1px --border-1` | `2px --accent` |

**Theme-aware hover (ce-doc-review adversarial catch).** Hover must *lighten* the
chip (a "lift" affordance) in both themes. But there is **no single token that is
lighter than `--surface-2` in both themes** — the inactive token sits at opposite
ends of each theme's ladder:

| | strip `s-0` | inactive `s-2` | active `s-1` | hover |
|---|---|---|---|---|
| light (↑=lighter) | 0.96 | 0.925 | 0.99 | `s-1` 0.99 ✓ lighter |
| dark (↑=lighter) | 0.18 | 0.235 | 0.21 | `s-3` 0.27 ✓ lighter |

So hover is `--surface-1` by default (correct for light) with a
`[data-theme="dark"] .tab:hover` override to `--surface-3` (correct for dark).
Without the override, dark hover would *darken* the chip (0.235→0.21) and collide
with the active fill (also 0.21). Both hover rules are scoped
`:not(.tabActive)` so the active tab's appearance is never repainted on hover
(the dark rule out-specifies `.tabActive`, so without the guard it would lighten
the active tab — preflight adversarial catch).

**Dark active-vs-inactive is intentionally NOT lightness-ordered.** In dark the
active tab is `--surface-1` (0.21, it merges with the content surface below — the
browser-tab effect) which is marginally *darker* than inactive `--surface-2`
(0.235). This matches the VS Code dark convention (active tab = editor bg, inactive
tabs slightly lighter). The active tab is distinguished by its accent top-bar +
border + weight, **not** by being the lightest fill. The B1 visual gate must read
it this way — a lighter inactive tab in dark is intentional, not a regression.

**Unread + inactive** share the same `--surface-2` fill; the unread signal is the
accent dot + bold title only (no extra background tint).

The 4px gap is `padding-top: 4px` on `.tabbar` (the `role="tablist"` container).
The active tab's `-1px` bottom merge is at the bottom edge and is unaffected. The
Header is `position: sticky` only under `[data-shell="desktop"]`; `.tabbar` is not
sticky, so the gap is a static top padding — verify it reads correctly in the
desktop shell at the gate (low risk, no scroll interaction expected).

**Focus rings.** While restyling the strip, give `.close` and `.more` a tight
`:focus-visible` ring (`outline-offset: -1px`) so the ring sits inside the chip/
chevron rather than overflowing via the global +2px rule. The 18px close-button
target size (< WCAG 2.5.8 AA 24px) is **pre-existing and out of scope** here.

## Out of scope / disposition

- **Pre-existing `aria-required-children` on `role="tablist"`** (axe serious) —
  **DEFERRED, not folded in** (decision resolved, per scope-guardian: don't leave a
  vague conditional). The `role="tab"` elements are two levels deep inside
  `.inner > .tab` wrappers, with the close `<button>` and the `+N more` overflow
  controls as non-`tab` descendants of the tablist. A correct fix
  (`role="presentation"` pass-through on the wrappers, or `aria-owns`, or the APG
  closeable-tab pattern) restructures the role tree and risks introducing a
  *different* axe finding, so it must be made and re-verified against axe as a unit
  — that is the existing **D85 a11y bundle's** job, not this visual PR's. It is on
  `main`, not introduced here, and non-blocking in CI (Playwright steps are
  `continue-on-error`). Recorded in the PR `## Proof`.
- **Overflow-menu keyboard navigation** (ArrowUp/Down between `menuitem`s) — already
  deferred to the D85 a11y bundle per the `PrTabStrip.tsx` comment; not in scope.

## Acceptance criteria

- [ ] Inactive tabs render visible tab chrome (recessive fill + border + rounded
      top) in both light and dark — no longer plain floating text.
- [ ] Active vs inactive vs hover are visually distinct in both themes.
- [ ] A visible gap separates the tab tops from the Header's bottom edge.
- [ ] Close button (`×`) and the `+N more` overflow menu still work (open,
      click-outside/Escape dismiss, close, navigate).
- [ ] In dark, hovering an inactive tab *lightens* it and stays distinct from the
      active tab; active is read via accent-top + weight, not fill lightness.
- [ ] Under `prefers-reduced-motion: reduce`, hover/close transitions are suppressed.
- [ ] No **new** axe serious/critical violations vs `main`. The only allowed
      carryover is the **pre-existing tablist-ownership family** (`aria-required-children`
      and any sibling node axe splits it into). Verified by diffing the branch's
      serious/critical rule-IDs against `main`'s and asserting the branch set is a
      subset of {tablist-ownership} ∪ main's set.

## Test plan

- **Visual (the B1 gate):** live before/after screenshots of the real running app
  with multiple real PRs open as tabs (active + inactive + hover + unread),
  light and dark. This is the human-gated proof.
- **Re-baseline (required):** the committed `frontend/e2e/__screenshots__/win32/app-chrome-tabstrip.png`
  parity baseline is scoped to the tabstrip element; the chip fills + 4px gap will
  diff it. Re-capture it with `--update-snapshots` and review the diff as part of
  the visual gate (the first styled state becomes the new committed baseline,
  matching the PR2–PR8 parity-restoration convention). A stale baseline must not be
  mistaken for a regression nor silently passed by `continue-on-error`.
- **Reduced-motion:** confirm the existing `@media (prefers-reduced-motion: reduce)`
  block still suppresses `.tab`/`.close`/`.more` transitions after the restyle.
- **Structural (vitest):** existing `PrTabStrip` tests assert the
  `tab`/`tabActive`/`tabUnread` class composition and close/overflow behavior —
  must stay green. Add an assertion only if the aria disposition changes the DOM
  structure.
- **a11y (Playwright `a11y-audit`):** confirm no new serious/critical beyond the
  documented pre-existing tablist finding.
- This is a non-bug-behavior visual change: no red-on-main regression test (there
  is no behavioral bug to reproduce; the proof is the visual gate + green suites).
