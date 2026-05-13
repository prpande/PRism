import { test, expect, request } from '@playwright/test';

import {
  resetBackendState,
  setupAndOpenScenarioPr,
  createInlineDraft,
  recordPrViewed,
  setBeginDelay,
  inspectPendingReview,
} from './helpers/s5-submit';

const PR = { owner: 'acme', repo: 'api', number: 123 };

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  // A small Begin delay makes Phase A observable and keeps the SSE-vs-200 ordering deterministic
  // (the dialog only acts on submit-progress events once its POST /submit returned 200; without the
  // delay the first events can land before the 200 is processed).
  await setBeginDelay(ctx, 120);
  await ctx.dispose();
});

// docs/spec/01-vision-and-acceptance.md § "The PoC demo" steps 7 + 11-13: write a draft inline
// comment, pick a verdict / write a summary, click "Submit review", the GraphQL pending-review
// pipeline runs to completion, and the success state surfaces a "View on GitHub" link to the PR.
test('S5 happy path — draft → Submit dialog → Confirm → pipeline runs → success', async ({
  page,
}) => {
  await setupAndOpenScenarioPr(page);
  await createInlineDraft(page, 3, 'Consider naming this parameter more descriptively.');
  // The submit head-sha-drift gate needs a recorded "viewed at head" (the demo does this via Reload).
  await recordPrViewed(page.request);

  // Back to the PR detail (the inline composer lives in the Files tab; PrHeader's Submit button is
  // on every PR sub-tab). The button enables once there's reviewable content (no verdict required).
  await page.goto('/pr/acme/api/123');
  const submitButton = page.getByRole('button', { name: /^submit review$/i });
  await expect(submitButton).toBeEnabled({ timeout: 10_000 });
  await submitButton.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /^submit review$/i })).toBeVisible();

  // Optional PR-level summary (debounced auto-save; handleConfirm flushes it before submitting).
  await dialog.getByLabel(/pr-level summary/i).fill('Overall: small naming nits, otherwise good.');

  await dialog.getByRole('button', { name: /^confirm submit$/i }).click();

  // Phase A → Phase B → success. The 5-row checklist stays visible in the success state.
  await expect(page.getByRole('heading', { name: /review submitted/i })).toBeVisible({
    timeout: 15_000,
  });
  await expect(dialog.getByText(/created pending review/i)).toBeVisible();
  await expect(dialog.locator('[data-step="Finalize"]')).toHaveAttribute('data-state', 'done');

  const ghLink = page.getByRole('link', { name: /view on github/i });
  await expect(ghLink).toBeVisible();
  await expect(ghLink).toHaveAttribute('href', 'https://github.com/acme/api/pull/123');

  // Backend: the pending review was finalized (no longer pending) and exactly one thread was
  // attached for the one draft — no duplicates.
  const ctx = await request.newContext();
  const after = await inspectPendingReview(ctx, PR);
  await ctx.dispose();
  expect(after.pendingReview).toBeNull();
  expect(after.attachThreadCallCount).toBe(1);
});
