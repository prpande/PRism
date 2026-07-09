import { test, expect, request } from '@playwright/test';

import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

// Regression guard for #746: the Overview timeline's node badges must scroll BEHIND the
// sticky <PrActionsPanel /> footer, not over it.
//
// The bug: `.badge` declared `position: relative; z-index: 1` to sit on the rail spine,
// while `.panel` was `position: sticky` with no `z-index` (so `auto`). The badge's whole
// ancestor chain (.node → .rail → .overview-card → .overviewGrid → .overviewTab) is
// `z-index: auto`, unpositioned or `position: relative`, with no transform, filter,
// opacity or containment — so none of it scopes the badge's `z-index`, and the badge
// competed against the footer directly. A positive `z-index` paints AFTER `z-index: auto`
// regardless of DOM order, so the badge won even though the panel comes later in the
// markup, and punched through the "PR actions" bar.
//
// The tell in the wild: the rail spine (`.rail::before`, `z-index: auto`) was correctly
// occluded while the badge sitting on it was not — only the element carrying a `z-index`
// escaped.
//
// jsdom cannot catch this: it has no layout and no paint order, so a vitest assertion
// would be vacuous. The check has to run in a real browser and ask the compositor what is
// actually on top, via `elementFromPoint`.
//
// Two assertions, one per layer of the fix:
//   1. The symptom — a real badge scrolled into the footer's band stays behind it.
//   2. The mechanism — `.rail` carries `isolation: isolate`, so ANY rail descendant, however
//      high its z-index, is contained. The canary probe proves the boundary exists rather
//      than trusting that nobody inside the rail ever declares a z-index again.
//
// Assertion 1 alone is weakly guarded: the fix's two CSS halves (dropping `.badge`'s
// `z-index`, giving `.panel` `z-index: 1`) are each independently sufficient, since equal
// z-indexes tie and a tie breaks on DOM order, which the footer wins. Reverting one does not
// turn it red. Assertion 2 is what pins the containment boundary.
//
// SCOPE: the footer is deliberately NOT above everything — the composer's formatting overflow
// menu (z-index 20) is a sibling of `.rail` and is meant to float over the footer. So a
// non-timeline Overview component acquiring `z-index >= 2` would still escape; #747 (the
// layering token scale) is the durable cure for that remaining class.

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await ctx.dispose();
});

