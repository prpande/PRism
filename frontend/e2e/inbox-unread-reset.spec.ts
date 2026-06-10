import { test, expect } from '@playwright/test';
import { BACKEND_ORIGIN } from './helpers/backend-origin';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

// #285 — the inbox row's left "new changes" bar must clear after the user opens the PR
// and returns to the inbox, without a manual reload. Real backend: /test/seed-inbox puts
// the canonical scenario PR (acme/api/123 "Calc utilities") in "Review requested" unread.
test.describe('inbox unread bar resets on view (#285)', () => {
  test.beforeEach(async ({ request }) => {
    await resetBackendState(request);
  });

  test('opening the PR and returning clears the row unread bar', async ({ page, request }) => {
    // Populate the real-backend inbox with the scenario PR (review-requested, unread).
    const seed = await request.post(`${BACKEND_ORIGIN}/test/seed-inbox`, {
      headers: { Origin: BACKEND_ORIGIN },
    });
    expect(seed.ok()).toBeTruthy();

    await setupAndOpenScenarioPr(page); // auths, lands on '/' (inbox now populated)

    const row = page.getByRole('button', { name: /Calc utilities/i });
    await row.waitFor({ timeout: 30_000 });
    await expect(row).toHaveAttribute('data-unread', 'true'); // never-viewed → unread

    // Open the PR. usePrDetail fires the real POST mark-viewed stamping the current head;
    // wait for it to persist before returning so the inbox refetch sees the stamp.
    const markViewed = page.waitForResponse(
      (r) =>
        /\/api\/pr\/acme\/api\/123\/mark-viewed$/.test(r.url()) && r.request().method() === 'POST',
    );
    await row.click();
    await page.waitForURL('**/pr/acme/api/123**');
    await markViewed;

    // Return to the inbox via SPA history nav (unmount → remount → GET /api/inbox overlay).
    await page.goBack();
    await page.waitForURL((url) => url.pathname === '/');

    // The overlay re-projects the fresh stamp → row is no longer unread.
    await expect(page.getByRole('button', { name: /Calc utilities/i })).toHaveAttribute(
      'data-unread',
      'false',
    );
  });
});
