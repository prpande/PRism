import { test, expect, request } from '@playwright/test';

import {
  resetBackendState,
  setupAndOpenScenarioPr,
  createInlineDraft,
  recordPrViewed,
  setBeginDelay,
  injectSubmitFailure,
  SubmitMethod,
  advanceHead,
} from './helpers/s5-submit';

// Plan Task 65 — DoD test (e): the organic stale-commitOID recovery path.
//
// 1. A local draft → first submit fails at AttachThreads → the dialog's
//    failed-state Cancel stamps session.pendingReviewId at the OLD head (the
//    fake's BeginPendingReviewAsync anchored its pending review there).
// 2. A new head is pushed (a method appended; the line-3 `Add` line stays
//    intact so the draft stays anchored — Draft, not Stale). Re-record
//    "viewed at head" against the new head so the submit head-sha-drift gate
//    passes, then reload.
// 3. Re-fire submit (via the in-progress badge, which opens straight into the
//    resume path) → the pipeline finds the persisted pending review anchored
//    to the stale commit → StaleCommitOidBanner ("Recreating the review") →
//    "Recreate and resubmit" (enabled — no drift after the reload) → a fresh
//    review at the new head → attach the draft → finalize → success.
//
// IMPLEMENTATION NOTE: the POST /api/pr/{ref}/reload (and the submit
// head-sha-drift gate) compare the request's head against the ActivePrCache,
// which the ActivePrPoller background service refreshes on a 1s cadence — so
// right after advanceHead a /reload (or a submit) can transiently 409 / 400
// `head-sha-drift`. We poll the /reload until it succeeds (the poller has
// caught up), which also stamps session.LastViewedHeadSha to the new head, so
// the subsequent submit's gate passes. PrDetailLoader re-fetches the detail at
// the new head on the next GET (its cache keys on head sha), so `notReloadedYet`
// clears on its own.

const NEW_HEAD = '4'.repeat(40);
const CALC_WITH_HALF =
  'namespace Acme;\npublic static class Calc {\n  public static int Add(int a, int b) => a + b;\n  public static int Half(int a) => a / 2;\n}\n';

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await setBeginDelay(ctx, 120);
  await ctx.dispose();
});

test('S5 stale commit OID — first submit fails, head moves, recreate-and-resubmit converges', async ({
  page,
}) => {
  await setupAndOpenScenarioPr(page);
  await createInlineDraft(page, 3, 'draft for stale path');
  await recordPrViewed(page.request);

  // First submit: stop after Begin (fail at AttachThreads) so a pending review
  // is created and anchored to the current (old) head.
  await injectSubmitFailure(page.request, SubmitMethod.AttachThread, { message: 'stop after Begin' });
  await page.goto('/pr/acme/api/123');
  await page.getByRole('button', { name: /^submit review$/i }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^confirm submit$/i }).click();
  await expect(dialog.getByRole('heading', { name: /^submit failed at /i })).toBeVisible({
    timeout: 15_000,
  });
  await dialog.getByRole('button', { name: /^cancel$/i }).click();
  await expect(dialog).toHaveCount(0);

  // Push a new head — appends `Half`, keeps the line-3 `Add` line so the draft
  // stays anchored.
  await advanceHead(page.request, NEW_HEAD, [{ path: 'src/Calc.cs', content: CALC_WITH_HALF }]);
  // Reload against the new head, retrying until the ActivePrPoller has caught up
  // (a 409 `reload-stale-head` means it hasn't yet). A successful /reload stamps
  // session.LastViewedHeadSha = NEW_HEAD, which the submit gate then accepts.
  await expect
    .poll(
      async () => {
        const r = await page.request.post('/api/pr/acme/api/123/reload', {
          data: { headSha: NEW_HEAD },
          headers: { Origin: 'http://localhost:5180' },
        });
        return r.status();
      },
      { timeout: 15_000, intervals: [500] },
    )
    .toBe(200);
  await page.reload();

  // The submit-in-progress badge surfaces (session.pendingReviewId is set).
  // Click it → the dialog opens into the resume path.
  const badge = page.getByRole('button', { name: 'Submit in progress — Resume?' });
  await expect(badge).toBeVisible({ timeout: 10_000 });
  await badge.click();

  // The pipeline detects the stale pending review → the recreate banner.
  const staleBanner = page.locator('.stale-commit-oid-banner');
  await expect(staleBanner).toBeVisible({ timeout: 15_000 });
  await expect(staleBanner).toContainText(/Recreating the review/i);

  const recreate = staleBanner.getByRole('button', { name: /^recreate and resubmit$/i });
  await expect(recreate).toBeEnabled();
  await recreate.click();

  // Fresh review at the new head → attach the draft → finalize → success.
  await expect(page.getByRole('heading', { name: /review submitted/i })).toBeVisible({
    timeout: 15_000,
  });
});
