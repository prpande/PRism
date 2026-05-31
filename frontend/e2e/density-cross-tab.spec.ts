import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import {
  allOffCapabilities,
  authedAuthState,
  makeDefaultPreferences,
  type DensityPreferences,
} from './fixtures/preferences';

// PR9b-density cross-tab: toggling density in tab A propagates to tab B via the
// existing window-focus refetch contract in usePreferences (S6 PR1). Tab B's
// HeaderControls mount-effect re-applies applyDensityToDocument when the GET
// returns the new value. This spec defends the same surface PR #62 (cross-tab
// stamp poisoning fix) carved out for auth state — density is a normal
// ui-pref so it rides on the focus-refetch path, not the per-tab TabStamps map.

// Shared store across the two tabs — the mock state is per-context, not per-page,
// so a POST from tab A is visible to tab B's subsequent GETs. This mirrors the
// real backend where both tabs hit the same ConfigStore singleton.
async function setupContextMocks(context: BrowserContext) {
  const store: DensityPreferences = makeDefaultPreferences();

  await context.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );

  await context.route('**/api/preferences', async (route: Route) => {
    if (route.request().method() === 'POST') {
      const body = (await route.request().postDataJSON()) as Record<string, unknown>;
      for (const [key, value] of Object.entries(body)) {
        if (key === 'density' && typeof value === 'string') {
          store.ui.density = value as DensityPreferences['ui']['density'];
        }
      }
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(store),
    });
  });

  await context.route('**/api/capabilities', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(allOffCapabilities),
    }),
  );

  await context.route('**/api/events', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ':heartbeat\n\n' }),
  );
}

test.use({ viewport: { width: 1280, height: 800 } });

test('density toggle in tab A propagates to tab B on focus refetch', async ({ browser }) => {
  test.setTimeout(90_000);

  const context = await browser.newContext();
  try {
    await setupContextMocks(context);

    const tabA: Page = await context.newPage();
    const tabB: Page = await context.newPage();

    await tabA.goto('/settings');
    await tabB.goto('/settings');

    // Both tabs see comfortable (no attribute).
    await expect(tabA.locator('html')).not.toHaveAttribute('data-density', /.+/, {
      timeout: 30_000,
    });
    await expect(tabB.locator('html')).not.toHaveAttribute('data-density', /.+/, {
      timeout: 30_000,
    });

    // Toggle in tab A. Wait for the POST to land so the mock store is mutated
    // BEFORE tabB's focus-triggered refetch reads it. Without the wait, slow
    // Windows CI runners (memory: feedback_windows_ci_fixed_delay_flake) can
    // race the focus refetch ahead of the in-flight POST → stale read → flake.
    const postPromise = tabA.waitForResponse(
      (r) => r.url().includes('/api/preferences') && r.request().method() === 'POST',
    );
    await tabA.getByLabel('Density').selectOption('compact');
    await postPromise;
    await expect(tabA.locator('html')).toHaveAttribute('data-density', 'compact');

    // Bring tab B to the front + fire focus. usePreferences' `focus` listener
    // refetches /api/preferences → HeaderControls' useEffect on `preferences`
    // re-applies applyDensityToDocument.
    await tabB.bringToFront();
    await tabB.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(tabB.locator('html')).toHaveAttribute('data-density', 'compact', {
      timeout: 10_000,
    });
  } finally {
    // try/finally so the context is always reclaimed even if an assertion
    // above throws; Playwright eventually cleans up but explicit close keeps
    // the per-spec memory footprint deterministic on Windows runners.
    await context.close();
  }
});
