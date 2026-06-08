# Light theme: rebalance the surface ladder for visible hierarchy (#124)

**Issue:** prpande/PRism#124 — "Light theme is too bright with low contrast between surfaces"
**Tier:** T2 (token-only, single file, one real design choice: the new value ladder)
**Risk:** B1 UI-visual (`design` label) — pauses for a human visual assert after green-and-ready.

## Problem

Light mode reads as a flat wall of white. The surface ladder is compressed into
the `0.945–1.0` lightness band with `--surface-1` (cards/diff) at pure white, so
adjacent surfaces (page / card / panel / raised) are nearly indistinguishable and
section hierarchy is weak.

## Scope

**Token-only change inside the `[data-theme="light"]` block of
`frontend/src/styles/tokens.css`.** Surfaces, surface-inset, and the three border
tokens. No text, accent, state (`*-soft`/`*-fg`), diff, or code-color token moves.
Dark mode (healthy `0.18–0.27` spread) is untouched.

## Design: the new ladder

Two moves per the issue direction: **lower overall lightness** (page off `0.985`,
cards off pure white) and **widen the steps** so each level is visibly distinct.
Steps are sized at `0.025–0.035` OKLCH L between adjacent *visible* levels —
above the ~`0.01–0.02` lightness JND so the hierarchy is perceptible at low
chroma (where L is the sole differentiator), while staying inside the AA headroom
computed below.

| Token | Role | Old L | New L | Step from prev visible level |
|-------|------|-----------|-------|------|
| `--surface-1` | cards / diff (lightest) | `1.0` | `0.99` | — (top of ladder) |
| `--surface-0` | page bg | `0.985` | `0.96` | `0.03` below cards |
| `--surface-inset` | inset wells | `0.96` | `0.95` | recessive tier, just below page |
| `--surface-2` | panels, sidebars | `0.97` | `0.925` | `0.035` below page |
| `--surface-3` | hover / raised | `0.945` | `0.90` | `0.025` below panels |

Resulting card→raised spread widens from `0.055` to `0.09`, with the page sitting
clearly between cards and panels (was: page *above* panels by only `0.015`).
`--surface-inset` is the recessive tier for nested input wells; it sits `0.01`
below the page so wells read as slightly sunk without competing with the panel
tier. Hue/chroma of each surface is preserved (`250` hue, `0.003–0.005` chroma) so
the slate cast is unchanged — only L moves.

Borders darkened a touch for crisper section edges — but only `~0.02`, kept
deliberately small so border weight does not dominate the surface hierarchy it is
meant to support (a larger darkening would make card edges read heavier than the
surface-to-surface separation that is the point of this change):

| Token | Old L | New L |
|-------|-----------|-------|
| `--border-1` | `0.91` | `0.89` |
| `--border-2` | `0.87` | `0.85` |
| `--border-strong` | `0.78` | `0.76` |

## Contrast: text stays AA, verified by numbers (not by direction)

**The intuition "darker surface = safer" is wrong and is not the basis for this
change.** WCAG contrast for dark-text-on-light is driven by the *background's*
relative luminance; lowering a surface's lightness lowers its luminance and
therefore *slightly reduces* the text-on-surface ratio. Every surface here moves
darker, so every dark-text-on-surface pair loses a sliver of contrast. Safety is
established by computing the resulting ratios and confirming they clear AA with
headroom — not by asserting a direction.

Computed WCAG ratios for the proposed ladder (`oklch→linearRGB→relative
luminance`, body-text tokens `--text-1 0.20`, `--text-2 0.42`, `--text-3 0.48`,
all unchanged):

| Surface (new L) | text-1 | text-2 | text-3 (worst body) |
|-----------------|--------|--------|--------------------|
| `s1 card 0.99` | 17.6 | 8.2 | 6.35 |
| `s0 page 0.96` | 16.1 | 7.5 | 5.81 |
| `inset 0.95` | 15.6 | 7.3 | 5.65 |
| `s2 panel 0.925` | 14.5 | 6.8 | 5.24 |
| `s3 raised 0.90` | 13.4 | 6.3 | **4.85** |

