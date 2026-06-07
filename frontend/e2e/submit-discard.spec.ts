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

// Task 27 (spec § 7.3) — the PR-root "Post a comment" + "Discard pending review"
// lifecycle, end-to-end. Five scenarios:
//
//   1. Post happy path — compose a PR-root body on the Overview tab, click Post,
//      assert the local draft is consumed (composer closes, the draft does not
//      re-hydrate on reopen) with no error row.
//   2. Post failure surface — InjectFailure("CreateIssueCommentAsync",
//      afterEffect: false) → the post-error row + Retry button. Clear the
//      injection (it's one-shot) and Retry → success.
//   3. Already-shipped retry (lost-response) — InjectFailure(..., afterEffect:
//      true): the github.com call lands, THEN the method throws (the lost-
//      response window). First Post surfaces the error row; clearing the
//      one-shot injection + a second Post succeeds and the composer closes.
//      (See the SCENARIO-3 NOTE below for why the "no duplicate" half of the
//      spec's prose is not assertable against the current fake.)
//   4. Discard idle pending review — stage a leftover pending review (a submit
//      that fails at AttachThreads stamps session.pendingReviewId on the
//      failed-state Cancel), close the dialog → the PrHeader pill is visible →
//      click it → confirm in the modal → the pill disappears + the pending
//      review is cleared on github.com.
//   5. Discard in-flight pipeline — set-begin-delay(5000) → Confirm submit (the
//      pipeline acquires the lock and blocks inside Begin) → the dialog's
//      Discard footer button is visible → click it → confirm → the user-discard
//      CTS cancels the pipeline, the discard runs DELETE + clears stamps → the
//      dialog closes + the pending review is cleared.
//
// Reuses ONLY the existing /test/submit/inject-failure + /test/submit/set-begin-
// delay hooks (spec § 7.2 — no net-new test endpoints). All /test/* drivers go
// through the helpers in ./helpers/s5-submit, which target the absolute backend
// origin (BACKEND_ORIGIN, default :5180) because the Vite `dev` project only
// proxies /api, not /test.

const PR = { owner: 'acme', repo: 'api', number: 123 };

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  // A small Begin delay keeps the submit SSE-vs-200 ordering deterministic for
  // the scenarios that drive the pipeline (the dialog only acts on submit-
  // progress events once its POST /submit returned 200). Scenario 5 overrides
  // this with a much larger delay to make the in-flight window observable.
  await setBeginDelay(ctx, 120);
  await ctx.dispose();
});

// Opens the Overview-tab PR-root Reply composer, types `body`, and waits for the
// 250ms auto-save PUT to land so the draft is durable before Post. Mirrors the
// inline-draft helper's wait-for-save pattern, but for the anchor-less PR-root
// draft (filePath/lineNumber null) edited from the Overview conversation.
async function openRootComposerAndType(
  page: import('@playwright/test').Page,
  body: string,
): Promise<void> {
  await page.goto('/pr/acme/api/123');
  // The PR-root conversation's Reply button (Overview tab). Clicking it mounts
  // the PrRootReplyComposer, which wraps PrRootBodyEditor (aria-label
  // "PR-level body").
  await page.getByRole('button', { name: /^reply$/i }).click();
  const textarea = page.getByRole('textbox', { name: /pr-level body/i });
  await textarea.waitFor({ state: 'visible' });
  const savePromise = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/pr/acme/api/123/draft') &&
      r.request().method() === 'PUT' &&
      r.status() === 200,
    { timeout: 10_000 },
  );
  await textarea.fill(body);
  await savePromise;
}

// Stages a leftover pending review: a submit that fails at AttachThreads leaves
// a pending review on github.com (the fake's BeginPendingReviewAsync created it)
// and the dialog's failed-state Cancel stamps session.pendingReviewId. Mirrors
// the s5-submit-closed-merged-discard staging. Leaves the dialog closed.
async function stageLeftoverPendingReview(page: import('@playwright/test').Page): Promise<void> {
  await setupAndOpenScenarioPr(page);
  await createInlineDraft(page, 3, 'draft that leaves a pending review behind');
  await recordPrViewed(page);

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
  // Cancel — the failed-state Cancel stamps session.pendingReviewId.
  await dialog.getByRole('button', { name: /^cancel$/i }).click();
  await expect(dialog).toHaveCount(0);
}

