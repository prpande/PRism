import { test, expect, request, type Page } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

// ---------------------------------------------------------------------------
// #640 — PR-detail header + sub-tab strip must stay PINNED; only the active
// tab's content scrolls.
// ---------------------------------------------------------------------------
//
// The Files tab already behaves this way: PrDetailView stamps a
// `data-files-active` marker on [data-app-scroll], which binds the app shell to
// the viewport so the diff scrolls in an internal container while the header
// stays put. The other tabs (Overview / Hotspots / Checks) had no such marker,
// so their content grew the document and the header scrolled off the top.
//
// This guards Overview and Checks, both reachable from the plain scenario setup
// (no AI needed). Hotspots shares the SAME tab-agnostic `[data-subtab]` scroll
// rule (it needs the AI-on mock plumbing to mount) and is verified in the
// visual gate.
//
// Method: open the scenario PR, switch to the tab, inject a tall filler into the
// tab's scroll root so the content reliably overflows regardless of fixture
// volume, then assert the DOCUMENT itself does not scroll and that a scroll
// attempt leaves the header pinned at the top. With the bug the document grows
// and the header scrolls away.
//
// prod project only — the dev project cannot run scenario specs
// (reference_dev_playwright_project_cant_run_scenario_specs).

const VIEWPORT = { width: 1280, height: 700 };

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await ctx.dispose();
});

async function documentOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollHeight - doc.clientHeight;
  });
}

async function headerTop(page: Page): Promise<number> {
  return page.locator('[data-testid="pr-header"]').evaluate((el) => el.getBoundingClientRect().top);
}

for (const tab of [
  { id: 'overview', testid: 'pr-tab-overview' },
  { id: 'checks', testid: 'pr-tab-checks' },
] as const) {
  test(`#640 ${tab.id} tab keeps the header pinned — only tab content scrolls`, async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);

    await page.goto('/pr/acme/api/123');
    await page.locator('[data-testid="pr-header"]').waitFor();
    await expect(page.locator('[data-testid="pr-title"]')).toHaveText('Calc utilities');

    await page.getByTestId(tab.testid).click();

    // The visible sub-tab panel slot.
    const slot = page.locator(`[data-subtab="${tab.id}"]:not([hidden])`);
    await expect(slot).toBeVisible();

    // Force overflow: append a tall filler directly to the sub-tab panel slot.
    // The fix makes that slot the bounded internal scroller, so a pinned layout
    // absorbs this; the buggy layout grows the document instead. (Appending to
    // the slot itself — not its first child — avoids the sr-only announcer span
    // some tabs render first, which is clipped to 1×1px and would swallow the
    // filler.)
    await slot.evaluate((el) => {
      const filler = document.createElement('div');
      filler.style.height = '3000px';
      filler.setAttribute('data-test-filler', '');
      el.appendChild(filler);
    });

    // 1) The document must not scroll — the overflow lands in the internal tab
    //    scroller, keeping PrHeader + sub-tab strip fixed.
    expect(await documentOverflow(page)).toBeLessThanOrEqual(1);

    // 2) The slot ITSELF is the scroller that absorbed the overflow. This ties
    //    the assertion to the slot-as-scroller mechanism — guarding against a
    //    future change that makes a nested element (.overviewTab/.checks) scroll
    //    instead (the rejected per-tab-root model would still satisfy (1)).
    const slotScrolls = await slot.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    expect(slotScrolls).toBe(true);

    // 3) A scroll attempt must leave the header pinned and fully on-screen. With
    //    the bug, scrolling the document drags the header ABOVE the viewport, where
    //    getBoundingClientRect().top goes negative — so the LOWER bound (>= 0), not
    //    an upper bound, is what discriminates pinned from scrolled-off (a deeply
    //    negative top would still satisfy any `<= N`). The upper bound additionally
    //    keeps it honest that the pinned header sits near the top (just under the app
    //    navbar + tab strip), not pushed somewhere unexpected.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const top = await headerTop(page);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThanOrEqual(120);
  });
}
