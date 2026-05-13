import { test, expect, request } from '@playwright/test';
import type { Page } from '@playwright/test';

import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s5-submit';

// Plan Task 69. The composer-side guard for the `<!-- prism:client-id: -->`
// marker prefix: a draft body whose literal text contains the marker substring
// *outside* a fenced code block is rejected by PUT /api/pr/{ref}/draft (so a
// hostile/accidental body can't impersonate the pipeline's idempotency markers).
// A body where the substring lives inside a ``` fence is fine — those are
// quoted, not active markers.
//
// DEVIATION FROM THE TASK BRIEF: the brief said the rejected save lands the
// composer in the `rejected` badge state. In fact PrDraftEndpoints returns
// HTTP 400 (`code: "marker-prefix-collision"`), and the composer's
// applyErrorBadge only maps HTTP 422 (`invalid-body`) → `rejected`; a 400
// (`bad-request`) falls through to `unsaved` (keep-local-body, retry-on-edit).
// So this spec asserts: the composer goes to `unsaved` (the save did NOT take)
// and no draft was persisted server-side. The fenced-block case still saves
// cleanly (`saved` badge, a draft is created).
//
// No submit pipeline here; no recordPrViewed / setBeginDelay needed.

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await ctx.dispose();
});

async function openInlineComposer(page: Page) {
  await page.goto('/pr/acme/api/123/files');
  await page.getByRole('treeitem', { name: /Calc\.cs/i }).click();
  const addBtn = page.getByRole('button', { name: /add comment on line 3/i });
  await addBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await addBtn.click();
  const textarea = page.getByRole('textbox', { name: /comment body/i });
  await textarea.waitFor({ state: 'visible' });
  await expect(textarea).toBeFocused();
  return textarea;
}

// Scoped to the composer's <span class="composer-badge"> so we read THIS
// composer's state, not some other status region on the page.
function composerBadge(page: Page) {
  return page.locator('.inline-comment-composer .composer-badge');
}

test('S5 marker-prefix collision — a body carrying the PRism client-id marker (bare) is rejected by the server', async ({
  page,
}) => {
  await setupAndOpenScenarioPr(page);
  const textarea = await openInlineComposer(page);

  // A bare marker substring outside any fence → PUT /draft 400
  // (marker-prefix-collision) → the save never lands; the composer badge ends
  // up `unsaved` (not `rejected` — see the DEVIATION note above).
  await textarea.fill('before <!-- prism:client-id:fake --> after');

  await expect(composerBadge(page)).toHaveText('unsaved', { timeout: 10_000 });

  // The body was rejected server-side: nothing persisted. Reload the page and
  // confirm the Drafts tab is empty (the count chip only renders for a real
  // draft; the own-tab SSE filter means a reload is the way to re-fetch the
  // session, but here there's nothing to fetch).
  await page.reload();
  await page.getByRole('tab', { name: /^Drafts/i }).click();
  await expect(page.getByText(/prism:client-id:fake/)).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^Drafts/i }).locator('.pr-tab-count')).toHaveCount(0);
});

test('S5 marker-prefix collision — the same substring inside a fenced code block is accepted', async ({
  page,
}) => {
  await setupAndOpenScenarioPr(page);
  const textarea = await openInlineComposer(page);

  // Inside a ``` fence the substring is quoted text, not an active marker — the create PUT
  // succeeds. Wait for the auto-save round-trip (any status) so we know the persistence attempt
  // landed, then assert the response was 200 and the draft survived a reload. Watching the badge
  // alone is racy here because the composer starts at `saved` (empty body) — `toHaveText('saved')`
  // can resolve before the typing's debounce + PUT have fired.
  const savePromise = page.waitForResponse(
    (r) => r.url().endsWith('/api/pr/acme/api/123/draft') && r.request().method() === 'PUT',
    { timeout: 15_000 },
  );
  await textarea.fill('```\n<!-- prism:client-id:literal -->\n```');
  const resp = await savePromise;
  expect(resp.status()).toBe(200);

  // The draft is persisted — reload and find the body on the Drafts tab + the
  // Drafts-tab count chip showing 1.
  await page.reload();
  await page.getByRole('tab', { name: /^Drafts/i }).click();
  await expect(page.getByText('prism:client-id:literal').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('tab', { name: /^Drafts/i }).locator('.pr-tab-count')).toHaveText(
    '1',
    { timeout: 10_000 },
  );
});
