import { test, expect, request, type Page } from '@playwright/test';

import {
  resetBackendState,
  setupAndOpenScenarioPr,
  createInlineDraft,
  setPrState,
  advanceHead,
} from './helpers/s5-submit';

// Plan Task 16b / spec § 5.1 + § 5.2.2 — read-only PR detail AUDIT.
//
// Opens a MERGED PR and a CLOSED-unmerged PR and confirms, end to end, that
//   (i)   every GitHub-mutating surface is suppressed on a done PR,
//   (ii)  the diff still RENDERS (file rows present, NO error banner) — the
//         core "done PRs stay fully readable" guarantee, and
//   (iii) a pre-existing draft shows up on the Drafts tab read-only (no
//         Edit / Delete), and
//   (iv)  the header shows the Merged / Closed status label (Task 13).
//
// DEFERRED (spec § 8): the real-flow MID-VIEW-MERGE transition e2e (a PR that
// merges live mid-session, surfacing the transition banner) needs a sandbox PR
// that merges mid-session and is recorded as deferred in Task 17. This spec
// covers only the STATIC read-only audit on an already-done PR.
//
// HOW "DONE" IS MADE VISIBLE (the loader-cache recipe, mirrored from
// s5-submit-closed-merged-discard.spec.ts): PrDetailLoader caches the
// PrDetailDto by (prRef, headSha). `setPrState('MERGED'|'CLOSED')` mutates the
// backing store but does NOT change the head sha, so a bare reload re-serves the
// cached (open) DTO. We ALSO push a new head sha via `advanceHead` (keeping
// line 3 intact so any anchored draft stays anchored), which forces a loader
// cache miss; the next GET /api/pr/{ref} re-fetches the detail with the done
// state + the (now non-null) mergedAt / closedAt the fake derives from it.
//
// MUTATION-SUPPRESSION MECHANISM (updated for #302 post-now):
// the diff-line "Add comment" affordance and the Overview "Reply" button are
// NOT hidden on a done PR — they are gated on the cross-tab-presence readOnly
// flag, which is false here. Before #302, the done-PR guarantee was that
// PERSISTENCE was hard-blocked (useComposerAutoSave early-returned when
// prState !== 'open') and every inline/reply composer rendered a "text not saved"
// banner. #302 intentionally removed that guard: drafts now stage on done PRs
// so the post-now "Comment" button has a draft id to ship, and GitHub permits
// comments on merged PRs. The mutation-suppression guarantee is now:
//   - The REVIEW SUBMIT pipeline remains hard-blocked (Submit Review disabled).
//   - Single-comment post-now IS allowed (GitHub permits it; spec § 5.1 updated).
//   - The "text not saved" banner is gone; InlineCommentComposer and
//     ReplyComposer instead show "comments post immediately".
// This spec's inline-composer block is updated to reflect the new contract.

const NEW_HEAD = 'a'.repeat(40);
// src/Calc.cs with line 3 (the Add method) preserved so a line-3 draft stays
// anchored across the head advance; line 4 (Half) is the cache-busting delta.
const CALC_WITH_HALF =
  'namespace Acme;\npublic static class Calc {\n  public static int Add(int a, int b) => a + b;\n  public static int Half(int a) => a / 2;\n}\n';

type DoneState = 'MERGED' | 'CLOSED';

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await ctx.dispose();
});

// Flips the scenario PR to the given done state and forces the loader to
// re-fetch the (now done) detail by advancing the head sha (line 3 preserved →
// any anchored draft stays anchored). Mirrors the template's closePrAndRefresh.
async function setDonePrAndRefresh(page: Page, state: DoneState): Promise<void> {
  await setPrState(page.request, state);
  await advanceHead(page.request, NEW_HEAD, [{ path: 'src/Calc.cs', content: CALC_WITH_HALF }]);
  await page.goto('/pr/acme/api/123');
}

