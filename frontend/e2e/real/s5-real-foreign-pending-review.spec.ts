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
  // Default Playwright test timeout is 30s. This spec exercises two real-GraphQL submit
  // cycles (foreign-pending classify + Resume import; then final submit at HEAD) on top of
  // the standard mark-viewed / draft / files-tab navigation, comfortably exceeding 30s on
  // typical network. Bump to 120s to give the inner toBeVisible budgets (15s modal, 10s
  // composer body, 20s "Review submitted" heading) their full design budgets.
  test.setTimeout(120_000);
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
  // ForeignPendingReviewModal only renders thread/reply COUNTS (and a humanized createdAt),
  // not the thread body text — thread bodies surface in the composer after Resume.
  // Asserting on the thread-count chip keeps a regression-net inside the modal step:
  // a regression that drops `snapshot.threadCount` to 0 or fails to render the chip
  // would fail this assertion loudly before we click Resume. See
  // frontend/src/components/PrDetail/ForeignPendingReviewModal/ForeignPendingReviewModal.tsx
  // for the rendered text shape.
  await expect(modal.getByText(/1 thread\(s\)/i)).toBeVisible();

  // Click Resume.
  await modal.getByRole('button', { name: /resume/i }).click();

  // Wait for the modal to close — Resume completion is asynchronous on the server (the import
  // mutation is awaited before the modal dismisses), so the modal-hidden state is the gate
  // that lets us proceed without racing the draft-list refetch on the Drafts tab.
  await expect(modal).toBeHidden({ timeout: 10_000 });

  // Navigate to the Drafts tab to verify the imported foreign thread's body materialized as
  // a draft entry. The Overview tab doesn't render draft bodies, and the imported drafts are
  // not surfaced inline on the file diff until the user opens the corresponding line composer —
  // the Drafts tab is the canonical "session has these drafts" listing (DraftListItem renders
  // a previewBody up to 80 chars via MarkdownRenderer, plenty for our 26-char seed body).
  await page.getByRole('tab', { name: /^drafts/i }).click();
  await expect(page.getByText(/pre-seeded foreign thread/i)).toBeVisible({ timeout: 10_000 });

  // Back to Overview to drive the final Submit. Submit button lives on the PrHeader which is
  // shared across tabs, but the next assertion on the success heading is most discoverable
  // from the Overview / detail context.
  await page.getByRole('tab', { name: /^overview$/i }).click();

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
