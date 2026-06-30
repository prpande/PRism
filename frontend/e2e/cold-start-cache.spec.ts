import { test, expect } from '@playwright/test';

// #619 cold-start inbox cache — runs ONLY under playwright.coldstart.config.ts (port 5210),
// whose backend boots with a DataDir pre-seeded (at config-parse time, BEFORE the webServer
// starts) with a real inbox-snapshot.json IdentityKeyedFileCache envelope + matching config
// identity + committed token. That runs the production InboxCacheRehydrator.StartAsync →
// TryRehydrate path for real at boot — NO test-only shim. Proof: the FIRST GET /api/inbox is
// stale:true with the cached row, with no /api/inbox/refresh and no /test/cold-start-rehydrate.
const ORIGIN = 'http://localhost:5210';

test('cold start: real boot-time rehydrator paints the stale inbox, then live-reconciles', async ({
  page,
  request,
}) => {
  // Flip InboxSeeded WITHOUT a refresh, so the boot-rehydrated snapshot the FE first observes is
  // untouched and the poller's first (subscriber-triggered) RefreshAsync reconciles to the
  // scenario PR (row kept, stale cleared) rather than wiping the inbox to empty.
  const seedRes = await request.post(`${ORIGIN}/test/seed-inbox-store-only`, {
    headers: { Origin: ORIGIN },
  });
  expect(seedRes.ok(), `seed-inbox-store-only failed: ${seedRes.status()}`).toBeTruthy();

  const firstInbox = page.waitForResponse(
    (r) => r.url().includes('/api/inbox') && r.request().method() === 'GET' && r.status() === 200,
    { timeout: 20_000 },
  );
  await page.goto('/');
  const inboxBody = (await (await firstInbox).json()) as {
    stale: boolean;
    sections: Array<{ id: string; items: unknown[] }>;
  };
  expect(inboxBody.stale, 'first /api/inbox must be the rehydrated stale snapshot').toBe(true);
  const total = inboxBody.sections.reduce((n, s) => n + s.items.length, 0);
  expect(total, 'rehydrated snapshot must carry the seeded row').toBeGreaterThan(0);

  await expect(page.locator('[data-testid="inbox-row"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="inbox-skeleton"]')).toHaveCount(0);

  await expect(page.getByTestId('activity-rail')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="activity-row"]').first()).toBeVisible({
    timeout: 15_000,
  });

  const loadingBar = page.getByTestId('inbox-loading-bar');
  await expect(loadingBar).toHaveAttribute('data-active', 'false', { timeout: 20_000 });
  await expect(page.locator('[data-testid="inbox-row"]').first()).toBeVisible();
});
