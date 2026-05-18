import { test, expect, request } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetSandboxFixture } from './helpers/reset-sandbox-fixture';
import { listSubmittedReviewsSince, listOwnPendingReviews } from './helpers/gh-sandbox';
import type { SandboxFixture } from './helpers/sandbox-fixture';

// Regression net for the PR#55 "/mark-viewed never called by usePrDetail" bug class.
// Drives the full chain — setup, draft, mark-viewed, submit, finalize — through real GitHub
// with no backend shortcuts. If the FE wire-up regresses, this fails with head-sha-not-stamped.

const fixtures = JSON.parse(
  fs.readFileSync(path.join('e2e', 'real', 'fixtures.json'), 'utf8'),
) as SandboxFixture[];
const happyFixture = fixtures.find((f) => f.name === 'happy')!;

let sinceTs: string;

test.beforeEach(async () => {
  const ctx = await request.newContext();
  ({ sinceTs } = await resetSandboxFixture(ctx, happyFixture));
  await ctx.dispose();
});

test('S5 real flow — happy path drives mark-viewed → submit → finalize through real GitHub', async ({ page }) => {
  // 1. Navigate to the fixture PR. usePrDetail's mark-viewed fires here.
  const markViewedResp = page.waitForResponse(
    (r) => r.url().endsWith('/mark-viewed') && r.status() === 204,
    { timeout: 15_000 },
  );
  await page.goto(`/pr/prpande/prism-sandbox/${happyFixture.prNumber}`);
  await markViewedResp; // ← the regression net

  // 2. Goto Files tab and add an inline comment on the anchor line.
  await page.goto(`/pr/prpande/prism-sandbox/${happyFixture.prNumber}/files`);
  await page.getByRole('treeitem', { name: new RegExp(path.basename(happyFixture.anchorFile), 'i') }).click();
  const addBtn = page.getByRole('button', { name: new RegExp(`add comment on line ${happyFixture.anchorLine}`, 'i') });
  await addBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await addBtn.click();
  const textarea = page.getByRole('textbox', { name: /comment body/i });
  await textarea.waitFor({ state: 'visible' });
  const draftSave = page.waitForResponse(
    (r) => r.url().includes('/draft') && r.request().method() === 'PUT' && r.status() === 200,
    { timeout: 10_000 },
  );
  await textarea.fill('Real-flow happy-path body.');
  await draftSave;

  // 3. Back to PR detail, click Submit Review.
  await page.goto(`/pr/prpande/prism-sandbox/${happyFixture.prNumber}`);
  const submitBtn = page.getByRole('button', { name: /^submit review$/i });
  await expect(submitBtn).toBeEnabled({ timeout: 10_000 });
  await submitBtn.click();

  // 4. Fill summary; verdict=Comment; click Confirm Submit.
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/pr-level summary/i).fill('Real-flow happy-path summary.');
  await dialog.getByRole('button', { name: /^confirm submit$/i }).click();

  // 5. Expect "Review submitted" heading and Finalize step in done state.
  await expect(page.getByRole('heading', { name: /review submitted/i })).toBeVisible({ timeout: 20_000 });
  await expect(dialog.locator('[data-step="Finalize"]')).toHaveAttribute('data-state', 'done');

  // 6. GitHub-side assertions.
  const reviews = listSubmittedReviewsSince(happyFixture.prNumber, sinceTs);
  expect(reviews).toHaveLength(1);
  expect(reviews[0].state).toBe('COMMENTED');
  expect(reviews[0].body).toBe('Real-flow happy-path summary.');
  expect(reviews[0].threadCount).toBe(1);
  expect(listOwnPendingReviews(happyFixture.prNumber)).toHaveLength(0);
});
