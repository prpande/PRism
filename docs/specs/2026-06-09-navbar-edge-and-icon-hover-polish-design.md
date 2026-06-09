# Nav-bar polish: light-mode edge + icon hover consistency

**Issues:** #289 (light-mode navbar bottom edge looks blurred), #290 (Settings/Help
icon hover inconsistent with the Inbox tab hover)
**Tier:** T2 · **Risk:** B1 (UI-visual, `design` label) · **Date:** 2026-06-09
**Scope:** `frontend/src/components/Header/Header.module.css` only. One combined PR
closing both issues (same file, cohesive nav-bar polish).

## Problem

Two unrelated-but-cohesive nav-bar rough edges, both pure presentation:

1. **#289 — fuzzy light edge (desktop shell only).** The Electron navbar uses
   `:global([data-shell='desktop']) .header { box-shadow: var(--shadow-2) }`
   (`Header.module.css:129`). In light theme `--shadow-2` is two stacked soft blurs
   at very low opacity (`0 2px 4px …/0.06, 0 1px 2px …/0.04`, `tokens.css:127`).
   Over the accent-tinted bar (`color-mix(--accent 12%, --surface-2)`) sitting on
   `--surface-1` content, the diffuse shadow smears the boundary and washes out the
   base `1px solid var(--border-1)` (line 8). The edge reads as a gradient, not a line.
   Dark `--shadow-2` is a heavier black band (`0 2px 6px black/0.40`) that reads as a
   defined edge and must be preserved.

