import { test, expect, type Route } from '@playwright/test';
import { setupBaseRoutes } from './helpers/base-mocks';
import { makeDefaultPreferences } from './fixtures/preferences';

// ---------------------------------------------------------------------------
// Fixtures — the preferences shape is the canonical one (#332); this spec adds
// only the mutable-store POST handler below so toggles persist across reloads.
// ---------------------------------------------------------------------------

type Preferences = ReturnType<typeof makeDefaultPreferences>;
type SectionId = keyof Preferences['inbox']['sections'];

// ---------------------------------------------------------------------------
// Shared mock wiring with a mutable preferences store so toggles persist
// across reloads (the spec asserts inbox-section toggle persistence).
// ---------------------------------------------------------------------------

async function setupSettingsMocks(page: import('@playwright/test').Page) {
  const store: Preferences = makeDefaultPreferences();

  await setupBaseRoutes(page);

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
        } else if (key === 'ui.ai.mode' && typeof value === 'string') {
          store.ui.aiMode = value as 'off' | 'preview' | 'live';
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

  return { store };
}

test.use({ viewport: { width: 1280, height: 800 } });

// ---------------------------------------------------------------------------

test('Settings modal renders all four section headings across its panes', async ({ page }) => {
  await setupSettingsMocks(page);
  // #134: Settings is now a modal with routed panes — each section heading lives
  // on its own pane, reached by navigating the modal nav. Assert each in turn.
  await page.goto('/settings/appearance');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: /appearance/i, level: 2 })).toBeVisible();

  // Scope nav clicks to the dialog: the Header also has an "Inbox" link, so an
  // unscoped getByRole('link', { name: 'Inbox' }) is a strict-mode violation.
  await dialog.getByRole('link', { name: 'Inbox' }).click();
  await expect(page.getByRole('heading', { name: /^inbox$/i, level: 2 })).toBeVisible();

  await dialog.getByRole('link', { name: 'GitHub Connection' }).click();
  await expect(page.getByRole('heading', { name: /github connection/i, level: 2 })).toBeVisible();

  await dialog.getByRole('link', { name: 'Files & logs' }).click();
  await expect(page.getByRole('heading', { name: /files & logs/i, level: 2 })).toBeVisible();
});

// ---------------------------------------------------------------------------

test('toggling an inbox section persists across reload', async ({ page }) => {
  await setupSettingsMocks(page);
  // #134: inbox-section switches live on the Inbox pane of the Settings modal.
  await page.goto('/settings/inbox');

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
  await page.goto('/settings/appearance');

  // #134: theme is now a SegmentedControl (role="radio"), not a native <select>.
  // System theme resolves to light or dark based on the matchMedia hint;
  // setting it explicitly avoids matching the system noise.
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark', { timeout: 5_000 });

  await page.getByRole('radio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

// ---------------------------------------------------------------------------

test('Copy config.json path button writes the path to the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await setupSettingsMocks(page);
  // #134: copy-path buttons live on the Files & logs (system) pane.
  await page.goto('/settings/system');

  await page.getByRole('button', { name: /copy config\.json path/i }).click();
  // The text was rendered into the read-only input — assert clipboard matches.
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe('/Users/x/AppData/Local/PRism/config.json');
});
