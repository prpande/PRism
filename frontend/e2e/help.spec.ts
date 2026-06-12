// frontend/e2e/help.spec.ts
// #210: /help modal reachability — two entry points:
//   (a) header ? icon, visible only when authed → opens modal over inbox
//   (b) direct navigation to /help (auth-agnostic) → shows dialog in every state
//
// Auth bootstrap mirrors inbox.spec.ts: page.route mocks for /api/auth/state,
// /api/preferences, /api/capabilities, and /api/events. The backend runs in
// Test/FakeReviewService mode so no real PAT is needed.

import { test, expect, type Route } from '@playwright/test';
import { setupBaseRoutes } from './helpers/base-mocks';

// ---------------------------------------------------------------------------
// Shared mock fixtures (matches inbox.spec.ts shape)
// ---------------------------------------------------------------------------

const defaultPreferences = {
  ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable' },
  inbox: {
    sections: {
      'review-requested': true,
      'awaiting-author': true,
      'authored-by-me': true,
      mentioned: true,
      'recently-closed': true,
    },
    defaultSort: 'updated',
  },
  github: {
    host: 'https://github.com',
    configPath: '/fake/config.json',
    logsPath: '/fake/logs',
  },
};

async function setupBaseMocks(page: import('@playwright/test').Page): Promise<void> {
  await setupBaseRoutes(page);
  await page.route('**/api/preferences', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(defaultPreferences),
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Help modal (#210)', () => {
  test('authed user reaches /help via the header ? icon — modal opens over inbox', async ({
    page,
  }) => {
    await setupBaseMocks(page);
    // Also stub /api/inbox so the inbox page doesn't hang on a real network call.
    await page.route('**/api/inbox', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sections: [],
          enrichments: {},
          lastRefreshedAt: new Date().toISOString(),
          tokenScopeFooterEnabled: false,
        }),
      }),
    );

    await page.goto('/');

    // The header ? (Help) link is visible only when authed.
    const helpLink = page.getByRole('link', { name: 'Help' });
    await expect(helpLink).toBeVisible({ timeout: 30_000 });
    await helpLink.click();

    await expect(page).toHaveURL(/\/help$/);
    // The Help modal dialog is visible
    await expect(page.getByRole('dialog', { name: /help/i })).toBeVisible();
  });

  test('/help renders as a dialog over the inbox background when navigated directly (authed)', async ({
    page,
  }) => {
    await setupBaseMocks(page);
    await page.route('**/api/inbox', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sections: [],
          enrichments: {},
          lastRefreshedAt: new Date().toISOString(),
          tokenScopeFooterEnabled: false,
        }),
      }),
    );

    await page.goto('/help');
    // Modal dialog is visible
    await expect(page.getByRole('dialog', { name: /help/i })).toBeVisible({ timeout: 30_000 });
    // Inbox is rendered behind it (the background)
    await expect(page.getByTestId('inbox-page')).toBeVisible();
  });

  test('first-run user reaches the Help modal from the /welcome footer — opens over welcome', async ({
    page,
  }) => {
    // No-token first run: the nav is hidden, so the welcome footer is the entry point.
    await page.route('**/api/auth/state', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hasToken: false, host: 'https://github.com', hostMismatch: null }),
      }),
    );
    await page.route('**/api/events', (route: Route) =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ':heartbeat\n\n' }),
    );

    await page.goto('/welcome');
    await page.getByRole('link', { name: /^help$/i }).click();

    await expect(page).toHaveURL(/\/help$/);
    await expect(page.getByRole('dialog', { name: /help/i })).toBeVisible();
    // The welcome screen stays behind the scrim (modal opened over it, not a blank bg).
    await expect(page.getByTestId('welcome-card')).toBeVisible();
  });
});
