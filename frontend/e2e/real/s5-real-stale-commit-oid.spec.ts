// S5 real flow — stale commit OID triggers recreate on second submit.
//
// Exercises the full stale-recreate pipeline on a live sandbox PR:
//  1) Draft an inline comment anchored to baseOid.
//  2) Submit with AttachThread pre-effect injection → Begin lands a pending review at
//     baseOid, AttachThread fails → dialog Failed → Cancel.
//  3) Push a new commit via createCommitOnBranch (advanceHead).
//  4) Wait for the Reload banner (SSE pr-updated; PR #65 wire fix).
//  5) Click Reload → mark-viewed re-stamps LastViewedHeadSha=newOid.
//  6) The previously-saved draft is now stale (anchor line dropped by step 3). Override it
//     via UnresolvedPanel "Keep anyway" so SubmitButton's stale gate clears
//     (SubmitButton.tsx:61-64; UnresolvedPanel + StaleDraftRow.tsx).
//  7) Submit again → FindOwnPendingReviewAsync finds the pending review at baseOid,
//     detects stale (pending.CommitOid != newOid) → user consents via Recreate and
//     Resubmit → fresh Begin→Attach→Finalize at newOid → "Review submitted".
//  8) GitHub-side: exactly one finalized review at newOid (not baseOid); no own pending.
//
// History: this spec uncovered the pr-updated SSE wire-contract bug fixed in PR #65 — see
// docs/specs/2026-05-19-stale-oid-banner-investigation-finding.md.
import { test, expect, request } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetSandboxFixture } from './helpers/reset-sandbox-fixture';
import { injectRealFailure } from './helpers/real-inject';
import {
  advanceHead,
  listSubmittedReviewsSince,
  listOwnPendingReviews,
} from './helpers/gh-sandbox';
import type { SandboxFixture } from './helpers/sandbox-fixture';

const fixtures = JSON.parse(
  fs.readFileSync(path.join('e2e', 'real', 'fixtures.json'), 'utf8'),
) as SandboxFixture[];
const staleFixture = fixtures.find((f) => f.name === 'stale-oid')!;

let sinceTs: string;

test.beforeEach(async () => {
  const ctx = await request.newContext();
  ({ sinceTs } = await resetSandboxFixture(ctx, staleFixture));
  await ctx.dispose();
});

