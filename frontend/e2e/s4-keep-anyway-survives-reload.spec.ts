import { test, expect, request } from '@playwright/test';
import {
  setupAndOpenScenarioPr,
  openScenarioFilesTab,
  advanceHead,
  resetBackendState,
} from './helpers/s4-setup';

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await ctx.dispose();
});

// Spec § 5.10 + plan Task 48 Step 4. Save a draft → fixture-trigger a head
// shift that makes the draft Stale → click Keep anyway → click Reload (no
// further head shift) → row stays absent from UnresolvedPanel and Drafts
// tab keeps it with an override chip → another head shift → row reappears
// (override cleared).
//
// DEFERRED — same reason as s4-multi-tab-consistency. The Keep-anyway flow
// is unit-test-covered by `OverrideStaleTests.cs` (xUnit) and
// `UnresolvedPanel.test.tsx` (vitest); this E2E is the integration check.
test.fixme('Keep-anyway survives a same-head reload then re-fires on next head shift', async ({
  page,
}) => {
  await setupAndOpenScenarioPr(page);
  await openScenarioFilesTab(page);

  await page.getByRole('treeitem', { name: /Calc\.cs/i }).click();
  await page.getByRole('button', { name: /add comment on line 3/i }).click();

  const savePromise = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/pr/acme/api/123/draft') &&
      r.request().method() === 'PUT' &&
      r.status() === 200,
    { timeout: 10_000 },
  );
  await page.getByRole('textbox', { name: /comment body/i }).fill('keep-anyway test');
  await savePromise;

  // Head shift 1: drop the anchored line → draft classified Stale.
  const newHeadSha1 = '4444444444444444444444444444444444444444';
  await advanceHead(page, newHeadSha1, [
    {
      path: 'src/Calc.cs',
      content:
        'namespace Acme;\npublic static class Calc {\n  public static int Sub(int a, int b) => a - b;\n}\n',
    },
  ]);
  await page.request.post('/api/pr/acme/api/123/reload', {
    data: { headSha: newHeadSha1 },
    headers: { Origin: 'http://localhost:5180' },
  });
  await page.reload();

  // UnresolvedPanel shows the stale draft row with a Keep-anyway action.
  await expect(page.getByRole('region', { name: /unresolved drafts/i })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole('button', { name: /keep anyway/i }).click();

  // Reload again with the SAME head sha → row stays absent from the panel.
  await page.request.post('/api/pr/acme/api/123/reload', {
    data: { headSha: newHeadSha1 },
    headers: { Origin: 'http://localhost:5180' },
  });
  await page.reload();

  await expect(page.getByRole('region', { name: /unresolved drafts/i })).not.toBeVisible();
  await page.getByRole('tab', { name: /^Drafts/i }).click();
  await expect(page.getByText(/override/i)).toBeVisible({ timeout: 10_000 });

  // Another head shift → override clears, draft re-classifies Stale.
  const newHeadSha2 = '5555555555555555555555555555555555555555';
  await advanceHead(page, newHeadSha2, [
    {
      path: 'src/Calc.cs',
      content: 'namespace Acme;\npublic static class Calc {}\n',
    },
  ]);
  await page.request.post('/api/pr/acme/api/123/reload', {
    data: { headSha: newHeadSha2 },
    headers: { Origin: 'http://localhost:5180' },
  });
  await page.reload();

  await expect(page.getByRole('region', { name: /unresolved drafts/i })).toBeVisible({
    timeout: 10_000,
  });
});