test('timeline node badges scroll behind the sticky PR-actions panel, not over it', async ({
  page,
}) => {
  await setupAndOpenScenarioPr(page);
  await page.goto('/pr/acme/api/123');
  await page.locator('[data-testid="pr-header"]').waitFor();
  await expect(page.getByTestId('activity-feed')).toBeVisible();
  // The rail must have rendered its badges before we can scroll one under the panel.
  await expect(page.getByTestId('timeline-marker').first()).toBeVisible();

  // A short viewport guarantees the Overview slot overflows, so there is scroll range to
  // bring a badge down into the footer's band.
  await page.setViewportSize({ width: 1280, height: 600 });

  const probe = await page.evaluate(() => {
    // Subtabs are kept alive while hidden, so qualify on the visible one.
    const slot = document.querySelector<HTMLElement>('[data-subtab="overview"]:not([hidden])');
    const panel = document.querySelector<HTMLElement>('[role="group"][aria-label="PR actions"]');
    const rail = document.querySelector<HTMLElement>('[data-testid="activity-feed"] ol');
    if (!slot || !panel || !rail)
      throw new Error('missing overview slot, PR-actions panel, or rail');

    // A `bottom: 0` sticky footer holds the same viewport rect at every scroll offset, so the
    // band is loop-invariant — measure it once.
    const band = panel.getBoundingClientRect();
    const bandCentre = band.top + band.height / 2;

    // Name what is painted on top at (cx, cy). The hit is often the badge's inner <svg>, which
    // carries no class of its own, so report the nearest classed ancestor.
    const describe = (el: Element | null) => {
      if (!el) return 'nothing';
      const owner = el.closest('[class]')?.getAttribute('class')?.split(' ')[0];
      return `<${el.tagName.toLowerCase()}> inside .${owner ?? '(unclassed)'}`;
    };

    const badges = [...rail.querySelectorAll<HTMLElement>('[data-tone]')];

    // Park each badge's CENTRE on the band's centre in turn. Resetting to 0 first makes a
    // rect's viewport `top` equal its offset from the scroll origin, so the delta below is a
    // valid absolute scrollTop. Early badges clamp at 0 and late ones clamp at the maximum, so
    // only a mid-rail badge actually lands — which one depends on the seeded event count, hence
    // the loop rather than a hardcoded index.
    for (const badge of badges) {
      slot.scrollTop = 0;
      const at0 = badge.getBoundingClientRect();
      slot.scrollTop = at0.top + at0.height / 2 - bandCentre;

      const b = badge.getBoundingClientRect();
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      // Both arms are live: `cy <= band.top` catches a badge that clamped at scrollTop 0,
      // `cy >= band.bottom` one that clamped at the maximum.
      if (cy <= band.top || cy >= band.bottom) continue;

      const badgeHit = document.elementFromPoint(cx, cy);

      // Boundary check, not just this symptom: a rail descendant with an outrageous z-index must
      // STILL sit under the footer, because `.rail` isolates. Without `isolation: isolate` this
      // escapes exactly as the badge did before #746 was fixed.
      //
      // `position: fixed` (not absolute) so left/top are VIEWPORT coordinates — absolute would
      // resolve against `.rail`, which is `position: relative`, and land the canary nowhere near
      // (cx, cy), making this assertion pass vacuously. `isolation` establishes a stacking
      // context but NOT a containing block, so a fixed descendant still positions against the
      // viewport while remaining stacked inside `.rail`.
      //
      // An <li>, not a <div>: the rail is an <ol>, whose content model admits only li/script/
      // template. Stacking containment cares about DOM ancestry, so any valid child works.
      const canary = document.createElement('li');
      canary.setAttribute('aria-hidden', 'true');
      canary.style.cssText = `position:fixed;z-index:999;left:${cx - 4}px;top:${cy - 4}px;width:8px;height:8px;list-style:none;`;
      rail.appendChild(canary);
      const canaryHit = document.elementFromPoint(cx, cy);
      const canaryEscaped = !!canaryHit && canary.contains(canaryHit);
      // Self-check: the canary must actually be under the probe point, else "it did not escape"
      // means "it was not there". `canaryOverProbePoint` is asserted below.
      const cr = canary.getBoundingClientRect();
      const canaryOverProbePoint =
        cx >= cr.left && cx <= cr.right && cy >= cr.top && cy <= cr.bottom;
      canary.remove();

      return {
        // Guards a vacuous pass: if the footer ever stops being sticky, the overlap this test
        // depends on cannot happen and "nothing painted over it" would prove nothing.
        panelPosition: getComputedStyle(panel).position,
        badgeTopmostIsPanel: !!badgeHit && panel.contains(badgeHit),
        badgeTopmost: describe(badgeHit),
        canaryEscaped,
        canaryOverProbePoint,
        canaryTopmost: describe(canaryHit),
      };
    }
    throw new Error(`no badge could be scrolled into the panel band (badges: ${badges.length})`);
  });

  expect(probe.panelPosition).toBe('sticky');

  // The symptom: at a point the badge and the panel both cover, the panel is what the user
  // sees. Reaching here already proves a badge overlapped the panel — the probe throws otherwise.
  expect(
    probe.badgeTopmostIsPanel,
    `expected the sticky footer on top at the badge's centre, but found ${probe.badgeTopmost}`,
  ).toBe(true);

  // Without this the next assertion is vacuous: a canary that never covered the probe point
  // trivially "did not escape". An earlier revision used `position: absolute` and failed exactly
  // this way — it passed with `isolation: isolate` removed.
  expect(probe.canaryOverProbePoint).toBe(true);

  // The mechanism: `.rail` is a stacking context, so nothing inside it can outrank the footer
  // however high its z-index. This is what stops the next timeline element from re-opening #746.
  expect(
    probe.canaryEscaped,
    `a z-index:999 element inside .rail escaped its stacking context and painted over the footer (topmost: ${probe.canaryTopmost}) — has .rail lost \`isolation: isolate\`?`,
  ).toBe(false);
});