test.skip('S5 real flow — stale commit OID triggers recreate on second submit (deferred — see docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md)', async ({
  page,
}) => {
  // Wrapper timeout: internal waits sum to ~150 s and each is independently bounded
  // (so a real stall fails fast at its own assertion). The 5-min ceiling exists only
  // so live-GitHub latency under load can't trip Playwright's 30 s default.
  test.setTimeout(300_000);

  await page.goto(`/pr/prpande/prism-sandbox/${staleFixture.prNumber}`);
  await page.waitForResponse((r) => r.url().endsWith('/mark-viewed') && r.status() === 204, {
    timeout: 15_000,
  });

  // Draft.
  await page.goto(`/pr/prpande/prism-sandbox/${staleFixture.prNumber}/files`);
  await page
    .getByRole('treeitem', { name: new RegExp(path.basename(staleFixture.anchorFile), 'i') })
    .click();
  await page
    .getByRole('button', {
      name: new RegExp(`add comment on line ${staleFixture.anchorLine}`, 'i'),
    })
    .click();
  const draftSave = page.waitForResponse(
    (r) => r.url().includes('/draft') && r.request().method() === 'PUT' && r.status() === 200,
    { timeout: 10_000 },
  );
  await page.getByRole('textbox', { name: /comment body/i }).fill('Body for stale-oid scenario.');
  await draftSave;

  // Inject pre-effect failure on AttachThread so Begin lands but AttachThread doesn't.
  // Session stamps PendingReviewId=X@baseOid; GitHub has the pending review at baseOid.
  await injectRealFailure(page.request, {
    graphQLFieldName: 'addPullRequestReviewThread',
    afterEffect: false,
    message: 'pre-effect AttachThread failure for stale-oid setup',
  });
  await page.goto(`/pr/prpande/prism-sandbox/${staleFixture.prNumber}`);
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

  // Push a real commit to the branch via createCommitOnBranch. The Reload-banner-visibility
  // assertion below is the regression net for SSE pr-updated delivery — the banner only renders
  // when usePrDetail receives the pr-updated event from the backend SSE channel, so a broken
  // SSE pipeline times out at 30s with a clearly-named surface.
  const newContent =
    `// advanced ${Date.now()}\n` + 'public static int Mul(int a, int b) => a * b;\n';
  advanceHead(staleFixture, {
    fileChanges: [
      {
        path: staleFixture.anchorFile,
        contentBase64: Buffer.from(newContent, 'utf8').toString('base64'),
      },
    ],
    commitMessage: 'advance head for stale-oid spec',
  });

  // Wait for the Reload banner to appear (driven by SSE pr-updated; ActivePrPoller cadence 1s + replica propagation).
  const reloadBanner = page.getByRole('button', { name: /reload pr|reload/i });
  await expect(reloadBanner).toBeVisible({ timeout: 30_000 });
  await reloadBanner.click();
  // After reload, mark-viewed re-stamps LastViewedHeadSha=newOid.
  await page.waitForResponse((r) => r.url().endsWith('/mark-viewed') && r.status() === 204, {
    timeout: 15_000,
  });

  // The draft created earlier (line 57-58) anchored to baseOid; after advanceHead it
  // classifies stale and SubmitButton disables until the user overrides or discards
  // (SubmitButton.tsx:61-64 — "Resolve or override the stale drafts in the Drafts tab first.").
  // The override affordance is "Keep anyway" on UnresolvedPanel (StaleDraftRow.tsx:131-138),
  // which mounts above the tabs whenever any draft is stale-not-overridden.
  //
  // Two deterministic waits bracket the click so the test never races React state:
  //  - BEFORE: assert on the Keep-anyway button itself (not just panel visibility — the
  //    panel also renders for `needsReconfirm` or `movedCount > 0` per UnresolvedPanel.tsx:74,
  //    so panel-visible alone is not proof that our stale row is mounted).
  //  - AFTER: assert the panel hides. StaleDraftRow.handleKeepAnyway fires the PUT, then
  //    onMutated() → draftSession.refetch() runs a follow-up GET. The panel only disappears
  //    once the refetch lands and React re-renders — which is the same tick that flips
  //    SubmitButton's stale gate in SubmitButton.tsx:61-64. Asserting on disappearance
  //    avoids a Playwright actionability wait on the still-disabled Submit button below.
  // Mirrors frontend/e2e/s4-keep-anyway-survives-reload.spec.ts:62-70 for the PUT wait pattern.
  const unresolvedPanel = page.getByRole('region', { name: /unresolved drafts/i });
  const keepAnywayBtn = unresolvedPanel.getByRole('button', { name: /keep anyway/i });
  await expect(keepAnywayBtn).toBeVisible({ timeout: 15_000 });
  const overridePromise = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/pr/prpande/prism-sandbox/${staleFixture.prNumber}/draft`) &&
      r.request().method() === 'PUT' &&
      r.status() === 200,
    { timeout: 10_000 },
  );
  await keepAnywayBtn.click();
  await overridePromise;
  await expect(unresolvedPanel).not.toBeVisible({ timeout: 10_000 });

  // Second submit. Pipeline: FindOwnPendingReviewAsync finds review at baseOid;
  // session.PendingReviewId matches → own; pending.CommitOid != newOid → stale → recreate.
  // First Confirm Submit triggers StaleCommitOidRecreating (server-side orphan delete + clear stamps);
  // dialog transitions to kind='stale-commit-oid' and renders StaleCommitOidBanner. The user must
  // then click "Recreate and resubmit" — that's the user-consent gate for the resubmit cycle
  // (see SubmitDialog.tsx:192-205, StaleCommitOidBanner.tsx:53, useSubmit.ts:144-152).
  await page.getByRole('button', { name: /^submit review$/i }).click();
  const dialog2 = page.getByRole('dialog');
  await dialog2.getByRole('button', { name: /^confirm submit$/i }).click();
  // Stale-commit-oid banner appears with the Recreate-and-resubmit button.
  const recreateBtn = dialog2.getByRole('button', { name: /recreate and resubmit/i });
  await expect(recreateBtn).toBeVisible({ timeout: 20_000 });
  await recreateBtn.click();
  // Fresh Begin→Attach→Finalize cycle at newOid lands "Review submitted".
  await expect(page.getByRole('heading', { name: /review submitted/i })).toBeVisible({
    timeout: 30_000,
  });

  // GitHub-side: one finalized review at newOid (not baseOid).
  const reviews = listSubmittedReviewsSince(staleFixture.prNumber, sinceTs);
  expect(reviews).toHaveLength(1);
  expect(reviews[0].state).toBe('COMMENTED');
  expect(reviews[0].commitOid).not.toBe(staleFixture.baseOid);
  expect(listOwnPendingReviews(staleFixture.prNumber)).toHaveLength(0);
});
