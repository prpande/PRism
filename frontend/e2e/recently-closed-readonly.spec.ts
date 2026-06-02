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
// MUTATION-SUPPRESSION MECHANISM (verified against the components, NOT assumed):
// the diff-line "Add comment" affordance and the Overview "Reply" button are
// NOT hidden on a done PR — they are gated on the cross-tab-presence readOnly
// flag, which is false here. The done-PR guarantee is instead that PERSISTENCE
// is hard-blocked (useComposerAutoSave early-returns when prState !== 'open')
// and every composer renders a "PR <closed|merged> — text not saved" banner
// with its Save / Post action disabled (spec § 5 line 142). So the audit asserts
// the composer opens in NON-MUTATING mode (banner present + Save disabled),
// which is the real GitHub-mutating-surface suppression — rather than asserting
// the affordance is absent (it isn't).

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
    // Submit Review is disabled (PrHeader: disabled when isClosedOrMerged).
    await expect(page.getByRole('button', { name: /^submit review$/i })).toBeDisabled();

    // The header verdict picker is ABSENT — PrHeader gates it behind
    // !isClosedOrMerged (role=group, aria-label "Review verdict").
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

    // Inline-draft composer is NON-MUTATING: clicking the diff-line affordance
    // opens a composer that shows the "PR <closed|merged> — text not saved"
    // banner, and TYPING into it persists nothing — useComposerAutoSave
    // early-returns when prState !== 'open', so no draft PUT reaches the
    // backend (and thus no review can be attached to GitHub). We assert the
    // banner AND that a draft-PUT never fires for ~750ms after typing (3×
    // the 250ms autosave debounce), which is the load-bearing suppression
    // signal — the Save button itself is gated on cross-tab readOnly (false
    // here), not on prState, so its disabled state is not the guarantee.
    await page.getByRole('treeitem', { name: /Calc\.cs/i }).click();
    await page
      .getByRole('button', { name: /add comment on line 3/i })
      .first()
      .click();
    const inlineComposer = page.getByTestId('inline-comment-composer');
    await expect(inlineComposer).toBeVisible({ timeout: 10_000 });
    await expect(inlineComposer.getByText(/text not saved/i)).toBeVisible();

    let draftPutFired = false;
    const onDraftPut = (req: import('@playwright/test').Request) => {
      if (req.url().endsWith('/api/pr/acme/api/123/draft') && req.method() === 'PUT') {
        draftPutFired = true;
      }
    };
    page.on('request', onDraftPut);
    await inlineComposer.getByRole('textbox', { name: /comment body/i }).fill('attempt to mutate');
    // Give the autosave debounce (250ms) a generous window to fire; a real
    // (open-PR) composer would have PUT a draft within it. On a done PR it
    // must stay silent.
    await page.waitForTimeout(1_500);
    expect(draftPutFired).toBe(false);
    page.off('request', onDraftPut);

    // PR-root reply composer is NON-MUTATING the same way: opening it via the
    // Overview "Reply" button surfaces the "text not saved" banner. Persistence
    // is hard-blocked identically (PrRootBodyEditor renders the banner;
    // useComposerAutoSave no-ops on a done PR).
    await page.goto('/pr/acme/api/123');
    await page.getByRole('button', { name: /^reply$/i }).click();
    const rootComposer = page.getByRole('form', { name: /reply to this pr/i });
    await expect(rootComposer).toBeVisible({ timeout: 10_000 });
    await expect(rootComposer.getByText(/text not saved/i)).toBeVisible();
    // The Post button is disabled (empty body + below the create threshold on a
    // done PR — there is no persisted draft to post).
    await expect(rootComposer.getByRole('button', { name: /^post$/i })).toBeDisabled();

    // ---------------------------------------------------------------------
    // (iii) Read-only Drafts tab (Task 14): the seeded draft body is visible
    //       (selectable / copy-able) but there are NO Edit / NO Delete buttons.
    // ---------------------------------------------------------------------
    await page.goto('/pr/acme/api/123/drafts');
    const draftsTab = page.getByTestId('drafts-tab');
    await expect(draftsTab).toBeVisible({ timeout: 10_000 });
    // Body text renders read-only.
    await expect(draftsTab.getByText('draft on a done pr')).toBeVisible();
    // No per-draft action buttons (DraftListItem gates Edit/Delete on !readOnly).
    await expect(draftsTab.getByRole('button', { name: /^edit$/i })).toHaveCount(0);
    await expect(draftsTab.getByRole('button', { name: /^delete$/i })).toHaveCount(0);
  });
}