Worst case is muted `--text-3` on the darkest surface (`--surface-3` raised/hover)
at **4.85:1**, above the `4.5:1` AA body floor with ~0.35 headroom. `--text-4`
(`0.70`, placeholder/disabled-tier — not body text) is excluded; it is only held
to the 3:1 large-text/UI floor.

**Scope of the claim — 1.4.3 text only.** The figures above and the axe-core gate
cover WCAG **1.4.3 (text) contrast**. axe-core's default ruleset does **not**
assert **1.4.11 non-text** contrast (component borders, focus rings, state-fill
backgrounds, diff tints). This change perturbs some non-text pairs:
- Plain borders vs their surface generally *improve* (border darkens against a
  darkening-but-still-lighter surface: e.g. `--border-1 0.89` vs `--surface-1
  0.99` delta widens), so the common 1px-edge case trends safer.
- `*-soft` state fills (`--success-soft`, `--info-soft`, `--accent-soft`, the
  `.ai-tint` background) do not move, but the *surface they sit on* darkens, so
  the soft-fill-vs-surface boundary changes slightly (mostly an improvement as the
  surface moves away from the ~`0.94` fill). The right invariant is "a region's
  contrast against its container depends on both terms" — freezing the fill token
  does not freeze the pair. These fills are largely decorative/state-redundant
  (the text inside them carries the meaning and is unaffected).

1.4.11 is therefore **not machine-verified** by this PR; it is covered by the B1
visual gate (the capture set below includes the surfaces these fills sit on).

## Acceptance criteria

- [ ] Light mode overall brightness reduced — surfaces lowered per the table.
- [ ] Clear visual separation between page bg, cards, panels, raised/hover —
      verified at the B1 visual gate against the capture set below.
- [ ] Dark mode unchanged — PR diff shows **zero edits outside the
      `[data-theme="light"]` block**.
- [ ] Foreground tokens unchanged — PR diff shows zero edits to `--text-*`,
      `--accent*`, and the `*-soft`/`*-fg` state tokens (the contrast argument
      above assumes these are frozen).
- [ ] Text-on-surface contrast (WCAG 1.4.3) stays AA — `e2e/a11y-audit.spec.ts`
      (axe-core, serious/critical = 0) green; this runs in light mode (fixture
      `theme: 'system'` resolves to light under Playwright's default
      `prefers-color-scheme`).

## Verification

- `npm run lint` + `npm run build` + `npm test` (frontend) green.
- `dotnet build`/`dotnet test` per the pre-push checklist (no backend change).
- `e2e/a11y-audit.spec.ts` green — the 1.4.3 text-contrast gate. (axe-core runs
  across all routes: setup, inbox, PR overview/files/drafts, settings, cheatsheet.
  This is broader than the screenshot capture set, which is the *visual-hierarchy*
  focus set named next.)
- **B1 visual gate — before/after light-mode screenshots** of the capture set:
  - Inbox (list, including a **row hover** state),
  - PR detail Overview (root-comment cards on page),
  - PR detail Files (file-tree panel/sidebar + diff pane),
  - Settings (section panels),
  - plus at least one **selected/active** affordance (e.g. active sub-tab or
    selected file-tree row) so an interaction state that fills from a surface
    token is eyeballed, not just the default state.

## Residual risks (noted, not blocking)

- The a11y audit's light coverage depends on Playwright's default
  `prefers-color-scheme: light`; no explicit `colorScheme: 'light'` pin exists. If
  a future CI/Playwright default flipped to dark, the audit would silently
  exercise the dark block. Pinning is out of scope for this token PR.
- Hover-on-panel feedback (`--surface-3 0.90` on `--surface-2 0.925`, `0.025`
  delta) is the tightest interaction-state separation; the capture set's
  hover/selected screenshots are how it is judged.

## Out of scope

- Dark mode (untouched).
- Any component CSS module (this is a token-level change only).
- Pinning the a11y audit to forced light (see residual risks).
- Other Phase 3 theming work (spinner #125) — separate issues.