2. **#290 — divergent icon hover.** The Inbox tab hover (`.tab:hover,
.tab:focus-visible`, lines 29–39) is an accent glow (`--accent-hover` text + faint
   `--accent` tint + `0 0 12px -2px --accent-ring`). The Settings/Help icons
   (`.gear:hover`, lines 91–94) get a neutral `surface-3` grey swap with no accent —
   accent-independent (identical in indigo/amber/teal). `.gear:focus-visible` is a
   separate `outline`, while the tab's focus-visible reuses the hover glow. Two
   nav-bar items, two hover languages.

Both are confirmed by before-shots against `main` (desktop shell, light theme).

## Decisions

### #289 — Approach B: crisp hairline + contained drop (light desktop-shell only)

The base `.header` keeps `border-bottom: 1px solid var(--border-1)` in desktop mode,
so make **that border** the defined line rather than stacking a shadow hairline below
it. In light theme only:

- lift the existing border to the slightly darker `--border-2` (`border-bottom-color:
var(--border-2)`) so it reads as one crisp line, **and**
- replace the diffuse `--shadow-2` with **only** a tight, **negative-spread** drop
  (`0 6px 10px -6px oklch(0.20 0.01 250 / 0.10)`, the same slate base color the
  `--shadow-*` tokens use) so a hint of elevation remains but the blur is pulled in
  and cannot smear past the bar.

Using the border for the line (not a `0 1px 0` shadow hairline stacked under the
already-present `border-bottom`) avoids a double-line edge — a preflight-review catch.

Negative spread is the key: it keeps the "elevated top bar" read (AC #2 below)
without the fuzz (AC #1). Dark is left on `--shadow-2` untouched (AC #2).

**Selector (F5).** `data-theme` and `data-shell` are both set on `<html>`
(`tokens.css` / `desktop/src/main.ts:196`), not nested — so the light override is a
**compound** selector on the same element, not a descendant chain:
`:global([data-theme='light'][data-shell='desktop']) .header`. Its specificity
`(0,3,0)` out-specifies the base desktop-shell rule `(0,2,0)` at line 119, so the
override wins the cascade regardless of source order (placed right after the base
rule for readability). All referenced tokens verified present (`--border-2`,
`--shadow-2`, light/dark variants).

**Rejected:** _A — border-only_ (drop the shadow) flattens the bar, failing the
"still elevated" criterion. _C — tighten-only_ (one lower-blur layer) is a middle
ground that still blurs rather than presenting a defined line.

### #290 — Option A: gear/help adopt the tab's accent glow

Give `.gear:hover` **and** `.gear:focus-visible` the same treatment the tab uses:
`color: var(--accent-hover)`, `background: color-mix(in oklch, var(--accent) 10%,
transparent)`, `box-shadow: 0 0 12px -2px var(--accent-ring)`, plus the tab's
`transition` (color/background/box-shadow at `var(--t-fast)`). Reuses the exact tokens
the tab references, so it tracks every accent + theme automatically. Three details the
review surfaced, all mirrored from how the tab already solves them:

- **Keyboard focus keeps a crisp ring (F4).** Rather than relying on the diffuse glow
  alone — which is a weaker focus indicator on the accent-tinted desktop bar, a
  WCAG 2.4.7/2.4.13 concern for the 32px icon target — `.gear:focus-visible` **keeps**
  a crisp `outline: 2px solid var(--accent-ring)` _on top of_ the glow. Hover and focus
  share the accent glow (AC #3: consistent), and keyboard focus additionally gets the
  ring the icon leans on more than a text tab does. A focused-gear screenshot is added
  to the B1 matrix so the gate can see the focus state, not just hover.
- **Active gear holds its fill (F1).** `.gearOn` (active when a Settings/Help modal is
  open) gets a `.gearOn:hover, .gearOn:focus-visible` rule that keeps the
  `--accent-soft` fill + `--accent` text and sets `box-shadow: none` — the exact analog
  of `.tabActive:hover` (lines 51–56), so hovering the active icon doesn't stack the
  glow and "active" stays steady.
- **Reduced motion (F3).** The glow `transition` added to `.gear` is suppressed by
  extending the existing `@media (prefers-reduced-motion: reduce)` block to reset
  `.gear` alongside `.tab`.

**Rejected:** _Option B — a deliberately distinct icon-button hover_ — no product
reason for icons to read differently from text tabs; Option A is the issue's own
recommendation and matches the established #120 accent-glow language.

**Deferred (F9):** `.gearOn` currently uses `color: var(--accent)` (not
`--accent-hover`) on `--accent-soft`, which may sit just under 4.5:1 for the icon
glyph — a pre-existing active-state contrast question independent of this hover fix.
Out of scope here; noted for a follow-up rather than silently changing a shipped state.

## Verification

This is a presentational CSS-token change with no logic and no observable unit/DOM
behavior — `Header.test.tsx` (role/href/aria assertions) is unaffected.

- **#289 is desktop-shell-only** (`[data-shell='desktop']`) and **no e2e spec sets
  `data-shell`**, so it touches zero browser visual baseline.
- **#290 changes only `:hover`/`:focus-visible`**; at-rest visual baselines
  (settings-modal, parity) don't trigger hover and the base `.gear` is unchanged, so
  no baseline regeneration is needed.

**Proof = before/after screenshots (the B1 artifact).** For a B1 visual bug the
captured `main` before-state (fuzzy edge / grey gear hover) is the "red-on-main"
evidence and the after-state is "green"; both themes for #289 and both themes × all
three accents for #290. A computed-style Playwright assertion was considered and
declined: it needs the Test-env backend + auth e2e harness and brittle resolved-oklch
string matching for a change the human B1 gate already validates — disproportionate to
a two-rule CSS tweak. Green CI (existing suites) backstops no-regression.

## Acceptance criteria

1. [ ] **#289:** light navbar bottom edge reads as a clean, defined line (no fuzzy edge).
2. [ ] **#289:** dark mode not regressed; navbar still reads as the elevated top bar.
3. [ ] **#290:** Settings/Help icon hover and `:focus-visible` are styled by one
       accent-glow treatment matching the Inbox tab's (accent text + accent tint + ring),
       so all nav-bar items share one hover language; keyboard `:focus-visible` also keeps
       a crisp ring.
4. [ ] **#290:** verified across light + dark and all three accents — hover, keyboard
       focus, and the active (`.gearOn`) state.
5. [ ] Before/after screenshots in the PR for both issues (incl. a keyboard-focused gear).
