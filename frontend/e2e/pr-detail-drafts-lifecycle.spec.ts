import { test, expect, request, type Route } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr, createInlineDraft } from './helpers/s5-submit';

// #744 — full draft-lifecycle E2E: create / edit / discard reflect in the Drafts
// tab promptly, across the Files-inline and Overview PR-root composer surfaces,
// and the reconciliation refetch neither loses nor duplicates a row.
//
// Scenario PR: acme/api/123 (src/Calc.cs), the canonical FakeReviewService PR.
// Assertions poll the observable (expect auto-retries) — no fixed delays.
//
// discard-all-stale is NOT re-exercised here: making a draft genuinely `stale`
// needs an advance-head dance, and the bulk path shares the exact same
// `removeDraftLocally` seam, unit-tested (incl. partial-failure) in
// DiscardAllStaleButton.test.tsx. The E2E covers the single-row discard path.

const PR = 'acme/api/123';
const DRAFT_URL_RE = /\/api\/pr\/acme\/api\/123\/draft$/;

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await ctx.dispose();
});

// Opens the Overview PR-root composer, types a body, and waits for its create
// PUT to land (newPrRootDraftComment on the same /draft endpoint).
async function createOverviewDraft(page: import('@playwright/test').Page, body: string) {
  await page.goto(`/pr/${PR}`);
  const reply = page.getByRole('button', { name: /Reply to the PR conversation/i });
  await reply.waitFor({ state: 'visible', timeout: 20_000 });
  await reply.click();
  const textarea = page.getByRole('textbox', { name: /PR-level body/i });
  await textarea.waitFor({ state: 'visible' });
  const savePromise = page.waitForResponse(
    (r) => DRAFT_URL_RE.test(r.url()) && r.request().method() === 'PUT' && r.status() === 200,
    { timeout: 10_000 },
  );
  await textarea.fill(body);
  await savePromise;
}

function draftsSlot(page: import('@playwright/test').Page) {
  return page.locator('[data-subtab="drafts"]');
}

async function openDraftsTab(page: import('@playwright/test').Page) {
  await page.getByTestId('pr-tab-drafts').click();
  await expect(page.getByTestId('drafts-tab-root')).toBeVisible({ timeout: 15_000 });
}

test('create reflects in the Drafts tab promptly on both composer surfaces', async ({ page }) => {
  await setupAndOpenScenarioPr(page);

  // Case 2 — Files-tab inline create.
  await createInlineDraft(page, 3, 'inline draft alpha');
  await openDraftsTab(page);
  await expect(draftsSlot(page).getByText('inline draft alpha')).toBeVisible({ timeout: 10_000 });

  // Case 2 — Overview PR-root create. Appears alongside the inline draft.
  await createOverviewDraft(page, 'pr root draft beta');
  await openDraftsTab(page);
  await expect(draftsSlot(page).getByText('pr root draft beta')).toBeVisible({ timeout: 10_000 });
  await expect(draftsSlot(page).getByText('inline draft alpha')).toBeVisible();

  // Count badge on the Drafts tab reflects both.
  await expect(
    page.getByTestId('pr-tab-drafts').locator('[data-testid="pr-tab-count"]'),
  ).toContainText('2', { timeout: 10_000 });
});

// Note on "edit": an in-place edit is NOT an optimistic-insert path (#744 adds
// insert + remove seams, not an edit seam). While the composer stays open,
// `mergeSession`'s open-composer rule intentionally preserves the session's body
// over a refetch, so the Drafts preview reflects the edit only once the composer
// closes — pre-existing behavior, unchanged here and covered by the existing
// useDraftSession merge tests. It is deliberately not re-asserted in this E2E.

test('discard clears the row optimistically, even with the refetch held, and it does not resurrect', async ({
  page,
}) => {
  await setupAndOpenScenarioPr(page);
  await createInlineDraft(page, 3, 'discard me');
  await openDraftsTab(page);
  await expect(draftsSlot(page).getByText('discard me')).toBeVisible({ timeout: 10_000 });

  // Hold every reconciliation refetch (GET /draft) so the ONLY thing that can
  // clear the row is the optimistic local removal — proving the seam, not the
  // refetch. The initial session load already happened above, so holding all
  // GETs from here is safe.
  let releaseRefetch: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseRefetch = resolve;
  });
  await page.route(DRAFT_URL_RE, async (route: Route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await gate; // hold the refetch until the optimistic assertion has run
    // The gate may resolve after the request already settled elsewhere; swallow
    // a benign "already handled".
    await route.continue().catch(() => undefined);
  });

  // Discard from the Drafts tab → confirm in the modal.
  await draftsSlot(page).getByRole('button', { name: 'Discard' }).click();
  await page.locator('[data-modal-role="primary"]').click();

  // The row is gone while the refetch is still held → optimistic removal is the
  // only thing that could have cleared it.
  await expect(draftsSlot(page).getByText('discard me')).toHaveCount(0, { timeout: 10_000 });

  // Release the held refetch; reconciliation must NOT resurrect the discarded
  // row (server no longer returns it). Leave the route registered — the gate is
  // resolved, so any further GET passes straight through.
  releaseRefetch();
  await expect(draftsSlot(page).getByText('discard me')).toHaveCount(0, { timeout: 10_000 });
});
