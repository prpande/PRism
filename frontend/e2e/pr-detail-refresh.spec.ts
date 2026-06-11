// frontend/e2e/pr-detail-refresh.spec.ts
//
// Task 9 (#344) — e2e behavior coverage + B1 visual proof for the PR-detail
// manual Refresh button.
//
// The PR-detail header (data-testid="pr-header") now renders an icon-only
// RefreshButton (data-testid="pr-refresh-button") before Open-in-GitHub. On
// click it POSTs /api/pr/{ref}/refresh, swaps the circular-arrow for a spinner,
// then (on success) briefly morphs to a checkmark (data-testid="pr-refresh-
// confirm") while an sr-only role="status" region (data-testid="pr-refresh-
// status") announces "Refreshing PR…" → "PR refreshed".
//
// Navigation/setup mirrors pr-header-actions.spec.ts: hermetic acme/api/123
// scenario PR via the FakeReviewService harness (setupAndOpenScenarioPr). The
// webServer (playwright.config.ts) auto-builds + launches the app with
// ASPNETCORE_ENVIRONMENT=Test + PRISM_E2E_FAKE_REVIEW=1; we never start a server
// here.
//
// The B1 capture block writes plain page screenshots (NOT toHaveScreenshot
// baselines — per Task 9 those would create CI-coupled baselines) of the header
// region in both themes × {idle, refreshing, confirmed} into review-assets/
// pr-344/ for the human visual gate.

import { test, expect, type Page } from '@playwright/test';
import { BACKEND_ORIGIN } from './helpers/backend-origin';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s5-submit';

const VIEWPORT_FULLHD = { width: 1920, height: 1080 };
// Playwright runs with cwd = frontend/, so the repo-root review-assets/ tree
// (where 219-group-by-repo/ et al. live) is one level up. Writing here keeps the
// B1 proof images out of the frontend bundle and beside their siblings.
const REVIEW_ASSETS_DIR = '../review-assets/pr-344';

// Drive the header into a given theme by setting <html data-theme="…"> directly
// (mirrors syntax-highlight.spec.ts). This is the same attribute the settings
// theme picker flips, but set without routing through the modal so the capture
// stays focused on the header.
async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

// Capture just the PR-detail header region (not full page) to a PNG.
async function captureHeader(page: Page, file: string): Promise<void> {
  const header = page.locator('[data-testid="pr-header"]');
  await expect(header).toBeVisible();
  await header.screenshot({ path: `${REVIEW_ASSETS_DIR}/${file}` });
}

// ---------------------------------------------------------------------------
// A. Behavior — refresh morph confirms
// ---------------------------------------------------------------------------

test.describe('#344 PR-detail manual refresh', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetBackendState(request);
    await page.setViewportSize(VIEWPORT_FULLHD);
    await setupAndOpenScenarioPr(page);
    await page.goto('/pr/acme/api/123');
    await page.waitForSelector('[data-testid="pr-header"]');
  });

  test.afterEach(async ({ request }) => {
    await resetBackendState(request);
    const tokensResp = await request.post(`${BACKEND_ORIGIN}/test/clear-tokens`, {
      headers: { Origin: BACKEND_ORIGIN },
    });
    if (!tokensResp.ok()) {
      throw new Error(
        `/test/clear-tokens failed: ${tokensResp.status()} ${await tokensResp.text()}`,
      );
    }
  });

  test('refresh button is visible and clicking it confirms a refresh', async ({ page }) => {
    const button = page.getByTestId('pr-refresh-button');
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-label', 'Refresh PR');

    // The sr-only live region starts empty.
    const status = page.getByTestId('pr-refresh-status');
    await expect(status).toHaveText('');

    await button.click();

    // Web-first: the role=status region reaches the completion announcement and
    // the checkmark morph appears. We don't assert on the brief spinner frame
    // here (no response delay) — the refreshing/confirmed B1 captures below do
    // that under a routed delay. Either completion signal arriving is success.
    await expect(status).toHaveText('PR refreshed', { timeout: 15_000 });
    await expect(page.getByTestId('pr-refresh-confirm')).toBeVisible();

    // The accessible name stays "Refresh PR" throughout (icon morphs are
    // aria-hidden; the status region carries the state change to AT).
    await expect(button).toHaveAttribute('aria-label', 'Refresh PR');
  });

  // -------------------------------------------------------------------------
  // B1 visual proof — header region, both themes × {idle, refreshing, confirmed}
  //
  // One test per theme. The in-flight spinner is captured by stalling the
  // /refresh response via page.route so the spinner stays on screen while we
  // screenshot, then releasing it to reach the checkmark.
  // -------------------------------------------------------------------------

  for (const theme of ['light', 'dark'] as const) {
    test(`B1 capture — ${theme} header: idle / refreshing / confirmed`, async ({ page }) => {
      await setTheme(page, theme);

      const button = page.getByTestId('pr-refresh-button');
      await expect(button).toBeVisible();

      // (a) Idle — the circular refresh arrow.
      await captureHeader(page, `pr-344-header-${theme}-idle.png`);

      // Gate the /refresh POST so the in-flight spinner stays on screen. We hold
      // the route handler until `release()` is called, then let it continue to
      // the real backend (which returns the empty 200).
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/api/pr/acme/api/123/refresh', async (route) => {
        await gate;
        await route.continue();
      });

      await button.click();

      // (b) In-flight — the decorative spinner is on screen (button disabled,
      // accessible name flips to the refreshing label). Capture while held.
      await expect(button).toHaveAttribute('aria-label', 'Refreshing PR…');
      await expect(button).toBeDisabled();
      await captureHeader(page, `pr-344-header-${theme}-refreshing.png`);

      // Release the held response so the refresh completes. The route handler's
      // route.continue() then forwards the (single) POST to the real backend.
      // We deliberately do NOT page.unroute here — unrouting while the handler is
      // mid-flight races route.continue() and throws "Route is already handled".
      release();

      // (c) Confirmed — the checkmark morph + completion announcement.
      await expect(page.getByTestId('pr-refresh-status')).toHaveText('PR refreshed', {
        timeout: 15_000,
      });
      await expect(page.getByTestId('pr-refresh-confirm')).toBeVisible();
      await captureHeader(page, `pr-344-header-${theme}-confirmed.png`);
    });
  }
});
