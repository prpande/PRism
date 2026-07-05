import { test, expect, request } from '@playwright/test';

import {
  resetBackendState,
  setupAndOpenScenarioPr,
  createInlineDraft,
  inspectPendingReview,
  inspectReviewComments,
  setPrState,
  advanceHead,
} from './helpers/s5-submit';

// #302 Task 13 — Playwright e2e for single-comment post-now.
//
// COVERAGE:
//   1. Inline post-now: open composer, type, click "Comment" → optimistic card
//      appears; inspectReviewComments shows one inline record with correct
//      path/line/body; no pending-review was started (pendingReview is null).
//   2. Reply post-now: [FIXME — needs /test/seed-review-thread backend hook;
//      FakePrReader.GetPrDetailAsync returns Array.Empty<ReviewThreadDto>(), so
//      there is no thread to open a ReplyComposer against via the UI. The test
//      is written below with test.fixme so it will be caught when the hook
//      is added.]
//   3. Mutual exclusion: with a staged draft ("Add to review"), a second
//      composer's "Comment" button is aria-disabled and the staged composer's
//      save button reads "Add review comment".
//   4. Merged PR: on a merged PR the composer shows only "Comment" (no
//      "Add to review") with the "PR is merged — comments post immediately"
//      sub-label.
//   5. Atomic review still works after #302: stage a draft via "Add to review",
//      submit, pipeline completes → success.
//
// IMPLEMENTATION NOTES
//   — The scenario PR is acme/api/123 (src/Calc.cs). createInlineDraft seeds a
//     durable draft on line N by clicking the diff-line affordance and waiting
//     for the 250ms autosave PUT.
//   — inspectReviewComments polls /test/submit/inspect-review-comments (Task 12
//     backend + s5-submit.ts helper). It captures ALL post-now calls since the
//     last Reset(); the pending-review pipeline writes nothing there.
//   — The "Comment" button has aria-disabled (not disabled) when blocked; it is
//     never natively disabled. The "Add to review" button IS natively disabled
//     when readOnly. To assert aria-disabled use toHaveAttribute.
//   — advanceHead + setPrState combo forces a PrDetailLoader cache miss so the
//     closed/merged state becomes visible (mirrors recently-closed-readonly and
//     s5-submit-closed-merged-discard).

const PR = { owner: 'acme', repo: 'api', number: 123 };

// Advance-head constants for merged/closed scenarios (mirrors the s5 merged spec).
const NEW_HEAD = 'a'.repeat(40);
const CALC_WITH_HALF =
  'namespace Acme;\npublic static class Calc {\n  public static int Add(int a, int b) => a + b;\n  public static int Half(int a) => a / 2;\n}\n';

// #450 Task 13 — a deliberately TALL src/Calc.cs so the rendered diff overflows
// [data-app-scroll] and is genuinely scrollable. FakePrReader.GetDiffAsync emits a
// single all-`+` hunk from this content (one diff row per line), so ~150 lines
// guarantees the scroll container has non-zero scrollHeight beyond its client
// height in a 1920×1080 viewport. Line 3 is still the `Add` body, matching the
// existing "add comment on line 3" affordance the post-now path uses.
const SCROLL_HEAD = 'b'.repeat(40);
const CALC_TALL = (() => {
  const lines = [
    'namespace Acme;',
    'public static class Calc {',
    '  public static int Add(int a, int b) => a + b;',
  ];
  // Pad with many distinct method lines so the diff overflows the viewport.
  for (let i = 0; i < 150; i += 1) {
    lines.push(`  public static int M${i}(int a, int b) => a + b + ${i};`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
})();

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await ctx.dispose();
});

