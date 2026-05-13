import { test, expect, request } from '@playwright/test';

import {
  resetBackendState,
  setupAndOpenScenarioPr,
  createInlineDraft,
  recordPrViewed,
  setBeginDelay,
} from './helpers/s5-submit';

// Plan Task 68 — the per-PR submit lock under two simultaneous Confirms. Tab 1
// confirms first and (because the fake holds BeginPendingReviewAsync for a few
// seconds) keeps the per-PR SubmitLockRegistry entry. Tab 2 confirms a moment
// later → POST /submit gets 409 `submit-in-progress` → the frontend currently
// swallows the 409 and the dialog reverts to idle (no toast / inline error for
// this case — verified). Tab 1 then runs to completion.
//
// Two pages in the SAME browser context so they share the prism-session cookie.

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  // A long Begin delay so tab 1 holds the lock long enough for tab 2 to race it.
  await setBeginDelay(ctx, 4000);
  await ctx.dispose();
});

test('S5 simultaneous submits — one wins, the other is rejected by the per-PR lock', async ({
  page,
  context,
}) => {
  await setupAndOpenScenarioPr(page);
  await createInlineDraft(page, 3, 'multi-tab draft');
  await recordPrViewed(page.request);

  // Second tab, same context (shares cookies).
  const page2 = await context.newPage();

  await page.goto('/pr/acme/api/123');
  await page2.goto('/pr/acme/api/123');

  // Tab 1: Submit → Confirm. Begin is held ~4s → tab 1 keeps the lock.
  await page.getByRole('button', { name: /^submit review$/i }).click();
  const dialog1 = page.getByRole('dialog');
  await dialog1.getByRole('button', { name: /^confirm submit$/i }).click();

  // Tab 2: Submit → Confirm right away → 409 → dialog reverts to idle.
  await page2.getByRole('button', { name: /^submit review$/i }).click();
  const dialog2 = page2.getByRole('dialog');
  await dialog2.getByRole('button', { name: /^confirm submit$/i }).click();

  // Tab 2 loses: its dialog returns to the idle state (the "Confirm submit"
  // button is visible again).
  await expect(dialog2.getByRole('button', { name: /^confirm submit$/i })).toBeVisible({
    timeout: 5000,
  });
  // And it never reaches the success state.
  await expect(page2.getByRole('heading', { name: /review submitted/i })).toHaveCount(0);

  // Tab 1 wins: it runs to completion (Begin delay was 4s — fits in 15s).
  await expect(page.getByRole('heading', { name: /review submitted/i })).toBeVisible({
    timeout: 15_000,
  });

  await page2.close();
});
