import { test, expect, request, type Page } from '@playwright/test';
import { BACKEND_ORIGIN } from './helpers/backend-origin';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

// #643 — the kept-alive Overview / Hotspots / Checks tabs must PRESERVE their inner
// slot scroll position across a sub-tab switch (and a PR background→return). Sibling of
// the #590 Files guard (diff-scroll-keepalive.spec.ts): #640 made the visible
// `[data-detail-active] [data-subtab]:not([hidden])` slot the bounded internal scroller
// for these tabs, so switching away removes the marker, un-bounds the slot, and the
// browser clamps its scrollTop to 0. useSlotScrollMemory captures the live offset and
// writes it back on re-activation; this spec proves the browser-observable contract.
//
// Method mirrors pr-detail-header-pinned.spec.ts (#640): inject a tall filler into the
// slot so it reliably overflows regardless of fixture volume, then drive an in-app
// (keep-alive) sub-tab switch — NOT page.goto, which tears down the keep-alive state +
// the module-level slot-offset store. The filler is a foreign DOM node appended after
// React's managed children; keep-alive only toggles `hidden`, so the slot (and its
// filler) stay mounted across the switch.
//
// prod project only — the dev project cannot run scenario specs
// (reference_dev_playwright_project_cant_run_scenario_specs).

const VIEWPORT = { width: 1280, height: 700 };
const TARGET_SCROLL = 600;

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await ctx.dispose();
});

async function injectFiller(page: Page, tabId: string): Promise<void> {
  // Append directly to the slot (not its first child) — some tabs render a 1×1px
  // sr-only announcer span first that would swallow the filler.
  await page.locator(`[data-subtab="${tabId}"]:not([hidden])`).evaluate((el) => {
    const filler = document.createElement('div');
    filler.style.height = '3000px';
    filler.setAttribute('data-test-filler', '');
    el.appendChild(filler);
  });
}

test('#643 Overview slot scroll survives an Overview→Checks→Overview sub-tab round-trip', async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORT);
  await setupAndOpenScenarioPr(page);

  await page.goto('/pr/acme/api/123');
  await page.locator('[data-testid="pr-header"]').waitFor();
  await page.getByTestId('pr-tab-overview').click();

  const overview = page.locator('[data-subtab="overview"]:not([hidden])');
  await expect(overview).toBeVisible();
  // The slot is the bounded scroller for the detail tabs.
  await expect(page.locator('[data-app-scroll][data-detail-active]')).toHaveCount(1);

  // Force overflow, then sanity-check the slot is a genuine internal scroller.
  await injectFiller(page, 'overview');
  const overflow = await overview.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow).toBeGreaterThan(TARGET_SCROLL);

  // Scroll the Overview slot; the capture listener records the offset.
  await overview.evaluate((el, top) => {
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll'));
  }, TARGET_SCROLL);
  await expect.poll(() => overview.evaluate((el) => el.scrollTop)).toBe(TARGET_SCROLL);

  // --- Switch AWAY to Checks (keep-alive) ---
  await page.getByTestId('pr-tab-checks').click();
  await expect(page.locator('[data-subtab="checks"]:not([hidden])')).toBeVisible();
  await expect(page.locator('[data-subtab="overview"]')).toBeHidden();

  // --- Switch BACK to Overview ---
  await page.getByTestId('pr-tab-overview').click();
  await expect(overview).toBeVisible();
  await expect(page.locator('[data-app-scroll][data-detail-active]')).toHaveCount(1);

  // THE #643 CONTRACT: the Overview slot scroll is restored (not reset to 0). Poll —
  // restore runs in a layout effect after the marker re-applies; Windows CI is slow.
  await expect
    .poll(() => overview.evaluate((el) => el.scrollTop), { timeout: 15000 })
    .toBe(TARGET_SCROLL);
});

