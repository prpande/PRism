import { test, expect, request } from '@playwright/test';
import {
  setupAndOpenScenarioPr,
  openScenarioFilesTab,
  resetBackendState,
} from './helpers/s4-setup';

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await ctx.dispose();
});

// Spec § 5.10 + plan Task 48 Step 3. Two browser contexts open the same PR;
// cross-tab presence banner surfaces in both; a draft saved in tab A
// refetches in tab B via the state-changed SSE channel.
//
// DEFERRED to a follow-up: this spec passes in isolation but interacts
// flakily with shipped specs in the same suite run because the FakeReview
// scenario state + state.json drafts shared across the Playwright run can
// leak between specs (see deferrals doc § "S4 PR7 multi-spec state leak").
// The hook + banner are exercised in vitest unit tests
// (useCrossTabPrPresence.test.ts) — this E2E is the cross-process
// confidence check.
test.fixme('cross-tab presence banner + draft sync across two contexts', async ({ browser }) => {
  // Tab A
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  await setupAndOpenScenarioPr(pageA);
  await openScenarioFilesTab(pageA);

  // Tab B in a separate context (= separate browser tab in real life)
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await setupAndOpenScenarioPr(pageB);
  await openScenarioFilesTab(pageB);

  // Both tabs should see the cross-tab presence banner.
  await expect(pageA.getByText(/another tab|saves may overwrite/i)).toBeVisible({
    timeout: 10_000,
  });
  await expect(pageB.getByText(/another tab|saves may overwrite/i)).toBeVisible({
    timeout: 10_000,
  });

  // Save a draft in tab A.
  await pageA.getByRole('treeitem', { name: /Calc\.cs/i }).click();
  await pageA.getByRole('button', { name: /add comment on line 3/i }).click();
  const savePromise = pageA.waitForResponse(
    (r) =>
      r.url().endsWith('/api/pr/acme/api/123/draft') &&
      r.request().method() === 'PUT' &&
      r.status() === 200,
    { timeout: 10_000 },
  );
  await pageA.getByRole('textbox', { name: /comment body/i }).fill('cross-tab test');
  await savePromise;

  // Tab B picks up the state-changed SSE event and refetches the session;
  // the Drafts-tab badge transitions 0 → 1.
  await expect(pageB.locator('.pr-tab-count')).toContainText('1', { timeout: 15_000 });

  await contextA.close();
  await contextB.close();
});
