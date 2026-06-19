import { test, expect } from '@playwright/test';
import { BACKEND_ORIGIN } from './helpers/backend-origin';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

// #501 — draft PR marker visual baseline. Seeds the fake backend with a draft
// PR and captures the inbox draft row (Draft chip + draft glyph) and the
// PR-detail draft header (leading draft glyph + Draft marker chip).
//
// Skipped outside CI for the same reason as parity-baselines.spec.ts: canonical
// baselines live under __screenshots__/linux/ (CI Playwright container); local
// machines render fonts/subpixels differently and cannot match those baselines.

const VIEWPORT = { width: 1440, height: 900 };

const SCREENSHOT_OPTS = {
  maxDiffPixelRatio: 0.02,
};

const KILL_ANIMATIONS_CSS =
  '*, *::before, *::after { animation: none !important; transition: none !important; }';

test.beforeEach(async ({ request }) => {
  test.skip(!process.env.CI, 'pixel baselines are CI-only (machine-specific rendering)');
  await resetBackendState(request);
});

test.beforeEach(async ({ page }) => {
  await page.route('**/avatars.githubusercontent.com/**', (route) => route.abort());
});

test.describe('draft PR marker baselines (#501)', () => {
  test('draft inbox row shows Draft chip and draft glyph', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(VIEWPORT);

    // Seed the inbox with the scenario PR, then flip it to draft.
    const seedResp = await request.post(`${BACKEND_ORIGIN}/test/seed-inbox`, {
      headers: { Origin: BACKEND_ORIGIN },
    });
    expect(seedResp.ok()).toBeTruthy();

    const draftResp = await request.post(`${BACKEND_ORIGIN}/test/set-draft`, {
      data: { isDraft: true },
      headers: { Origin: BACKEND_ORIGIN },
    });
    expect(draftResp.ok()).toBeTruthy();

    await setupAndOpenScenarioPr(page);
    // setupAndOpenScenarioPr can transiently bounce to /setup if the
    // AuthGuard re-evaluates before fake-mode settles — re-navigate to / once
    // more (token is accepted by now) so the populated Inbox renders.
    await page.goto('/');

    // Wait for the draft row. Its aria-label is:
    //   "Calc utilities · acme/api · draft · iteration 3"
    // The "draft" word comes from InboxRow's glyphState derivation (#501).
    const row = page.getByRole('button', { name: /Calc utilities.*draft/i });
    await row.waitFor({ timeout: 45_000 });

    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(row).toHaveScreenshot('inbox-draft-row.png', SCREENSHOT_OPTS);
  });

  test('draft PR-detail header shows leading draft glyph and Draft marker', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(VIEWPORT);

    // Seed the inbox so setupAndOpenScenarioPr can navigate to /pr/acme/api/123,
    // then mark the PR as a draft before opening it.
    const seedResp = await request.post(`${BACKEND_ORIGIN}/test/seed-inbox`, {
      headers: { Origin: BACKEND_ORIGIN },
    });
    expect(seedResp.ok()).toBeTruthy();

    const draftResp = await request.post(`${BACKEND_ORIGIN}/test/set-draft`, {
      data: { isDraft: true },
      headers: { Origin: BACKEND_ORIGIN },
    });
    expect(draftResp.ok()).toBeTruthy();

    await setupAndOpenScenarioPr(page);
    await page.goto('/pr/acme/api/123');

    const header = page.locator('[data-testid="pr-header"]');
    await header.waitFor({ timeout: 45_000 });

    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(header).toHaveScreenshot('pr-detail-draft-header.png', SCREENSHOT_OPTS);
  });
});
