import { test, expect, request } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetSandboxFixture } from './helpers/reset-sandbox-fixture';
import {
  createPendingReview,
  listSubmittedReviewsSince,
  listOwnPendingReviews,
} from './helpers/gh-sandbox';
import type { SandboxFixture } from './helpers/sandbox-fixture';

const fixtures = JSON.parse(
  fs.readFileSync(path.join('e2e', 'real', 'fixtures.json'), 'utf8'),
) as SandboxFixture[];
const foreignFixture = fixtures.find((f) => f.name === 'foreign')!;

let sinceTs: string;

test.beforeEach(async () => {
  const ctx = await request.newContext();
  ({ sinceTs } = await resetSandboxFixture(ctx, foreignFixture));
  // Seed a pending review out-of-band — PRism's session has never stamped this PendingReviewId,
  // so it will be classified as foreign on submit-attempt.
  createPendingReview(foreignFixture, { threadBody: 'Pre-seeded foreign thread.' });
  // Load-bearing ordering invariant — a refactor that moves this seed before resetSandboxFixture
  // would delete it. Assert immediately so the failure is loud and locally explained.
  expect(listOwnPendingReviews(foreignFixture.prNumber)).toHaveLength(1);
  await ctx.dispose();
});

test('S5 real flow — foreign pending review prompt fires; Resume imports + submit lands', async ({ page }) => {
  const markViewedResp = page.waitForResponse(
    (r) => r.url().endsWith('/mark-viewed') && r.status() === 204,
    { timeout: 15_000 },
  );
  await page.goto(`/pr/prpande/prism-sandbox/${foreignFixture.prNumber}`);
  await markViewedResp;

  // Add an inline draft of our own.
  await page.goto(`/pr/prpande/prism-sandbox/${foreignFixture.prNumber}/files`);
  await page.getByRole('treeitem', { name: new RegExp(path.basename(foreignFixture.anchorFile), 'i') }).click();
  const addBtn = page.getByRole('button', { name: new RegExp(`add comment on line ${foreignFixture.anchorLine}`, 'i') });
  await addBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await addBtn.click();
  const textarea = page.getByRole('textbox', { name: /comment body/i });
  await textarea.waitFor({ state: 'visible' });
  const draftSave = page.waitForResponse(
    (r) => r.url().includes('/draft') && r.request().method() === 'PUT' && r.status() === 200,
    { timeout: 10_000 },
  );
  await textarea.fill('Own draft for foreign-pending scenario.');
  await draftSave;

  // Submit. The pipeline will detect the foreign pending review via FindOwnPendingReviewAsync
  // (the seeded review's ID doesn't match session.PendingReviewId, which is null).
  await page.goto(`/pr/prpande/prism-sandbox/${foreignFixture.prNumber}`);
  await page.getByRole('button', { name: /^submit review$/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /^confirm submit$/i }).click();

  // Foreign-pending-review modal should appear.
  const modal = page.getByRole('dialog', { name: /pending review|existing pending|already have a pending/i });
  await expect(modal).toBeVisible({ timeout: 15_000 });
  await expect(modal.getByText(/pre-seeded foreign thread/i)).toBeVisible();

  // Click Resume.
  await modal.getByRole('button', { name: /resume/i }).click();

  // Expect the imported draft to appear in the composer with the foreign body.
  await expect(page.getByText(/pre-seeded foreign thread/i)).toBeVisible({ timeout: 10_000 });

  // Click Submit again.
  await page.getByRole('button', { name: /^submit review$/i }).click();
  const finalDialog = page.getByRole('dialog');
  await finalDialog.getByRole('button', { name: /^confirm submit$/i }).click();
  await expect(page.getByRole('heading', { name: /review submitted/i })).toBeVisible({ timeout: 20_000 });

  // GitHub-side assertions.
  const reviews = listSubmittedReviewsSince(foreignFixture.prNumber, sinceTs);
  expect(reviews).toHaveLength(1);
  expect(reviews[0].state).toBe('COMMENTED');
  expect(reviews[0].threadCount).toBe(2); // imported foreign + own
  expect(listOwnPendingReviews(foreignFixture.prNumber)).toHaveLength(0);
});