test('#643 Checks and Overview slots remember independent scroll offsets', async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await setupAndOpenScenarioPr(page);

  await page.goto('/pr/acme/api/123');
  await page.locator('[data-testid="pr-header"]').waitFor();

  // Scroll Overview to 600.
  await page.getByTestId('pr-tab-overview').click();
  const overview = page.locator('[data-subtab="overview"]:not([hidden])');
  await expect(overview).toBeVisible();
  await injectFiller(page, 'overview');
  await overview.evaluate((el) => {
    el.scrollTop = 600;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => overview.evaluate((el) => el.scrollTop)).toBe(600);

  // Scroll Checks to 250.
  await page.getByTestId('pr-tab-checks').click();
  const checks = page.locator('[data-subtab="checks"]:not([hidden])');
  await expect(checks).toBeVisible();
  await injectFiller(page, 'checks');
  await checks.evaluate((el) => {
    el.scrollTop = 250;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => checks.evaluate((el) => el.scrollTop)).toBe(250);

  // Back to Overview → its OWN 600 (not Checks' 250).
  await page.getByTestId('pr-tab-overview').click();
  await expect(overview).toBeVisible();
  await expect.poll(() => overview.evaluate((el) => el.scrollTop), { timeout: 15000 }).toBe(600);

  // Back to Checks → its OWN 250.
  await page.getByTestId('pr-tab-checks').click();
  await expect(checks).toBeVisible();
  await expect.poll(() => checks.evaluate((el) => el.scrollTop), { timeout: 15000 }).toBe(250);
});

test('#643 Overview slot scroll survives a PR→Inbox→PR background/return', async ({ page }) => {
  // Browser-observable proof of the PR background→return path (AC #2), the sibling of
  // #590's diff-scroll-keepalive PR→Inbox→PR cycle. Backgrounding the PR tab deactivates
  // the view (root `hidden`) but keep-alive keeps it mounted, so the injected filler and
  // the slot survive; on return the marker re-applies and useSlotScrollMemory's restore
  // writes the stored offset back.
  await page.setViewportSize(VIEWPORT);
  await setupAndOpenScenarioPr(page);

  // Suppress the #485 AI-onboarding overlay (mirrors diff-scroll-keepalive.spec.ts):
  // resetBackendState's onboardingSeen patch runs on a separate unauthenticated context
  // and no-ops, so this authenticated POST is what actually lands — without it the dialog
  // backdrop intercepts the return-via-tab-pill click.
  const seenResp = await page.request.post(`${BACKEND_ORIGIN}/api/preferences`, {
    data: { 'ui.ai.onboardingSeen': true },
    headers: { 'Content-Type': 'application/json', Origin: BACKEND_ORIGIN },
  });
  expect(seenResp.ok(), `POST onboardingSeen=true failed: ${seenResp.status()}`).toBe(true);

  await page.goto('/pr/acme/api/123');
  await page.locator('[data-testid="pr-header"]').waitFor();
  await page.getByTestId('pr-tab-overview').click();

  const overview = page.locator('[data-subtab="overview"]:not([hidden])');
  await expect(overview).toBeVisible();
  await injectFiller(page, 'overview');
  await overview.evaluate((el, top) => {
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll'));
  }, TARGET_SCROLL);
  await expect.poll(() => overview.evaluate((el) => el.scrollTop)).toBe(TARGET_SCROLL);

  // --- BACKGROUND via the Header Inbox link (SPA, keep-alive) ---
  await page.getByRole('link', { name: /^Inbox$/ }).click();
  await expect(page.getByPlaceholder(/paste a pr url/i)).toBeVisible();

  // --- RETURN via the PrTabStrip pill (SPA) ---
  await page
    .locator('[data-testid="pr-tabstrip"] [data-prref="acme/api/123"] [role="tab"]')
    .click();
  await expect(overview).toBeVisible();
  await expect(page.locator('[data-app-scroll][data-detail-active]')).toHaveCount(1);

  // THE #643 CONTRACT across a full deactivate/reactivate: the Overview slot scroll is
  // restored, not reset to 0. Poll — restore runs in a layout effect after the marker
  // re-applies; Windows CI is slow.
  await expect
    .poll(() => overview.evaluate((el) => el.scrollTop), { timeout: 15000 })
    .toBe(TARGET_SCROLL);
});
