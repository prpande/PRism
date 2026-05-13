import { test, expect, request } from '@playwright/test';

import {
  resetBackendState,
  setupAndOpenScenarioPr,
  createInlineDraft,
  recordPrViewed,
  setBeginDelay,
  injectSubmitFailure,
  SubmitMethod,
  inspectPendingReview,
} from './helpers/s5-submit';

// Plan Task 66 — the lost-response adoption path. AttachThreadAsync commits the
// thread server-side (with the pipeline's `<!-- prism:client-id:<draftId> -->`
// marker) but then throws — the client never gets the result, so the draft
// stays unstamped locally while an orphan thread carrying its marker exists on
// the pending review. On Retry the pipeline re-fetches the pending review,
// matches the orphan by marker, ADOPTS it (no second AttachThreadAsync), and
// finalizes. No duplicate thread.

const PR = { owner: 'acme', repo: 'api', number: 123 };

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await setBeginDelay(ctx, 120);
  await ctx.dispose();
});

test('S5 lost AttachThread response — Retry adopts the orphan thread, no duplicate', async ({
  page,
}) => {
  await setupAndOpenScenarioPr(page);
  await createInlineDraft(page, 3, 'draft whose AttachThread response gets lost');
  await recordPrViewed(page.request);

  // afterEffect=true → the fake adds the thread (with the injected marker) and
  // THEN throws.
  await injectSubmitFailure(page.request, SubmitMethod.AttachThread, {
    afterEffect: true,
    message: 'lost response — server created the thread, client never got the result',
  });

  await page.goto('/pr/acme/api/123');
  await page.getByRole('button', { name: /^submit review$/i }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^confirm submit$/i }).click();

  await expect(dialog.getByRole('heading', { name: /^submit failed at /i })).toBeVisible({
    timeout: 15_000,
  });

  // Retry: the pipeline finds the orphan thread carrying the draft's marker and
  // adopts it (no second AttachThreadAsync), then finalizes.
  await dialog.getByRole('button', { name: /^retry$/i }).click();
  await expect(page.getByRole('heading', { name: /review submitted/i })).toBeVisible({
    timeout: 15_000,
  });

  const ctx = await request.newContext();
  const after = await inspectPendingReview(ctx, PR);
  await ctx.dispose();
  // Finalized → no longer pending.
  expect(after.pendingReview).toBeNull();
  // Exactly one AttachThreadAsync (attempt 1's, before the throw); the retry
  // adopted rather than re-attaching — no duplicate.
  expect(after.attachThreadCallCount).toBe(1);
});
