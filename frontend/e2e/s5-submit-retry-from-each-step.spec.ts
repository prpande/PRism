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

const PR = { owner: 'acme', repo: 'api', number: 123 };

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  // Holds BeginPendingReviewAsync briefly so the failure events land after the POST /submit 200
  // (the dialog only acts on submit-progress events once its POST returned).
  await setBeginDelay(ctx, 120);
  await ctx.dispose();
});

// DoD test (b) — docs/spec/01-vision-and-acceptance.md § DoD: "Submit failure preserves all drafts
// and pendingReviewId in state.json, shows a clear error message, and retry from the same state
// converges on success without producing duplicate threads or replies."
//
// Three of the four mutation steps are exercised through the UI: BeginPendingReview (nothing created
// yet), AttachThreads (the pending review exists, the draft isn't stamped), Finalize (everything
// attached). The fourth step — AttachReplies — and the exhaustive 4-step matrix are covered by the
// Core unit test (tests/PRism.Core.Tests/Submit/Pipeline/RetryFromEachStepTests.cs): a fresh draft
// reply has no reachable UI affordance here (replies attach only to threads already on the pending
// review, e.g. ones imported via Resume). Recorded in the S5 deferrals sidecar.
for (const failingMethod of [SubmitMethod.Begin, SubmitMethod.AttachThread, SubmitMethod.Finalize]) {
  test(`S5 retry — failure at ${failingMethod} → Retry → success, no duplicate threads`, async ({ page }) => {
    await setupAndOpenScenarioPr(page);
    await createInlineDraft(page, 3, 'Inline note exercising the retry path.');
    await recordPrViewed(page.request);
    await injectSubmitFailure(page.request, failingMethod, { message: `simulated ${failingMethod} failure` });

    await page.goto('/pr/acme/api/123');
    await page.getByRole('button', { name: /^submit review$/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /^confirm submit$/i }).click();

    // First attempt fails at the injected step → failed-state heading + Retry button.
    await expect(dialog.getByRole('heading', { name: /^submit failed at /i })).toBeVisible({ timeout: 15_000 });
    const retry = dialog.getByRole('button', { name: /^retry$/i });
    await expect(retry).toBeVisible();

    // Second attempt: the one-shot failure is spent → converges on success.
    await retry.click();
    await expect(page.getByRole('heading', { name: /review submitted/i })).toBeVisible({ timeout: 15_000 });

    // No duplicates: exactly one AttachThreadAsync across both attempts; the pending review finalized.
    const ctx = await request.newContext();
    const after = await inspectPendingReview(ctx, PR);
    await ctx.dispose();
    expect(after.attachThreadCallCount).toBe(1);
    expect(after.pendingReview).toBeNull();
  });
}
