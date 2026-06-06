// frontend/e2e/help.spec.ts
// #210: /help page reachability — two entry points:
//   (a) header ? icon, visible only when authed
//   (b) direct navigation to /help (auth-agnostic route)
//
// Auth bootstrap mirrors inbox.spec.ts: page.route mocks for /api/auth/state,
// /api/preferences, /api/capabilities, and /api/events. The backend runs in
// Test/FakeReviewService mode so no real PAT is needed.

import { test, expect, type Route } from '@playwright/test';

// ---------------------------------------------------------------------------
// Shared mock fixtures (matches inbox.spec.ts shape)
// ---------------------------------------------------------------------------

const authedAuthState = {
  hasToken: true,
  host: 'https://github.com',
  hostMismatch: null,
};

const defaultPreferences = {
  ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable' },
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
    configPath: '/fake/config.json',
    logsPath: '/fake/logs',
  },
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

async function setupBaseMocks(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );
  await page.route('**/api/preferences', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(defaultPreferences),
    }),
  );
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
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Help page (#210)', () => {
  test('authed user reaches /help via the header ? icon', async ({ page }) => {
    await setupBaseMocks(page);
    // Also stub /api/inbox so the inbox page doesn't hang on a real network call
    // after auth completes and the app navigates to /.
    await page.route('**/api/inbox', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sections: [], enrichments: {}, lastRefreshedAt: new Date().toISOString(), tokenScopeFooterEnabled: false }),
      }),
    );

    await page.goto('/');

    // The header ? (Help) link is visible only when authed.
    const helpLink = page.getByRole('link', { name: 'Help' });
    await expect(helpLink).toBeVisible({ timeout: 30_000 });
    await helpLink.click();

    await expect(page).toHaveURL(/\/help$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible();
  });

  test('/help renders directly (auth-agnostic route)', async ({ page }) => {
    await setupBaseMocks(page);
    await page.goto('/help');
    await expect(page.getByTestId('help-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible();
  });
});
