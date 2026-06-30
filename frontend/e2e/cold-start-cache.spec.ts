import { test, expect } from '@playwright/test';
import { setupAndOpenScenarioPr } from './helpers/s4-setup';
import { seedInboxCache } from './helpers/coldStart';

// The cold-start-cache tests depend on the inbox being in a controlled stale state.
// Clear any PAT from a prior spec so auth state is clean before each test.
test.beforeEach(async ({ request, baseURL }) => {
  const res = await request.post(`${baseURL}/test/clear-tokens`, {
    headers: { Origin: baseURL ?? '' },
  });
  expect(res.ok(), `clear-tokens failed: ${res.status()}`).toBeTruthy();
});

test('cold start paints rehydrated inbox rows with no skeleton, then reconciles', async ({
  page,
  request,
  baseURL,
}) => {
  const origin = baseURL ?? 'http://localhost:5180';

  // Authenticate + seed the scenario PR so the FakeSectionQueryRunner returns a row on
  // the next RefreshAsync (called by /test/seed-inbox below). Also navigates to the PR page
  // which is fine — we navigate back to / in the next step.
  await setupAndOpenScenarioPr(page);

  // Arm the rehydrated-stale state: overwrites _current with a minimal cached snapshot
  // and sets _rehydratedAwaitingRevalidate=true. After this call, GET /api/inbox returns
  // the cached rows immediately with stale:true.
  await seedInboxCache(request, origin);

  // Navigate to the inbox root. The initial GET /api/inbox returns the stale snapshot
  // synchronously (no wait for a live network call), so the skeleton clears as soon as
  // the first response arrives.
  await page.goto('/');

  // Instant paint: at least one inbox row must appear. The skeleton is always present
  // briefly (while the initial fetch is in-flight), but by the time firstRow is visible
  // the fetch has completed and the skeleton branch is gone.
  const firstRow = page.locator('[data-testid="inbox-row"]').first();
  await expect(firstRow).toBeVisible({ timeout: 10_000 });

  // Confirm the skeleton cleared (can't coexist with the loaded rows branch).
  await expect(page.locator('[data-testid="inbox-skeleton"]')).toHaveCount(0);

  // Trigger the live refresh that clears the stale flag. /test/seed-inbox calls
  // orch.RefreshAsync(), which (because _rehydratedAwaitingRevalidate=true) force-notifies
  // the FE via SSE so it reloads with stale:false.
  const refreshRes = await request.post(`${origin}/test/seed-inbox`, {
    headers: { Origin: origin },
  });
  expect(refreshRes.ok(), `/test/seed-inbox failed: ${refreshRes.status()}`).toBeTruthy();

  // After the SSE-triggered reload, the loading bar must settle to inactive.
  // This proves the FE received the inbox-updated event and completed the live reconcile.
  const loadingBar = page.getByTestId('inbox-loading-bar');
  await expect(loadingBar).toHaveAttribute('data-active', 'false', { timeout: 15_000 });
});