test('S-discard 1 — Post happy path consumes the PR-root draft', async ({ page }) => {
  await setupAndOpenScenarioPr(page);
  await openRootComposerAndType(page, 'A standalone PR-root comment for the demo.');

  // Click Post. On success the composer's handlePost calls onClose → the composer
  // unmounts and the Reply button returns. No post-error row appears.
  await page.getByRole('button', { name: /^post$/i }).click();

  // The composer closed: the PR-level body textarea is gone, the Reply button is
  // back, and no post-error surfaced.
  await expect(page.getByRole('button', { name: /^reply$/i })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('textbox', { name: /pr-level body/i })).toHaveCount(0);
  await expect(page.locator('[data-testid="post-error"]')).toHaveCount(0);

  // The draft was consumed server-side (deleted after the post). Reopening Reply
  // hydrates an EMPTY composer — the posted body is gone, not re-loaded as a draft.
  await page.getByRole('button', { name: /^reply$/i }).click();
  await expect(page.getByRole('textbox', { name: /pr-level body/i })).toHaveValue('');

  // NOTE: the spec's "the comment appears in the PR conversation" assertion is
  // NOT made here. FakePrReader.GetPrDetailAsync hard-codes
  // RootComments: Array.Empty<IssueCommentDto>() and does not read
  // FakeReviewSubmitter._issueCommentsCreated, so a posted comment never flows
  // back into the conversation list in fake mode. The achievable UI signal —
  // draft consumed, composer closed, no error — is asserted instead (the task
  // brief's stated OR-alternative).
});

