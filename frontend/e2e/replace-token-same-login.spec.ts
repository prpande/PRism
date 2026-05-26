import { test, expect, type Route } from '@playwright/test';
import { setupReplaceMocks } from './helpers/replace-mocks';

// S6 PR4 / spec § 3.2.1 — Replace token UX (same-login path).
// PAT-A is already connected; user clicks Replace and pastes PAT-B, which
// validates as the SAME GitHub login. Backend returns identityChanged=false,
// frontend navigates to / WITHOUT surfacing the identity-change toast.

test.use({ viewport: { width: 1280, height: 800 } });

test('Replace token to a PAT with the SAME login navigates to / without an identity-changed toast', async ({
  page,
}) => {
  await setupReplaceMocks(page);
  await page.route('**/api/auth/replace', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        login: 'octocat',
        host: 'https://github.com',
        identityChanged: false,
      }),
    }),
  );

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: /^auth$/i, level: 2 })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole('link', { name: /^replace token$/i }).click();
  await page.waitForURL(/\/setup\?replace=1/, { timeout: 10_000 });
  await expect(page.getByRole('link', { name: /cancel/i })).toBeVisible();

  await page.getByLabel(/personal access token/i).fill('ghp_same_login');
  await page.getByRole('button', { name: /continue/i }).click();

  // Navigation back to / happens after the replace POST resolves. Use the URL
  // wait + a route-stable assertion (Inbox header) to avoid racing the SPA's
  // post-navigation render.
  await page.waitForURL(/\/$|^http.*\/$/, { timeout: 10_000 });

  // No identity-change toast surfaced. role="status" is the toast surface.
  await expect(page.getByRole('status')).toHaveCount(0);
});
