// frontend/e2e/feedback.spec.ts
// #211: /feedback routed modal — three scenarios:
//   (a) authed + github.com → POST /api/feedback → 422 cannot-create → offer-link state
//   (b) authed user reaches /feedback via the Help modal "Send feedback" link
//   (c) first-run (hasToken:false) navigates directly to /feedback → dialog visible, link-only
//
// Auth bootstrap mirrors help.spec.ts: page.route mocks for /api/auth/state,
// /api/preferences, /api/capabilities, and /api/events. The backend runs in
// Test/FakeReviewService mode so no real PAT is needed.

import { test, expect, type Route } from '@playwright/test';
import { setupBaseRoutes } from './helpers/base-mocks';
import { makeDefaultPreferences } from './fixtures/preferences';

// ---------------------------------------------------------------------------
// Shared mock fixtures — canonical preferences (#332); these tests never assert
// the github paths, so the canonical values stand in for the old /fake/* ones.
// ---------------------------------------------------------------------------

const defaultPreferences = makeDefaultPreferences();

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

async function setupInboxMock(page: import('@playwright/test').Page): Promise<void> {
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
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Feedback modal (#211)', () => {
  // #430: dedicated header entry point (bug icon), visible only when authed →
  // opens the feedback modal over the inbox in one click. Mirrors the header
  // Help-icon test in help.spec.ts. Query by role=link: on /feedback the dialog
  // and its submit button also carry a "send feedback" accessible name, so a bare
  // /feedback/i text query would be ambiguous once the modal mounts.
  test('authed user reaches /feedback via the header bug icon — modal opens over inbox', async ({
    page,
  }) => {
    await setupBaseMocks(page);
    await setupInboxMock(page);

    await page.goto('/');

    const feedbackLink = page.getByRole('link', { name: /send feedback/i });
    await expect(feedbackLink).toBeVisible({ timeout: 30_000 });
    await feedbackLink.click();

    await expect(page).toHaveURL(/\/feedback$/);
    await expect(page.getByRole('dialog', { name: /send feedback/i })).toBeVisible();
    // Inbox stays behind the scrim (modal opened over it, not a blank background).
    await expect(page.getByTestId('inbox-page')).toBeVisible();
  });

  test('authed + github.com: 422 cannot-create transitions to offer-link state', async ({
    page,
  }) => {
    await setupBaseMocks(page);
    await setupInboxMock(page);

    // Stub /api/feedback → 422 cannot-create
    await page.route('**/api/feedback', (route: Route) =>
      route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'cannot-create' }),
      }),
    );

    await page.goto('/feedback');

    const dialog = page.getByRole('dialog', { name: /send feedback/i });
    await expect(dialog).toBeVisible({ timeout: 30_000 });

    // Submit button is disabled until all fields are filled.
    // The initial submitLabel for authed+github.com is "Send feedback".
    const submitBtn = dialog.getByRole('button', { name: /send feedback/i });
    await expect(submitBtn).toBeDisabled();

    // Category defaults to "Bug" (SegmentedControl first option).
    // Fill Summary and Details via their <label> associations.
    await dialog.getByLabel(/summary/i).fill('Test bug report');
    await dialog.getByLabel(/details/i).fill('Steps to reproduce the issue in detail here.');

    // Now submit should be enabled.
    await expect(submitBtn).toBeEnabled();

    // Click submit — the route mock returns 422 → component transitions to offer-link.
    // The modal title changes to "Open on GitHub" and the form is replaced with the offer state.
    await submitBtn.click();

    // After 422, the dialog title transitions to "Open on GitHub" (offer-link state).
    // The accessible name of the dialog changes, so scope to testid instead.
    const scrim = page.getByTestId('feedback-scrim');
    await expect(scrim.getByRole('button', { name: /open on github/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('authed user reaches /feedback via the Help modal "Send feedback" link', async ({
    page,
  }) => {
    await setupBaseMocks(page);
    await setupInboxMock(page);

    await page.goto('/help');

    const helpDialog = page.getByRole('dialog', { name: /help/i });
    await expect(helpDialog).toBeVisible({ timeout: 30_000 });

    // The "Send feedback" section is collapsed by default — expand it.
    const feedbackSectionBtn = helpDialog.getByRole('button', { name: /send feedback/i });
    const isExpanded = await feedbackSectionBtn.getAttribute('aria-expanded');
    if (isExpanded !== 'true') {
      await feedbackSectionBtn.click();
    }

    // Click the "Send feedback" link inside the expanded section body.
    // The section body renders a <Link> with text "Send feedback".
    await helpDialog.getByRole('link', { name: /send feedback/i }).click();

    // Navigating to /feedback unmounts the Help modal and mounts the Feedback dialog.
    await expect(page).toHaveURL(/\/feedback$/);
    await expect(page.getByRole('dialog', { name: /send feedback/i })).toBeVisible({
      timeout: 30_000,
    });
  });

  test('first-run (no token): /feedback shows the dialog in link-only mode', async ({ page }) => {
    // No-token first run: use link-only path (no /api/feedback call expected).
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

    await page.goto('/feedback');

    const dialog = page.getByRole('dialog', { name: /send feedback/i });
    await expect(dialog).toBeVisible({ timeout: 30_000 });

    // In link-only mode the submit button label is "Open on GitHub" (not "Send feedback").
    const submitBtn = dialog.getByRole('button', { name: /open on github/i });
    await expect(submitBtn).toBeVisible();

    // Submit is disabled until all fields are filled.
    await expect(submitBtn).toBeDisabled();

    // Fill fields and confirm the button becomes enabled.
    await dialog.getByLabel(/summary/i).fill('Suggestion from first-run user');
    await dialog.getByLabel(/details/i).fill('Here are the details of my suggestion.');
    await expect(submitBtn).toBeEnabled();
  });
});
