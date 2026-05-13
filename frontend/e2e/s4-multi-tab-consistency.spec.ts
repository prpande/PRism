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

// Spec § 5.10 + plan Task 48 Step 3. Two pages in the same browser context open
// the same PR; cross-tab presence banner surfaces in both; a draft saved in tab
// A refetches in tab B via the state-changed SSE channel.
//
// IMPORTANT: both pages share ONE BrowserContext. `BroadcastChannel` is scoped
// to one browsing context group; Playwright's `browser.newContext()` creates
// isolated groups that cannot share BroadcastChannel messages, so a two-context
// shape can never see the presence banner regardless of the underlying logic.
// Production "two tabs" maps to one context + two pages, not two contexts.
test('cross-tab presence banner + draft sync across two pages', async ({ browser }) => {
  const context = await browser.newContext();
  const pageA = await context.newPage();
  await setupAndOpenScenarioPr(pageA);
  await openScenarioFilesTab(pageA);

  const pageB = await context.newPage();
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

  await context.close();
});
