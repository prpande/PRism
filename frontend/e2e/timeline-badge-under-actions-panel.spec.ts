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
// SCOPE: this guards the badge specifically. It would NOT catch a different Overview
// component (a stat tile, a card) newly acquiring a positive `z-index` and escaping the
// same way — the footer's `z-index: 1` only outranks content that declares nothing. The
// durable cure for that class is the layering token scale in #747. Note the footer is
// deliberately NOT above everything: the composer's formatting overflow menu (z-index 20)
// is meant to float over it.
//
// The fix has two halves — dropping `.badge`'s `z-index`, and giving `.panel` `z-index: 1`
// — and EITHER ONE ALONE is sufficient: with both at `1` they tie, and a tie breaks on DOM
// order, which the footer wins. So this asserts the observable (nothing in the rail paints
// over the footer), not either declaration. Reverting BOTH halves makes it RED; reverting
// one does not, by design.

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
    if (!slot || !panel) throw new Error('missing overview slot or PR-actions panel');

    const badges = [
      ...document.querySelectorAll<HTMLElement>('[data-testid="activity-feed"] ol [data-tone]'),
    ];

    // Park each badge in turn at the panel's vertical centre. The topmost badges clamp
    // scrollTop to 0 and the last ones clamp at the maximum, so only a mid-rail badge
    // lands inside the band — which one depends on the seeded event count.
    for (const badge of badges) {
      slot.scrollTop = 0;
      const band = panel.getBoundingClientRect();
      slot.scrollTop = badge.getBoundingClientRect().top - (band.top + band.height / 2);

      const b = badge.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      if (cy <= p.top || cy >= p.bottom) continue;

      const hit = document.elementFromPoint(cx, cy);
      // The hit is often the badge's inner <svg>, which carries no class of its own — name
      // the nearest classed ancestor so a failure says WHICH element escaped.
      const owner = hit?.closest('[class]')?.getAttribute('class')?.split(' ')[0];
      return {
        // Guards a vacuous pass: if the footer ever stops being sticky, the overlap this
        // test depends on cannot happen and "nothing painted over it" proves nothing.
        panelPosition: getComputedStyle(panel).position,
        topmostIsPanel: !!hit && panel.contains(hit),
        topmost: hit
          ? `<${hit.tagName.toLowerCase()}> inside .${owner ?? '(unclassed)'}`
          : 'nothing',
      };
    }
    throw new Error(`no badge could be scrolled into the panel band (badges: ${badges.length})`);
  });

  expect(probe.panelPosition).toBe('sticky');

  // The assertion: at a point the badge and the panel both cover, the panel is what the
  // user sees. Reaching this line already proves a badge overlapped the panel — the probe
  // throws otherwise.
  expect(
    probe.topmostIsPanel,
    `expected the sticky footer on top at the badge's centre, but found ${probe.topmost}`,
  ).toBe(true);
});
