import { test, expect, request } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetSandboxFixture } from './helpers/reset-sandbox-fixture';
import { injectRealFailure } from './helpers/real-inject';
import { listSubmittedReviewsSince, listOwnPendingReviews } from './helpers/gh-sandbox';
import type { SandboxFixture } from './helpers/sandbox-fixture';

const fixtures = JSON.parse(
  fs.readFileSync(path.join('e2e', 'real', 'fixtures.json'), 'utf8'),
) as SandboxFixture[];
const lostFixture = fixtures.find((f) => f.name === 'lost-response')!;

let sinceTs: string;

test.beforeEach(async () => {
  const ctx = await request.newContext();
  ({ sinceTs } = await resetSandboxFixture(ctx, lostFixture));
  await ctx.dispose();
});

test('S5 real flow — lost-response adoption skips re-attach and finalizes cleanly', async ({ page }) => {
  await page.goto(`/pr/prpande/prism-sandbox/${lostFixture.prNumber}`);
  await page.waitForResponse(
    (r) => r.url().endsWith('/mark-viewed') && r.status() === 204,
    { timeout: 15_000 },
  );

  // Draft.
  await page.goto(`/pr/prpande/prism-sandbox/${lostFixture.prNumber}/files`);
  await page.getByRole('treeitem', { name: new RegExp(path.basename(lostFixture.anchorFile), 'i') }).click();
  await page.getByRole('button', { name: new RegExp(`add comment on line ${lostFixture.anchorLine}`, 'i') }).click();
  const draftSave1 = page.waitForResponse(
    (r) => r.url().includes('/draft') && r.request().method() === 'PUT' && r.status() === 200,
    { timeout: 10_000 },
  );
  await page.getByRole('textbox', { name: /comment body/i }).fill('Body — first attempt should fail mid-stream.');
  await draftSave1;

  // Arm afterEffect on addPullRequestReviewThread — GitHub commits the thread, PRism throws on response.
  await injectRealFailure(page.request, {
    graphQLFieldName: 'addPullRequestReviewThread',
    afterEffect: true,
    message: 'simulated lost-response window',
  });

  // First submit → expect Failed.
  await page.goto(`/pr/prpande/prism-sandbox/${lostFixture.prNumber}`);
  await page.getByRole('button', { name: /^submit review$/i }).click();
  const dialog1 = page.getByRole('dialog');
  await dialog1.getByRole('button', { name: /^confirm submit$/i }).click();
  // Assert against the SubmitProgressIndicator's failed-row data-state, not a loose /failed/i regex —
  // /failed/i would also match transient step-progress text and risk a false-positive pass if the
  // injector misfires (see SubmitProgressIndicator.tsx:80,98 for the data-state surface).
  await expect(dialog1.locator('[data-state="failed"]').first()).toBeVisible({ timeout: 20_000 });

  // Click Cancel as the deterministic close affordance — Escape moves focus to Cancel but
  // does NOT close the dialog (SubmitDialog UX: Esc moves focus, Enter on Cancel closes).
  // Clicking the visible Cancel button is the single-action equivalent; toBeHidden still
  // turns a missing button into a loud failure.
  await dialog1.getByRole('button', { name: /^cancel$/i }).click();
  await expect(dialog1).toBeHidden({ timeout: 5_000 });

  // Second submit → adoption: FindOwnPendingReviewAsync finds the previously-attached pending review,
  // marker-matches the existing thread, skips re-attach, finalizes.
  await page.getByRole('button', { name: /^submit review$/i }).click();
  const dialog2 = page.getByRole('dialog');
  await expect(dialog2).toBeVisible();
  await dialog2.getByRole('button', { name: /^confirm submit$/i }).click();
  await expect(page.getByRole('heading', { name: /review submitted/i })).toBeVisible({ timeout: 25_000 });

  // GitHub-side: exactly ONE Comment review with EXACTLY ONE thread (no duplicate from re-attach).
  const reviews = listSubmittedReviewsSince(lostFixture.prNumber, sinceTs);
  expect(reviews).toHaveLength(1);
  expect(reviews[0].threadCount).toBe(1);
  expect(listOwnPendingReviews(lostFixture.prNumber)).toHaveLength(0);
});
