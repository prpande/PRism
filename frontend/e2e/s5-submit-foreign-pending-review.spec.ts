import { test, expect, request } from '@playwright/test';

import {
  resetBackendState,
  setupAndOpenScenarioPr,
  createInlineDraft,
  recordPrViewed,
  setBeginDelay,
  seedPendingReview,
  inspectPendingReview,
} from './helpers/s5-submit';

// Plan Task 64 — DoD tests (c) Resume and (d) Discard the foreign pending
// review, plus a Cancel-leaves-it-untouched variant. The scenario: a local
// draft exists, and there's *also* a pending review on the PR that the session
// doesn't own (seeded). Submit detects it (Step 1's
// ForeignPendingReviewPromptRequired) and surfaces the prompt modal.

const PR = { owner: 'acme', repo: 'api', number: 123 };

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await setBeginDelay(ctx, 120);
  await ctx.dispose();
});

// Drives: local draft → recordPrViewed → seed a foreign pending review (one
// resolved thread on src/Calc.cs:3) → Submit → Confirm → the foreign-prompt
// modal. Leaves the page sitting on that modal.
async function openForeignPrompt(page: import('@playwright/test').Page) {
  await setupAndOpenScenarioPr(page);
  await createInlineDraft(page, 3, 'my local draft');
  await recordPrViewed(page.request);
  await seedPendingReview(page.request, PR, {
    threads: [
      { filePath: 'src/Calc.cs', lineNumber: 3, body: 'looks good to me', isResolved: true },
    ],
  });

  await page.goto('/pr/acme/api/123');
  await page.getByRole('button', { name: /^submit review$/i }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^confirm submit$/i }).click();

  await expect(
    dialog.getByRole('heading', { name: /existing pending review on this PR/i }),
  ).toBeVisible({
    timeout: 15_000,
  });
  return dialog;
}

test('S5 foreign pending review — Resume imports its threads as drafts and adopts the review', async ({
  page,
}) => {
  const modal = await openForeignPrompt(page);

  await modal.getByRole('button', { name: /^resume$/i }).click();

  // The dialog closes; the imported thread becomes a draft. The post-Resume
  // banner notes the resolved import.
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('.imported-drafts-banner')).toContainText(
    /were resolved on github\.com/i,
    {
      timeout: 10_000,
    },
  );

  // The imported thread body is now visible as a draft (Drafts tab).
  await page.getByRole('tab', { name: /^Drafts/i }).click();
  await expect(page.getByText('looks good to me').first()).toBeVisible({ timeout: 10_000 });

  // Resume *adopts* the review (doesn't delete it) — it's still present. page.request avoids a
  // separate APIRequestContext dispose around the fallible assertion.
  const after = await inspectPendingReview(page.request, PR);
  expect(after.pendingReview).not.toBeNull();
});

test('S5 foreign pending review — Discard deletes it on github.com', async ({ page }) => {
  const modal = await openForeignPrompt(page);

  await modal.getByRole('button', { name: 'Discard…' }).click();
  // Scope the sub-modal lookup by its heading so the locator can't accidentally match the (now
  // unmounted) parent foreign-review modal — the ForeignPendingReviewModal sets `open={!discardOpen}`
  // so only one Modal is mounted at a time, but the scoped lookup makes the intent explicit.
  const sub = page
    .getByRole('dialog')
    .filter({
      has: page.getByRole('heading', { name: /delete the pending review on github\.com\?/i }),
    });
  await expect(sub).toBeVisible();
  await sub.getByRole('button', { name: /^delete$/i }).click();

  // The pending review is gone. page.request, polled until the discard round-trip settles.
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });
  await expect
    .poll(async () => (await inspectPendingReview(page.request, PR)).pendingReview, {
      timeout: 10_000,
    })
    .toBeNull();
});

test('S5 foreign pending review — Cancel leaves the pending review untouched', async ({ page }) => {
  const modal = await openForeignPrompt(page);

  // The Cancel button's accessible name starts "Cancel —".
  await modal.getByRole('button', { name: /^cancel —/i }).click();

  // The modal closes; nothing changed server-side.
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });
  const after = await inspectPendingReview(page.request, PR);
  expect(after.pendingReview).not.toBeNull();
});
