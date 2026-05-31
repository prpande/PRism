import { test, expect, type Route } from '@playwright/test';

// PR9b-density (D97 closure): the density picker in Settings flips the
// <html data-density="..."> attribute, persists through /api/preferences →
// ConfigStore → config.json, and survives a reload. Pattern mirrors the
// existing settings-flow.spec.ts mock wiring for theme — same /api/preferences
// + /api/auth/state route stubs, mutable store so toggles persist across
// reload(), no real backend.

const authedAuthState = {
  hasToken: true,
  host: 'https://github.com',
  hostMismatch: null,
};

const allOffCapabilities = {
  ai: {
    summary: false,
    fileFocus: false,
    hunkAnnotations: false,
    preSubmitValidators: false,
    composerAssist: false,
    draftSuggestions: false,
    draftReconciliation: false,
    inboxEnrichment: false,
    inboxRanking: false,
  },
};

function makeDefaultPreferences() {
  return {
    ui: {
      theme: 'system' as const,
      accent: 'indigo' as const,
      aiPreview: false,
      density: 'comfortable' as const,
    },
    inbox: {
      sections: {
        'review-requested': true,
        'awaiting-author': true,
        'authored-by-me': true,
        mentioned: true,
        'ci-failing': true,
      },
    },
    github: {
      host: 'https://github.com',
      configPath: '/Users/x/AppData/Local/PRism/config.json',
      logsPath: '/Users/x/AppData/Local/PRism/logs',
    },
  };
}

type Preferences = ReturnType<typeof makeDefaultPreferences>;

async function setupMocks(page: import('@playwright/test').Page, opts?: { postFails?: boolean }) {
  const store: Preferences = makeDefaultPreferences();

  await page.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );

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
          store.ui.density = value as Preferences['ui']['density'];
        }
      }
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(store),
    });
  });

  await page.route('**/api/capabilities', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(allOffCapabilities),
    }),
  );

  await page.route('**/api/events', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ':heartbeat\n\n' }),
  );

  return { store };
}

test.use({ viewport: { width: 1280, height: 800 } });

test('toggling density flips data-density and persists across reload', async ({ page }) => {
  test.setTimeout(60_000);
  await setupMocks(page);
  await page.goto('/settings');

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
  await page.getByLabel('Density').selectOption('compact');
  await postPromise;
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');

  // Reload — POST persisted to the mock store; the next GET returns density=compact;
  // HeaderControls mount-effect re-applies on the new page.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact', {
    timeout: 10_000,
  });

  // Toggle back to comfortable — attribute removed.
  await page.getByLabel('Density').selectOption('comfortable');
  await expect(page.locator('html')).not.toHaveAttribute('data-density', /.+/);
});

test('POST failure reverts density and surfaces error toast', async ({ page }) => {
  test.setTimeout(60_000);
  await setupMocks(page, { postFails: true });
  await page.goto('/settings');

  await expect(page.locator('html')).not.toHaveAttribute('data-density', /.+/, { timeout: 30_000 });

  await page.getByLabel('Density').selectOption('compact');

  // Optimistic apply may briefly land before rollback; the assertion the spec
  // cares about is the *final* state after rollback.
  await expect(page.locator('html')).not.toHaveAttribute('data-density', /.+/, { timeout: 10_000 });

  // usePreferences shows the generic "Couldn't save preference" toast on POST failure.
  await expect(page.getByText(/Couldn't save preference/i)).toBeVisible({ timeout: 5_000 });
});
