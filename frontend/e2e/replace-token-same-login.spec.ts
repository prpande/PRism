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

  // #134: Replace-token lives on the GitHub Connection pane of the Settings modal.
  await page.goto('/settings/github-connection');
  await expect(page.getByRole('heading', { name: /github connection/i, level: 2 })).toBeVisible({
    timeout: 30_000,
  });

  // #130/#134: authed chrome is the Inbox nav tab + the Header Settings gear
  // (aria-label "Settings", a top-level link, not inside <nav>). No Setup tab.
  const headerNav = page.locator('header nav');
  await expect(headerNav.getByRole('link', { name: /^inbox$/i })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
  await expect(headerNav.getByRole('link', { name: /^setup$/i })).toHaveCount(0);
  // Active-state highlighting (spec B1) — on /settings/*, the gear is current,
  // Inbox is not.
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(headerNav.getByRole('link', { name: /^inbox$/i })).not.toHaveAttribute(
    'aria-current',
    'page',
  );

  await page.getByRole('link', { name: /^replace token$/i }).click();
  await page.waitForURL(/\/setup\?replace=1/, { timeout: 10_000 });
  await expect(page.getByRole('link', { name: /cancel/i })).toBeVisible();

  // #130: replace-from-Settings is an authed state — the Settings gear stays
  // active even though the path is /setup, and there is still no Setup tab.
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('header nav').getByRole('link', { name: /^setup$/i })).toHaveCount(0);

  await page.getByLabel(/personal access token/i).fill('ghp_same_login');
  await page.getByRole('button', { name: /continue/i }).click();

  // Navigation back to / happens after the replace POST resolves. Use the URL
  // wait + a route-stable assertion (Inbox header) to avoid racing the SPA's
  // post-navigation render.
  await page.waitForURL(/\/$|^http.*\/$/, { timeout: 10_000 });

  // No identity-change toast surfaced. Filter the role="status" toast surface
  // by its identity-change copy (matching the sibling different-login spec) so
  // this does not race the Inbox first-load spinner, which is also role="status"
  // (#125) while /api/inbox resolves.
  await expect(page.getByRole('status').filter({ hasText: /connected as/i })).toHaveCount(0);
});