// One parameterized body for both MERGED and CLOSED-unmerged — the read-only
// audit is identical bar the header status label.
for (const { state, label } of [
  { state: 'MERGED' as const, label: /merged/i },
  { state: 'CLOSED' as const, label: /closed/i },
]) {
  test(`read-only audit — ${state} PR suppresses mutations, diff + drafts render read-only`, async ({
    page,
  }) => {
    // Seed a durable inline draft on line 3 while the PR is still open, so the
    // Drafts tab has something to render read-only after the flip (§ 5.2.2).
    await setupAndOpenScenarioPr(page);
    await createInlineDraft(page, 3, 'draft on a done pr');

    await setDonePrAndRefresh(page, state);

    // ---------------------------------------------------------------------
    // (iv) Header status label (Task 13) — cheap, asserted first so a missing
    //      mergedAt/closedAt fails loud rather than masquerading as a later
    //      assertion failure.
    // ---------------------------------------------------------------------
    const header = page.getByTestId('pr-header');
    await expect(header).toContainText(label, { timeout: 10_000 });

    // ---------------------------------------------------------------------
    // (i) Every GitHub-mutating surface is suppressed.
    // ---------------------------------------------------------------------
    // New header UI (#291): on a done PR the Review split-button collapses to a
    // non-mutating "Drafts" affordance — there is NO Submit Review control at all
    // (the submit surface is gone, not merely disabled), so the mutation entry
    // point is fully suppressed.
    await expect(page.getByTestId('review-action-main')).toContainText(/drafts/i);
    await expect(page.getByRole('button', { name: /^submit review$/i })).toHaveCount(0);

    // The header verdict picker is ABSENT — verdicts moved into the caret menu,
    // which on a done PR offers only "Discard all drafts" (no verdict group, no
    // submit). The old role=group "Review verdict" picker never renders now.
    await expect(page.getByRole('group', { name: /review verdict/i })).toHaveCount(0);

    // ---------------------------------------------------------------------
    // (ii) The diff RENDERS — file rows present, NO error banner.
    // ---------------------------------------------------------------------
    await page.goto('/pr/acme/api/123/files');
    // File-tree rows render (the fake serves a normal one-file diff for the
    // advanced head — there must be at least one row).
    await expect(page.getByTestId('files-tab-tree-row').first()).toBeVisible({ timeout: 15_000 });
    // Neither the generic "Failed to load diff" banner nor the typed
    // diff-unavailable surface (Task 16a) is present — the diff actually
    // rendered, it did not error.
    await expect(page.getByTestId('diff-unavailable')).toHaveCount(0);
    await expect(page.getByText(/failed to load diff/i)).toHaveCount(0);

    // The diff content itself rendered (the seeded src/Calc.cs Add line).
    await expect(
      page.getByText(/public static int Add\(int a, int b\) => a \+ b;/).first(),
    ).toBeVisible();

    // Inline-draft composer on a done PR (#302-updated contract):
    //
    // Before #302, useComposerAutoSave early-returned when prState !== 'open',
    // so no draft PUT would fire and the composer showed a "text not saved"
    // banner. #302 intentionally relaxed that guard so that:
    //   (a) drafts DO stage on merged/closed PRs (enabling post-now), and
    //   (b) the "text not saved" banner is gone — replaced by a
    //       "comments post immediately" note (InlineCommentComposer line ~364).
    //
    // The GitHub-mutation suppression guarantee is NOW enforced differently:
    //   - The REVIEW SUBMIT pipeline is still hard-blocked (Submit Review button
    //     disabled above), so no multi-comment review can be attached to GitHub.
    //   - Single-comment post-now IS allowed on done PRs (GitHub permits it).
    //
    // What this block now asserts:
    //   (a) the old "text not saved" banner is GONE,
    //   (b) the "comments post immediately" note is VISIBLE,
    //   (c) a draft PUT DOES fire after typing (the new expected behavior —
    //       drafts stage so the post-now path has an id to ship).
    await page.getByRole('treeitem', { name: /Calc\.cs/i }).click();
    await page
      .getByRole('button', { name: /add comment on line 3/i })
      .first()
      .click();
    const inlineComposer = page.getByTestId('inline-comment-composer');
    await expect(inlineComposer).toBeVisible({ timeout: 10_000 });
    // OLD banner is gone (#302).
    await expect(inlineComposer.getByText(/text not saved/i)).toHaveCount(0);
    // #390 — the inline "comments post immediately" note is gone; the merged/closed
    // context now lives on the Comment button's tooltip (title), keeping "Comment"
    // as the accessible name.
    await expect(inlineComposer.getByText(/comments post immediately/i)).toHaveCount(0);
    await expect(
      inlineComposer.getByRole('button', { name: 'Comment', exact: true }),
    ).toHaveAttribute('title', /Post directly to this (merged|closed) PR/);

    let draftPutFired = false;
    const onDraftPut = (req: import('@playwright/test').Request) => {
      if (req.url().endsWith('/api/pr/acme/api/123/draft') && req.method() === 'PUT') {
        draftPutFired = true;
      }
    };
    page.on('request', onDraftPut);
    await inlineComposer.getByRole('textbox', { name: /comment body/i }).fill('attempt to mutate');
    // Give the autosave debounce (250ms) a generous window to fire; after
    // #302 the draft DOES stage (prState guard removed from useComposerAutoSave).
    await page.waitForTimeout(1_500);
    // #302: drafts now stage on done PRs so the post-now path has a draft id.
    expect(draftPutFired).toBe(true);
    page.off('request', onDraftPut);

    // PR-root reply composer on a done PR: opening it via the Overview "Reply"
    // button shows the composer. PrRootReplyComposer does not render a
    // closed-state banner (no "text not saved", no "comments post immediately"
    // note — the root reply path is not yet hooked into post-now per #302 scope).
    // The still-valid invariant: the Post button is disabled when the body is
    // empty (postDisabled = bodyEmpty || belowCreateThreshold) — this holds
    // regardless of prState.
    await page.goto('/pr/acme/api/123');
    await page.getByRole('button', { name: /^reply to the PR conversation$/i }).click();
    const rootComposer = page.getByRole('form', { name: /reply to this pr/i });
    await expect(rootComposer).toBeVisible({ timeout: 10_000 });
    // The Post button is disabled (empty body — no persisted draft to post).
    await expect(rootComposer.getByRole('button', { name: /^post$/i })).toBeDisabled();

    // ---------------------------------------------------------------------
    // (iii) Read-only Drafts tab (Task 14): the draft body is visible
    //       (selectable / copy-able) but there are NO Edit / NO Delete buttons.
    // NOTE: after #302 the mutation block above DOES fire a draft PUT, so the
    // draft on line 3 now contains "attempt to mutate" (the update replaced the
    // seeded "draft on a done pr"). We assert the most-recently-persisted body.
    // ---------------------------------------------------------------------
    await page.goto('/pr/acme/api/123/drafts');
    const draftsTab = page.getByTestId('drafts-tab-root');
    await expect(draftsTab).toBeVisible({ timeout: 10_000 });
    // Body text renders read-only (updated by the autosave in section ii above).
    await expect(draftsTab.getByText('attempt to mutate')).toBeVisible();
    // No per-draft action buttons (DraftListItem gates Edit/Delete on !readOnly).
    await expect(draftsTab.getByRole('button', { name: /^edit$/i })).toHaveCount(0);
    await expect(draftsTab.getByRole('button', { name: /^delete$/i })).toHaveCount(0);
  });
}
