import { test, expect, request } from '@playwright/test';

import {
  resetBackendState,
  setupAndOpenScenarioPr,
  createInlineDraft,
  recordPrViewed,
  setBeginDelay,
  injectSubmitFailure,
  SubmitMethod,
  setPrState,
  advanceHead,
} from './helpers/s5-submit';

// Plan Task 67 (spec § 13 — closed/merged-PR bulk discard).
//
// (a) On a closed PR the Submit Review button is disabled and a
//     "Discard all drafts" button takes its place; clicking through the
//     confirmation modal clears the session (the draft disappears).
// (b) When the closed-PR bulk discard's best-effort courtesy
//     DeletePendingReviewAsync fails, the `submit-orphan-cleanup-failed`
//     toast surfaces ("…it will be cleaned up on the next successful submit…").
//
// IMPLEMENTATION NOTE: PrDetailLoader caches the PrDetailDto by
// (prRef, headSha, generation). `setPrState` mutates the backing store but
// doesn't change the head sha, so a bare `page.reload()` re-serves the cached
// (open) DTO. To make the closed flag visible we ALSO push a new head sha
// (`advanceHead`, keeping line 3 intact so the draft stays anchored) — that
// forces a loader cache miss, and the next GET /api/pr/{ref} re-fetches the
// detail with `state: "CLOSED"`. (This is the only "deviation" from the brief;
// the brief's `setPrState → reload` recipe doesn't account for the loader cache.)

const NEW_HEAD = 'a'.repeat(40);
const CALC_WITH_HALF =
  'namespace Acme;\npublic static class Calc {\n  public static int Add(int a, int b) => a + b;\n  public static int Half(int a) => a / 2;\n}\n';

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  // Test (b) drives the submit pipeline; the Begin delay keeps the SSE-vs-200
  // ordering deterministic. Harmless for test (a).
  await setBeginDelay(ctx, 120);
  await ctx.dispose();
});

// Flips the PR closed and forces the loader to re-fetch the (now closed) detail
// by advancing the head sha (line 3 preserved → the draft stays anchored).
async function closePrAndRefresh(page: import('@playwright/test').Page) {
  await setPrState(page.request, 'CLOSED');
  await advanceHead(page.request, NEW_HEAD, [{ path: 'src/Calc.cs', content: CALC_WITH_HALF }]);
  await page.goto('/pr/acme/api/123');
}

test('S5 closed PR — Discard all drafts removes the saved draft', async ({ page }) => {
  await setupAndOpenScenarioPr(page);
  await createInlineDraft(page, 3, 'draft on a closed pr');

  await closePrAndRefresh(page);

  // Submit Review is disabled; the bulk-discard button appears next to it.
  await expect(page.getByRole('button', { name: /^submit review$/i })).toBeDisabled();
  const discardAll = page.getByRole('button', { name: /discard all drafts/i });
  await expect(discardAll).toBeVisible({ timeout: 10_000 });
  await discardAll.click();

  // Confirmation modal → Discard all.
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('heading', { name: /discard all drafts\?/i })).toBeVisible();
  await modal.getByRole('button', { name: /^discard all$/i }).click();

  // The session is cleared (StateChanged SSE → the page re-fetches). The
  // bulk-discard button hides (no discardable content left) and the Drafts tab
  // shows no draft body.
  await expect(page.getByRole('button', { name: /discard all drafts/i })).toHaveCount(0, {
    timeout: 10_000,
  });
  await page.getByRole('tab', { name: /^Drafts/i }).click();
  await expect(page.getByText('draft on a closed pr')).toHaveCount(0, { timeout: 10_000 });
});

test('S5 closed PR — a failed courtesy delete surfaces the orphan-cleanup-failed toast', async ({
  page,
}) => {
  await setupAndOpenScenarioPr(page);
  await createInlineDraft(page, 3, 'draft with a leftover pending review');
  await recordPrViewed(page.request);

  // Submit, but fail at AttachThreads so the pipeline leaves a pending review
  // behind (session.pendingReviewId gets stamped on the failed-state Cancel).
  await injectSubmitFailure(page.request, SubmitMethod.AttachThread, {
    message: 'stop after Begin so a pending review is left behind',
  });
  await page.goto('/pr/acme/api/123');
  await page.getByRole('button', { name: /^submit review$/i }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^confirm submit$/i }).click();
  await expect(dialog.getByRole('heading', { name: /^submit failed at /i })).toBeVisible({
    timeout: 15_000,
  });
  // Cancel the dialog — now session.pendingReviewId is the leftover marker.
  await dialog.getByRole('button', { name: /^cancel$/i }).click();
  await expect(dialog).toHaveCount(0);

  // Arm the courtesy-delete failure, close the PR, force a detail re-fetch, then
  // bulk-discard.
  await injectSubmitFailure(page.request, SubmitMethod.DeletePendingReview, {
    message: 'courtesy delete fails',
  });
  await closePrAndRefresh(page);

  const discardAll = page.getByRole('button', { name: /discard all drafts/i });
  await expect(discardAll).toBeVisible({ timeout: 10_000 });
  await discardAll.click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^discard all$/i })
    .click();

  // The best-effort github.com delete failed → submit-orphan-cleanup-failed SSE
  // → toast.
  await expect(
    page.getByText(
      /pending review on GitHub may persist; it will be cleaned up on the next successful submit/i,
    ),
  ).toBeVisible({ timeout: 10_000 });
});
