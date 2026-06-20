# Overview/Hotspots column: fluid width with a readability ceiling (#470)

**Issue:** [#470](https://github.com/prpande/PRism/issues/470) · **Tier:** T2 · **Risk:** B1 (UI-visual; `design`/`needs-design`)

## Problem

The PR-detail **Overview** tab pins its content column at a hardcoded `max-width: 920px`
(`OverviewTab.module.css:8`). On a 1920px display that leaves ~500px of dead margin on each
side while the prose inside feels cramped. The **Hotspots** tab shares the identical 920px cap
(`HotspotsTab.module.css:5`) and a comment already flags it for joint revision under #470.

## Decision (settled live with the owner, 2026-06-20)

Validated against the running app (PR #197 — real AI summary + description + 49-comment threads)
at 1280 / 1440 / 1920 in both themes. Owner sign-off on the screenshots:

- **Shape:** `width: min(80%, var(--pr-detail-content-max))`, replacing the fixed `max-width`.
  The existing `margin: 0 auto` is **preserved**, so the column stays centred with symmetric
  gutters at every width — including ultrawide (>1920), where the cap holds at 1280 and the
  surplus splits evenly left/right.
  - `width` (not `max-width`) is required so the **percentage governs the side-gutter at
    laptop widths**. With `max-width` the column would stretch edge-to-edge below the cap and
    lose the intentional gutter. Confirmed live: at 1280 the column lands at ~1016px (~132px
    gutter/side) — wider than today's 920, **no laptop regression**.
- **Cap = 1280px**, promoted to a token `--pr-detail-content-max`. At ≥1600px the percentage
  collapses to the cap; 1280 fills the screen convincingly (gutters drop from 495 → 320px/side
  at 1920) while still bounding line length. 1200 left it too empty; 1320 added nothing over 1280.
- **Percentage = 80%.** Per the issue's analysis, 70% regresses laptops (896 < 920 at 1280);
  80% is the floor that keeps a comfortable gutter and grows cleanly to the cap.
- **Single widened column** (not the two-tier "wide frame / narrow prose" variant). The wider
  running-prose measure (~1150px at the cap) is an accepted trade for this slice; a tighter
  prose measure is deferred as a possible follow-up, not bolted on here.
- **Scope includes Hotspots.** Same token and same **width rule** (`width: min(80%, …)`), so
  the triage surface stays visually paired with the Overview rather than diverging. "Same rule"
  refers to the width/cap only — the per-tab padding (below) intentionally stays different.

### Unchanged on purpose

- **Padding stays per-tab:** Overview keeps `--s-6`, Hotspots keeps `--s-3`. The new width
  read comfortably at both paddings in the live check; no revisit needed this slice.
- **No narrow-screen floor / `@media`.** The desktop app isn't targeted below laptop width;
  at very narrow widths `80%` degrades gracefully (proportional gutter). Adding a `min()` floor
  or breakpoints is unwarranted complexity.

## Acceptance criteria

- [ ] Overview column scales with viewport and visibly reduces side margins at 1440 / 1920.
- [ ] A max width still bounds line length (cap = 1280) so prose stays readable on ultrawide.
- [ ] Cap is a token (`--pr-detail-content-max`), not a hardcoded `920px`. No `920` literal
      remains in either module.
- [ ] Hotspots column uses the same token + rule.
- [ ] Verified live at 1280 / 1440 / 1920 in both themes.
- [ ] `pr-detail-overview.png` visual baseline regenerated **and committed** (linux canonical
      from the CI artifact + win32 from a local build on a private port, per Test plan).

## Implementation

| File | Change |
|------|--------|
| `frontend/src/styles/tokens.css` | Add `--pr-detail-content-max: 1280px;` in the `density` block, with a comment naming the pairing rule and #470. |
| `frontend/src/components/PrDetail/OverviewTab/OverviewTab.module.css` | `.overviewGrid`: `max-width: 920px` → `width: min(80%, var(--pr-detail-content-max))`. |
| `frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.module.css` | `.hotspots`: same swap; update the anticipatory comment to record the resolution. |

## Test plan

CSS layout isn't unit-testable under jsdom (`min()`/`var()` don't resolve without a layout
engine). The regression gate is the Playwright per-zone visual baseline:

- **Red → green (visual):** the existing `parity-baselines` test `pr-detail-overview` captures
  `[data-testid="overview-tab"]` at the 1440 viewport. There `min(80%, 1280px)` resolves to
  `80% × 1440 = 1152px`, so the captured column changes 920 → 1152 — well past the 2% pixel
  tolerance → the baseline fails → regenerate it as the new committed state. That
  failing-then-updated baseline is this change's red-on-main-equivalent.
- **No sticky/anchored children to re-check:** grep confirms zero `position: sticky|fixed`
  inside the Overview/Hotspots subtrees, so widening the column shifts nothing out of alignment
  (corroborated by the live render at 1280/1440/1920).
- **win32** baseline regenerated locally with `CI=1` against a **freshly built** server on a
  private port (NOT the default 5180 — `reuseExistingServer` would otherwise reuse a stale
  server and bake a 920px baseline).
- **linux** canonical baseline regenerated from the CI `e2e-results` artifact after the first
  CI run reds (download `actual.png`, verify the diff is exactly the width change, overwrite
  `__screenshots__/linux/pr-detail-overview.png`, re-push).
- Hotspots: `hotspots.spec.ts` is DOM-assertion-only (no `toHaveScreenshot`); the width change
  doesn't affect it and no new baseline is added this slice.
- Existing unit tests asserting `overview-tab` visibility (`PrDetailView*.test.tsx`) are
  width-agnostic and stay green.

## Proof obligations (PR `## Proof`)

- Acceptance checklist with screenshot refs (1280/1440/1920 × both themes).
- Visual: before/after at 1920.
- Secrets scan over the diff (CSS-only; expected clean).
- `ce-doc-review` dispositions for this spec.
