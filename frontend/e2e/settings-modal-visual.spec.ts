import { test, expect, type Route, type Page } from '@playwright/test';
import {
  authedAuthState,
  allOffCapabilities,
  makeDefaultPreferences,
} from './fixtures/preferences';

// B1 visual gate for the #134 Settings redesign. The app gates /settings/* behind
// auth, so — like the other Settings specs — we mock the auth/preferences/
// capabilities/events surface via page.route so the modal renders hermetically.
async function setupMocks(page: Page) {
  const store = makeDefaultPreferences();
  await page.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );
  await page.route('**/api/preferences', async (route: Route) => {
    if (route.request().method() === 'POST') {
      const body = (await route.request().postDataJSON()) as Record<string, unknown>;
      for (const [key, value] of Object.entries(body)) {
        if (key === 'theme' && typeof value === 'string')
          store.ui.theme = value as typeof store.ui.theme;
        else if (key === 'accent' && typeof value === 'string')
          store.ui.accent = value as typeof store.ui.accent;
        else if (key === 'density' && typeof value === 'string')
          store.ui.density = value as typeof store.ui.density;
        else if (key === 'ui.ai.mode' && typeof value === 'string')
          store.ui.aiMode = value as 'off' | 'preview' | 'live';
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
  await page.route('**/api/submit/in-flight', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ inFlight: false, prRef: null }),
    }),
  );
  await page.route('**/api/events', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ':heartbeat\n\n' }),
  );
}

const THEMES = [
  { theme: 'light', radio: 'Light' },
  { theme: 'dark', radio: 'Dark' },
] as const;

// Drive theme the way a user does — click the Appearance segmented control — so
// the real applyThemeToDocument path runs (theme + accent vars together).
async function setTheme(page: Page, radioName: string) {
  await page.goto('/settings/appearance');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('radio', { name: radioName }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', radioName.toLowerCase());
}

test.beforeEach(async ({ page }) => {
  await setupMocks(page);
});

for (const { theme, radio } of THEMES) {
  test(`settings modal — appearance (${theme})`, async ({ page }) => {
    await setTheme(page, radio);
    await expect(page).toHaveScreenshot(`settings-appearance-${theme}.png`);
  });

  test(`settings modal — github connection (${theme})`, async ({ page }) => {
    await setTheme(page, radio);
    await page.getByRole('link', { name: 'GitHub Connection' }).click();
    await expect(page.getByRole('heading', { name: 'GitHub Connection' })).toBeVisible();
    await expect(page).toHaveScreenshot(`settings-ghc-${theme}.png`);
  });
}

test('settings modal — narrow viewport collapses the nav', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await page.goto('/settings/appearance');
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page).toHaveScreenshot('settings-narrow.png');
});
