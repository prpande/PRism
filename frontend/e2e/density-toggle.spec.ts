import { test, expect, type Route } from '@playwright/test';
import { makeDefaultPreferences, type DensityPreferences } from './fixtures/preferences';
import { setupBaseRoutes } from './helpers/base-mocks';

// PR9b-density (D97 closure): the density picker in Settings flips the
// <html data-density="..."> attribute, persists through /api/preferences →
// ConfigStore → config.json, and survives a reload. Pattern mirrors the
// existing settings-flow.spec.ts mock wiring for theme — same /api/preferences
// + /api/auth/state route stubs, mutable store so toggles persist across
// reload(), no real backend.

async function setupMocks(page: import('@playwright/test').Page, opts?: { postFails?: boolean }) {
  const store: DensityPreferences = makeDefaultPreferences();

  await setupBaseRoutes(page);

  await page.route('**/api/preferences', async (route: Route) => {
    if (route.request().method() === 'POST') {
      if (opts?.postFails) {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'forced for test' }),
        });
      }
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

  return { store };
}

test.use({ viewport: { width: 1280, height: 800 } });

test('toggling density flips data-density and persists across reload', async ({ page }) => {
  test.setTimeout(60_000);
  await setupMocks(page);
  // #134: density is a SegmentedControl (role="radio") on the appearance pane.
  await page.goto('/settings/appearance');

  // Baseline: comfortable is the default — no attribute on <html>.
  await expect(page.locator('html')).not.toHaveAttribute('data-density', /.+/, { timeout: 30_000 });

  // Toggle to compact — optimistic apply lands before the POST resolves.
  // Wait for the POST to fully land so the mock store is mutated BEFORE the
  // reload's GET fires; otherwise slow CI runners race the reload ahead of
  // the in-flight POST and read the pre-mutation store (memory:
  // feedback_windows_ci_fixed_delay_flake).
  const postPromise = page.waitForResponse(
    (r) => r.url().includes('/api/preferences') && r.request().method() === 'POST',
  );
  await page.getByRole('radio', { name: 'Compact' }).click();
  await postPromise;
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');

  // Reload — POST persisted to the mock store; the next GET returns density=compact;
  // HeaderControls mount-effect re-applies on the new page.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact', {
    timeout: 10_000,
  });

  // Toggle back to comfortable — attribute removed. Symmetric waitForResponse
  // for consistency with the compact arm above; otherwise a silently-dropped
  // POST could pass via the optimistic-apply rollback path and mask a regression.
  const postBackPromise = page.waitForResponse(
    (r) => r.url().includes('/api/preferences') && r.request().method() === 'POST',
  );
  await page.getByRole('radio', { name: 'Comfortable' }).click();
  await postBackPromise;
  await expect(page.locator('html')).not.toHaveAttribute('data-density', /.+/);
});

test('POST failure reverts density and surfaces error toast', async ({ page }) => {
  test.setTimeout(60_000);
  await setupMocks(page, { postFails: true });
  await page.goto('/settings/appearance');

  await expect(page.locator('html')).not.toHaveAttribute('data-density', /.+/, { timeout: 30_000 });

  await page.getByRole('radio', { name: 'Compact' }).click();

  // Optimistic apply may briefly land before rollback; the assertion the spec
  // cares about is the *final* state after rollback.
  await expect(page.locator('html')).not.toHaveAttribute('data-density', /.+/, { timeout: 10_000 });

  // usePreferences shows the generic "Couldn't save preference" toast on POST failure.
  await expect(page.getByText(/Couldn't save preference/i)).toBeVisible({ timeout: 5_000 });
});