test('S-discard 2 — Post failure surfaces the error row + Retry recovers', async ({ page }) => {
  await setupAndOpenScenarioPr(page);

  // Force the github.com create call to reject (afterEffect: false → it throws
  // before recording the comment). The endpoint maps the HttpRequestException to
  // a 502 github-network-error.
  await injectSubmitFailure(page.request, SubmitMethod.CreateIssueComment, {
    message: 'simulated github create-comment rejection',
  });

  await openRootComposerAndType(page, 'A body whose first Post will be rejected.');
  await page.getByRole('button', { name: /^post$/i }).click();

  // The post-error row appears with the typed code's message + a Retry button.
  const errorRow = page.locator('[data-testid="post-error"]');
  await expect(errorRow).toBeVisible({ timeout: 10_000 });
  await expect(errorRow).toContainText(/couldn't post to github/i);

  // The one-shot injection was consumed on that first call. Retry now succeeds →
  // the composer closes.
  await errorRow.getByRole('button', { name: /^retry$/i }).click();
  await expect(page.getByRole('button', { name: /^reply$/i })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid="post-error"]')).toHaveCount(0);
});

test('S-discard 3 — lost-response (afterEffect) Post errors, then a second Post succeeds', async ({
  page,
}) => {
  await setupAndOpenScenarioPr(page);

  // afterEffect: true → the github.com create lands (the comment is recorded),
  // THEN the method throws. This is the "lost response after a successful side
  // effect" window. The endpoint catches the throw and returns a 502 BEFORE it
  // stamps PostedCommentId, so the local draft is unstamped and still present.
  await injectSubmitFailure(page.request, SubmitMethod.CreateIssueComment, {
    message: 'side effect landed but the response was lost',
    afterEffect: true,
  });

  await openRootComposerAndType(page, 'A body whose first Post loses its response.');
  await page.getByRole('button', { name: /^post$/i }).click();

  // First Post surfaces the generic github error row (NOT already-posted-body-
  // mismatch — the draft was never stamped, so the second Post takes the fresh-
  // create path, not the mismatch branch).
  const errorRow = page.locator('[data-testid="post-error"]');
  await expect(errorRow).toBeVisible({ timeout: 10_000 });
  await expect(errorRow).toContainText(/couldn't post to github/i);

  // The one-shot afterEffect injection is consumed. A second Post (same body)
  // runs CreateIssueCommentAsync cleanly → 204 → composer closes.
  await errorRow.getByRole('button', { name: /^retry$/i }).click();
  await expect(page.getByRole('button', { name: /^reply$/i })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid="post-error"]')).toHaveCount(0);

  // SCENARIO-3 NOTE / FINDING: the spec § 7.3 prose says "second Post succeeds
  // with no duplicate". That guarantee is NOT assertable against the current
  // fake, and is in fact false here:
  //   - The fake's CreateIssueCommentAsync records the comment in
  //     _issueCommentsCreated on EVERY successful call, with no body-based
  //     dedup. afterEffect: true records the comment, then throws. The endpoint
  //     never stamped PostedCommentId (the throw aborted before the stamp), so
  //     the retry re-calls CreateIssueCommentAsync and records a SECOND comment
  //     — a genuine duplicate on github.com.
  //   - The "no duplicate" idempotent path (PrRootCommentEndpoints.cs: already-
  //     posted same-body → 204 with no github call) only fires when
  //     PostedCommentId is ALREADY persisted, i.e. the crash-between-stamp-and-
  //     delete window. No /test/ hook pauses the endpoint between the stamp and
  //     the draft-delete, so that window is unreachable from a Playwright spec.
  //   - There is also no issue-comment introspection endpoint
  //     (SnapshotIssueComments() is not exposed via /test/*), so the duplicate
  //     can't be asserted/refuted server-side either.
  // The achievable UI result — error row on the lost-response Post, success on
  // retry — is what this test asserts. Closing the "no duplicate" gap would need
  // either a body-dedup in the fake's CreateIssueCommentAsync or a /test/submit/
  // inspect-issue-comments introspection endpoint. Reported as a finding, not
  // papered over.
});

test('S-discard 4 — Discard the idle pending review via the PrHeader pill', async ({ page }) => {
  await stageLeftoverPendingReview(page);

  // Sanity: the leftover pending review exists on github.com (the fake's store).
  expect((await inspectPendingReview(page.request, PR)).pendingReview).not.toBeNull();

  // With the dialog closed, the pill surfaces next to Submit.
  const pill = page.locator('[data-testid="pending-review-pill"]');
  await expect(pill).toBeVisible({ timeout: 10_000 });
  await pill.click();

  // The shared confirmation modal → confirm the discard.
  const modal = page.locator('[data-testid="discard-pending-review-modal"]');
  await expect(modal).toBeVisible();
  await page.locator('[data-testid="confirm-discard-pending"]').click();

  // The pill disappears (session.pendingReviewId cleared → StateChanged refetch)
  // and the pending review is gone on github.com.
  await expect(pill).toHaveCount(0, { timeout: 10_000 });
  await expect
    .poll(async () => (await inspectPendingReview(page.request, PR)).pendingReview, {
      timeout: 10_000,
    })
    .toBeNull();
});

test('S-discard 5 — Discard the in-flight pipeline from the dialog footer', async ({ page }) => {
  await setupAndOpenScenarioPr(page);
  await createInlineDraft(page, 3, 'draft for the in-flight discard');
  await recordPrViewed(page);

  // A long Begin delay parks the pipeline inside BeginPendingReviewAsync so the
  // in-flight window is observable. The user-discard CTS cancels the await, so
  // the 5s delay resolves fast on Discard — no hard-coded sub-second sleep here;
  // Playwright auto-waits on the observable transitions.
  await setBeginDelay(page.request, 5000);

  await page.goto('/pr/acme/api/123');
  await page.getByRole('button', { name: /^submit review$/i }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^confirm submit$/i }).click();

  // The pipeline is now blocked in Begin (kind === 'in-flight'); the dialog shows
  // the "Submitting…" spinner and the Discard footer button is visible
  // (showDiscard = pendingReviewId !== null || kind === 'in-flight').
  await expect(dialog.getByText(/submitting…/i)).toBeVisible({ timeout: 10_000 });
  const discardFooter = dialog.locator('[data-testid="dialog-discard"]');
  await expect(discardFooter).toBeVisible({ timeout: 10_000 });
  await discardFooter.click();

  // Confirm in the shared modal → the discard cancels the pipeline + deletes the
  // pending review + clears stamps. The dialog closes on the 204.
  const modal = page.locator('[data-testid="discard-pending-review-modal"]');
  await expect(modal).toBeVisible();
  await page.locator('[data-testid="confirm-discard-pending"]').click();

  // The dialog returns to a clean (unmounted) state and the pending review is
  // cleared on github.com. Poll the github-side state — the begin-delay's await
  // is cancelled, so the pipeline releases and the discard completes quickly.
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(async () => (await inspectPendingReview(page.request, PR)).pendingReview, {
      timeout: 15_000,
    })
    .toBeNull();
});
