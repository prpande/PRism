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

// Regression guard for the refreshing-bar restore: while the rehydrated snapshot is stale and
// its revalidation is still in flight, the top LoadingBar must be pinned ON (over content, not
// the skeleton). The server-side reconcile is near-instant under the fake backend, so we hold the
// browser-visible snapshot stale via a route override — a deterministic stand-in for the seconds
// a real GitHub pull takes — to observe the bar without racing the reconcile.
test('cold start: refreshing bar is pinned on over content while the snapshot stays stale', async ({
  page,
  request,
}) => {
  const seedRes = await request.post(`${ORIGIN}/test/seed-inbox-store-only`, {
    headers: { Origin: ORIGIN },
  });
  expect(seedRes.ok(), `seed-inbox-store-only failed: ${seedRes.status()}`).toBeTruthy();

  // Force every browser-visible /api/inbox GET to report stale:true, so the FE never leaves the
  // "revalidating" state (the server's own poller reconciles independently — this only pins what
  // the browser observes). failing stays false until the 30s reachability watchdog, so the bar
  // holds ON the whole time.
  await page.route('**/api/inbox', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const resp = await route.fetch();
    const json = await resp.json();
    json.stale = true;
    await route.fulfill({ response: resp, json });
  });

  await page.goto('/');

  // Content, not skeleton — the bar overlays the real rehydrated rows.
  await expect(page.locator('[data-testid="inbox-row"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="inbox-skeleton"]')).toHaveCount(0);
  await expect(page.getByTestId('inbox-loading-bar')).toHaveAttribute('data-active', 'true', {
    timeout: 15_000,
  });
});
