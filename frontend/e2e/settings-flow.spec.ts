import { test, expect, type Route } from '@playwright/test';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
type SectionId = keyof Preferences['inbox']['sections'];

// ---------------------------------------------------------------------------
// Shared mock wiring with a mutable preferences store so toggles persist
// across reloads (the spec asserts inbox-section toggle persistence).
// ---------------------------------------------------------------------------

async function setupSettingsMocks(page: import('@playwright/test').Page) {
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
      // Spec § 2.3 allowlist: PATCH body is a single { [key]: value }. Bare keys
      // map onto store.ui; dotted `inbox.sections.<id>` keys onto store.inbox.sections.
      const body = (await route.request().postDataJSON()) as Record<string, unknown>;
      for (const [key, value] of Object.entries(body)) {
        if (key === 'theme' && typeof value === 'string') {
          store.ui.theme = value as Preferences['ui']['theme'];
        } else if (key === 'accent' && typeof value === 'string') {
          store.ui.accent = value as Preferences['ui']['accent'];
        } else if (key === 'aiPreview' && typeof value === 'boolean') {
          store.ui.aiPreview = value;
        } else if (key === 'density' && typeof value === 'string') {
          store.ui.density = value as Preferences['ui']['density'];
        } else if (key.startsWith('inbox.sections.')) {
          const id = key.slice('inbox.sections.'.length) as SectionId;
          if (typeof value === 'boolean' && id in store.inbox.sections) {
            store.inbox.sections[id] = value;
          }
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

// ---------------------------------------------------------------------------

test('Settings page renders all four section headings', async ({ page }) => {
  await setupSettingsMocks(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: /appearance/i, level: 2 })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('heading', { name: /inbox sections/i, level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: /connection/i, level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^auth$/i, level: 2 })).toBeVisible();
});

// ---------------------------------------------------------------------------

test('toggling an inbox section persists across reload', async ({ page }) => {
  await setupSettingsMocks(page);
  await page.goto('/settings');

  const reviewToggle = page.getByRole('switch', { name: /review requested/i });
  await expect(reviewToggle).toBeChecked({ timeout: 30_000 });
  await reviewToggle.click();
  await expect(reviewToggle).not.toBeChecked();

  await page.reload();
  const reviewAfterReload = page.getByRole('switch', { name: /review requested/i });
  await expect(reviewAfterReload).not.toBeChecked({ timeout: 30_000 });
});

// ---------------------------------------------------------------------------

test('changing the theme applies immediately to documentElement', async ({ page }) => {
  await setupSettingsMocks(page);
  await page.goto('/settings');

  // System theme resolves to light or dark based on the matchMedia hint;
  // setting it explicitly avoids matching the system noise.
  await page.getByLabel(/^theme$/i).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark', { timeout: 5_000 });

  await page.getByLabel(/^theme$/i).selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

// ---------------------------------------------------------------------------

test('Copy config.json path button writes the path to the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await setupSettingsMocks(page);
  await page.goto('/settings');

  await page.getByRole('button', { name: /copy config\.json path/i }).click();
  // The text was rendered into the read-only input — assert clipboard matches.
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe('/Users/x/AppData/Local/PRism/config.json');
});