// ---------------------------------------------------------------------------
// Test 1 — Inline post-now happy path
// ---------------------------------------------------------------------------
test('#302 inline post-now — Comment button posts immediately, no pending review created', async ({
  page,
}) => {
  await setupAndOpenScenarioPr(page);

  // Navigate to the Files tab and open the diff so we can click a diff-line
  // affordance. The scenario PR has src/Calc.cs; line 3 is the Add method body.
  await page.goto('/pr/acme/api/123/files');
  await page.getByRole('treeitem', { name: /Calc\.cs/i }).click();

  const addBtn = page.getByRole('button', { name: /add comment on line 3/i });
  await expect(addBtn).toBeVisible({ timeout: 15_000 });
  await addBtn.click();

  const composer = page.getByTestId('inline-comment-composer');
  await expect(composer).toBeVisible();

  // Type a comment body long enough to pass the 3-char creation threshold.
  const body = 'Single inline comment via post-now.';
  await composer.getByRole('textbox', { name: /comment body/i }).fill(body);

  // The "Add to review" save button should be visible (no staged drafts yet).
  await expect(composer.getByRole('button', { name: 'Add to review' })).toBeVisible();

  // The "Comment" button should NOT be aria-disabled at this point (body is
  // non-empty, no other drafts staged, posting=false, readOnly=false).
  const commentBtn = composer.getByRole('button', { name: 'Comment', exact: true });
  await expect(commentBtn).not.toHaveAttribute('aria-disabled', 'true');

  // Click "Comment" and wait for the POST /comment/post response. The endpoint
  // returns 200 { postedCommentId } on success and fires a StateChanged SSE.
  const postPromise = page.waitForResponse(
    (r) =>
      r.url().includes('/api/pr/acme/api/123/comment/post') &&
      r.request().method() === 'POST' &&
      r.status() === 200,
    { timeout: 15_000 },
  );
  await commentBtn.click();
  await postPromise;

  // The composer should close after a successful post-now (onClose() is called
  // inside handlePostNow when res.ok is true).
  await expect(composer).toHaveCount(0, { timeout: 10_000 });

  // The optimistic placeholder card should appear at line 3 while the refetch
  // is in flight (data-testid="inline-comment-card-optimistic").
  // NOTE: the StateChanged SSE triggers a session refetch + a PrDetail refetch.
  // The placeholder dedupes against the real comment once the refetch lands
  // (matched by databaseId). We assert the placeholder appears promptly and that
  // eventually the real card (or still the optimistic, pre-dedup) shows the body.
  // The placeholder may appear and disappear quickly; wait for either the
  // optimistic card OR the text to become visible within the line widget.
  await expect(page.getByText(body).first()).toBeVisible({ timeout: 10_000 });

  // Backend assertion: exactly one inline review-comment record was created.
  const reviewComments = await inspectReviewComments(page.request);
  expect(reviewComments).toHaveLength(1);
  expect(reviewComments[0].kind).toBe('inline');
  expect(reviewComments[0].body).toBe(body);
  expect(reviewComments[0].path).toBe('src/Calc.cs');
  expect(reviewComments[0].lineNumber).toBe(3);
  expect(reviewComments[0].pr.owner).toBe(PR.owner);
  expect(reviewComments[0].pr.repo).toBe(PR.repo);
  expect(reviewComments[0].pr.number).toBe(PR.number);

  // No pending review was created — the post-now path bypasses the review pipeline
  // entirely. The pending review should still be null.
  const snapshot = await inspectPendingReview(page.request, PR);
  expect(snapshot.pendingReview).toBeNull();
  // The review-pipeline mutation counters (Begin, AttachThread) must be zero.
  expect(snapshot.attachThreadCallCount).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 1b — #450: posting an inline comment preserves diff scroll across the
// auto-reload (the single-comment-posted SSE → usePrDetail.reload()).
// ---------------------------------------------------------------------------
// Feasible-today slice of #450. The full "reply-able without reload" e2e stays
// deferred to #453 (see the test.fixme below) because FakePrReader returns no
// ReviewThreadDto, so a posted comment never round-trips back into PR detail.
// What the fake DOES support — and what this asserts — is that the optimistic
// inline card survives the auto-reload and the diff scroll offset is NOT yanked
// back to the top when the single-comment-posted reload re-renders the diff.
test('#450 inline post-now preserves diff scroll across the auto-reload', async ({ page }) => {
  await setupAndOpenScenarioPr(page);

  // Make the diff TALL so [data-app-scroll] genuinely overflows and scrolls.
  // FakePrReader serves the diff from the (path, headSha) file content, so we
  // advance the head to a large Calc.cs before opening the Files tab.
  await advanceHead(page.request, SCROLL_HEAD, [{ path: 'src/Calc.cs', content: CALC_TALL }]);

  await page.goto('/pr/acme/api/123/files');
  await page.getByRole('treeitem', { name: /Calc\.cs/i }).click();

  // The diff body is the internal vertical scroller (.diff-pane-body →
  // overflow:auto in DiffPane.module.css). In browser mode the diff scrolls
  // INTERNALLY here, not in the outer [data-app-scroll] (which only scrolls when
  // the header stack overflows). Its native scrollTop must survive the
  // single-comment-posted reload (DiffPane is not remounted on a data refetch) —
  // that is the #450 "no viewport yank" contract.
  const scroller = page.locator('.diff-pane-body');
  await expect(scroller).toBeVisible();

  // Wait for the diff to render enough rows to overflow, then scroll down.
  // Use an exact name — the tall diff has lines 3, 30, 31, … which a loose
  // regex would all match (strict-mode violation).
  const addBtn = page.getByRole('button', { name: 'Add comment on line 3', exact: true });
  await expect(addBtn).toBeVisible({ timeout: 15_000 });

  // Scroll to a non-zero offset. Assert the container is actually scrollable
  // (scrollHeight > clientHeight) before relying on the preservation check —
  // otherwise scrollTop would clamp to 0 and the assertion would be vacuous.
  const scrollBefore = await scroller.evaluate((el) => {
    el.scrollTop = 600;
    return { top: el.scrollTop, overflow: el.scrollHeight - el.clientHeight };
  });
  expect(
    scrollBefore.overflow,
    'diff must overflow [data-app-scroll] for a meaningful scroll-preservation assertion',
  ).toBeGreaterThan(0);
  expect(scrollBefore.top, 'scrollTop must be non-zero before posting').toBeGreaterThan(0);

  // Open the inline composer on line 3 (the affordance may have scrolled out of
  // view; clicking re-scrolls minimally).
  await addBtn.click();
  const composer = page.getByTestId('inline-comment-composer');
  await expect(composer).toBeVisible();

  const body = 'Scroll-preservation inline comment (#450).';
  await composer.getByRole('textbox', { name: /comment body/i }).fill(body);

  // Bring the "Comment" button fully into view BEFORE capturing the reference
  // scroll offset — this reflects the real pre-post state (a user can only click
  // a button they can see) and isolates the assertion below to the #450 contract:
  // *the reload* must not yank the diff scroll. Load-bearing since #586: the
  // composer gained a formatting-toolbar strip (~34px taller), so when it opens
  // at the extreme top of a scrolled diff its footer post-button can sit just
  // below the internal fold. Clicking a below-fold focusable triggers the
  // browser's one-time focus-scroll-into-view (React's commit-phase focus
  // restoration re-focuses the clicked button) — a normal browser behavior, NOT
  // a reload yank. Capturing the offset with the button already visible removes
  // that confound; the reload-preservation check that follows is unaffected.
  await composer.getByRole('button', { name: 'Comment', exact: true }).scrollIntoViewIfNeeded();
  const atPostScrollTop = await scroller.evaluate((el) => el.scrollTop);
  expect(atPostScrollTop, 'scrollTop must be non-zero at post time').toBeGreaterThan(0);

  // Post-now: click "Comment" and wait for the 200. The success fires a
  // single-comment-posted SSE → usePrDetail.reload() (the auto-reload under test).
  const postPromise = page.waitForResponse(
    (r) =>
      r.url().includes('/api/pr/acme/api/123/comment/post') &&
      r.request().method() === 'POST' &&
      r.status() === 200,
    { timeout: 15_000 },
  );
  await composer.getByRole('button', { name: 'Comment', exact: true }).click();
  await postPromise;

  // The optimistic inline placeholder renders immediately and survives the
  // single-comment-posted reload (it de-dups only against a real comment with a
  // matching databaseId — and FakePrReader never returns one, so it persists).
  await expect(page.getByTestId('inline-comment-card-optimistic')).toBeVisible({ timeout: 10_000 });

  // Scroll offset is preserved across the auto-reload — no viewport yank to top.
  const scrollAfter = await scroller.evaluate((el) => el.scrollTop);
  expect(Math.abs(scrollAfter - atPostScrollTop)).toBeLessThanOrEqual(2);
});

// ---------------------------------------------------------------------------
// Test 2 — Reply post-now
// ---------------------------------------------------------------------------
// FIXME: This test requires a /test/seed-review-thread endpoint that seeds a
// ReviewThreadDto into FakePrReader.GetPrDetailAsync's returned reviewComments.
// FakePrReader always returns Array.Empty<ReviewThreadDto>(), so the diff
// renders no existing comment threads and there is no ReplyComposer to interact
// with via the UI. Until that endpoint is added, this test is left as fixme so
// it shows up in the test report as blocked, not silently skipped.
test.fixme('#302 reply post-now — Comment button posts reply immediately, inspectReviewComments shows kind:reply', async ({
  page,
}) => {
  // WHEN /test/seed-review-thread is available, the setup should be:
  //   1. resetBackendState (done in beforeEach)
  //   2. POST /test/seed-review-thread { filePath:'src/Calc.cs', lineNumber:3, body:'initial comment' }
  //      → captures the assigned threadId
  //   3. setupAndOpenScenarioPr → navigate to Files tab → click Calc.cs
  //   4. The ExistingCommentWidget renders for the seeded thread at line 3;
  //      click "Reply…" to open the ReplyComposer
  //   5. Type body ≥3 chars → click "Comment"
  //   6. Assert: POST /comment/post → 200; inspectReviewComments shows 1 reply
  //      with kind:'reply', parentThreadId == seeded threadId, correct body.
  //   7. Assert: no pending review created (pendingReview null, attachReplyCallCount 0).
  void page;
});

// ---------------------------------------------------------------------------
// Test 3 — Mutual exclusion: staged draft disables "Comment" on other composers
// ---------------------------------------------------------------------------
test('#302 mutual exclusion — staged draft disables Comment; save label becomes "Add review comment"', async ({
  page,
}) => {
  // APPROACH: stage a draft on line 3 (autosave PUT completes → draftId A in
  // session), then open a SECOND composer on a DIFFERENT line (line 4). The
  // second composer has a different draftId (null at open time, assigned by
  // autosave); computeAnyOtherDraftsStaged checks for drafts with id !== own,
  // so draft A on line 3 counts as "another staged draft" → anyOtherDraftsStaged=true
  // → "Comment" aria-disabled, save label = "Add review comment".
  //
  // Calc3 (the FakePrReader fallback) has lines 3-7 as content lines. Line 4 is
  //   '  public static int Sub(int a, int b) => a - b;'
  await setupAndOpenScenarioPr(page);

  // Seed a durable draft on line 3.
  await createInlineDraft(page, 3, 'staged draft on line 3');

  // Navigate back to Files tab and load the diff.
  await page.goto('/pr/acme/api/123/files');
  await page.getByRole('treeitem', { name: /Calc\.cs/i }).click();

  // Open a SECOND composer on line 4 (a different line — its composerDraftId
  // starts as null, not matching the line-3 draft). Line 4 affordance: the
  // diff renders "add comment on line 4" for the Sub method line.
  const addBtn4 = page.getByRole('button', { name: /add comment on line 4/i });
  await expect(addBtn4).toBeVisible({ timeout: 15_000 });
  await addBtn4.click();

  const composer4 = page.getByTestId('inline-comment-composer');
  await expect(composer4).toBeVisible();

  // The session has draft A on line 3 (from createInlineDraft above), and
  // composer4's composerDraftId is null (no existing draft on line 4).
  // computeAnyOtherDraftsStaged(draftComments=[draftA], draftReplies=[], null, false)
  //   → draftA.id !== null → true → anyOtherDraftsStaged = true.
  //
  // Expected: "Comment" aria-disabled=true; save button reads "Add review comment".
  await expect(composer4.getByRole('button', { name: 'Add review comment' })).toBeVisible({
    timeout: 10_000,
  });
  const commentBtnBlocked = composer4.getByRole('button', { name: 'Comment', exact: true });
  await expect(commentBtnBlocked).toHaveAttribute('aria-disabled', 'true', { timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// Test 4 — Merged PR: only "Comment" shown, merged sub-label present, no "Add to review"
// ---------------------------------------------------------------------------
test('#302 merged PR — only Comment button shown; merged context on Comment tooltip (#390)', async ({
  page,
}) => {
  await setupAndOpenScenarioPr(page);

  // Flip to MERGED and force a PrDetailLoader cache miss by advancing the head.
  await setPrState(page.request, 'MERGED');
  await advanceHead(page.request, NEW_HEAD, [{ path: 'src/Calc.cs', content: CALC_WITH_HALF }]);
  await page.goto('/pr/acme/api/123/files');

  await page.getByRole('treeitem', { name: /Calc\.cs/i }).click();

  // Wait for the diff to render (the advanced head has src/Calc.cs content).
  const addBtnMerged = page.getByRole('button', { name: /add comment on line/i }).first();
  await expect(addBtnMerged).toBeVisible({ timeout: 15_000 });
  await addBtnMerged.click();

  const composerMerged = page.getByTestId('inline-comment-composer');
  await expect(composerMerged).toBeVisible();

  // On a merged PR (#302 post-now behavior):
  //   - The old "PR merged — text not saved" closed banner is GONE (post-now is live).
  //   - "Add to review" save button must NOT be present (closedBanner = true hides it).
  //   - "Add review comment" label must NOT be present either.
  //   - "Comment" button must be visible (and FUNCTIONAL — types and posts below).
  //   - #390: the "PR is merged" note is GONE; the merged context is on the Comment
  //     button's tooltip (title), keeping "Comment" as the accessible name.
  await expect(composerMerged.getByText(/text not saved/i)).toHaveCount(0);
  await expect(composerMerged.getByRole('button', { name: 'Add to review' })).toHaveCount(0);
  await expect(composerMerged.getByRole('button', { name: 'Add review comment' })).toHaveCount(0);
  await expect(composerMerged.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();
  await expect(composerMerged.getByText(/comments post immediately/i)).toHaveCount(0);
  await expect(
    composerMerged.getByRole('button', { name: 'Comment', exact: true }),
  ).toHaveAttribute('title', 'Post directly to this merged PR');

  // STRENGTHEN: post-now actually works on a merged PR (#302 core contract).
  // Type a body, click "Comment", assert the comment is posted.
  const mergedBody = 'Post-now comment on a merged PR.';
  await composerMerged.getByRole('textbox', { name: /comment body/i }).fill(mergedBody);

  // The "Comment" button must NOT be aria-disabled (body is non-empty, no other
  // drafts staged, posting=false, readOnly=false, and — critically after #302 —
  // merged PRs are no longer read-only from the autosave perspective).
  const commentBtnMerged = composerMerged.getByRole('button', { name: 'Comment', exact: true });
  await expect(commentBtnMerged).not.toHaveAttribute('aria-disabled', 'true');

  const postPromiseMerged = page.waitForResponse(
    (r) =>
      r.url().includes('/api/pr/acme/api/123/comment/post') &&
      r.request().method() === 'POST' &&
      r.status() === 200,
    { timeout: 15_000 },
  );
  await commentBtnMerged.click();
  await postPromiseMerged;

  // Composer closes on success.
  await expect(composerMerged).toHaveCount(0, { timeout: 10_000 });

  // The comment body becomes visible in the diff (optimistic card or real refetch).
  await expect(page.getByText(mergedBody).first()).toBeVisible({ timeout: 10_000 });

  // Backend: exactly one inline record on the merged PR, correct path/body.
  const mergedReviewComments = await inspectReviewComments(page.request);
  expect(mergedReviewComments).toHaveLength(1);
  expect(mergedReviewComments[0].kind).toBe('inline');
  expect(mergedReviewComments[0].body).toBe(mergedBody);
  expect(mergedReviewComments[0].path).toBe('src/Calc.cs');
  expect(mergedReviewComments[0].pr.owner).toBe(PR.owner);
  expect(mergedReviewComments[0].pr.repo).toBe(PR.repo);
  expect(mergedReviewComments[0].pr.number).toBe(PR.number);
});

// ---------------------------------------------------------------------------
// Test 5 — Atomic review still works after #302: the submit pipeline is untouched
// ---------------------------------------------------------------------------
// Regression guard: the post-now feature must not break the existing review
// submit flow. Mirrors s5-submit-happy-path but simplified (no PR-root body).
test('#302 regression — atomic review submit still works', async ({ page }) => {
  await setupAndOpenScenarioPr(page);

  // Seed one inline draft (line 3), stamp the head sha for the drift gate,
  // then submit the review. The pipeline should run to completion.
  await createInlineDraft(page, 3, 'regression draft for atomic review');

  // Record the viewed head sha (the drift gate requires it).
  const { recordPrViewed } = await import('./helpers/s5-submit');
  await recordPrViewed(page);

  await page.goto('/pr/acme/api/123');

  const submitBtn = page.getByRole('button', { name: /^submit review$/i });
  await expect(submitBtn).toBeEnabled({ timeout: 10_000 });
  await submitBtn.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /^confirm submit$/i }).click();

  await expect(page.getByRole('heading', { name: /review submitted/i })).toBeVisible({
    timeout: 15_000,
  });

  // Confirm no review comments were posted via the post-now path (the submit
  // pipeline uses AttachThread, not CreateReviewCommentAsync).
  const reviewComments = await inspectReviewComments(page.request);
  expect(reviewComments).toHaveLength(0);

  const snapshot = await inspectPendingReview(page.request, PR);
  // After finalize, pendingReview is null and attachThreadCallCount is 1.
  expect(snapshot.pendingReview).toBeNull();
  expect(snapshot.attachThreadCallCount).toBe(1);
});
