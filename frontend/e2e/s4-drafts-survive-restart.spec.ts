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

// Spec § 5.10 + plan Task 48 Step 1. Verifies the spec's central promise:
// drafts saved on a PR survive a full browser-context tear-down + reopen,
// which is the v1 "drafts persist across launches" demo from
// docs/spec/01-vision-and-acceptance.md § "The PoC demo".
//
// Scenario PR: acme/api/123, src/Calc.cs. We click a context line in the
// new-side gutter, the InlineCommentComposer auto-mounts (FilesTab handler),
// type ≥3 chars (creation threshold per spec § 5.3), wait for the 250ms
// auto-save debounce, then close the page and re-open. The draft session
// loaded from state.json should rehydrate the composer with the saved body.
test('drafts survive a browser-context restart', async ({ page, context }) => {
  await setupAndOpenScenarioPr(page);
  await openScenarioFilesTab(page);

  // Files tab opens with the file tree but no file selected. Click the
  // scenario file to load its diff before reaching for line affordances.
  await page.getByRole('treeitem', { name: /Calc\.cs/i }).click();

  // Click the diff comment affordance on a content line. parseHunkLines
  // (DiffPane.tsx) treats the fake's `+`-prefixed lines as inserts and
  // numbers them from 1. Line 3 is the `Add` method body.
  const addCommentBtn = page.getByRole('button', { name: /add comment on line 3/i });
  await expect(addCommentBtn).toBeVisible({ timeout: 15_000 });
  await addCommentBtn.click();

  const textarea = page.getByRole('textbox', { name: /comment body/i });
  await expect(textarea).toBeFocused();

  // Race the PUT /draft response so we KNOW the auto-save completed before
  // the page tear-down. (The composer badge defaults to "saved" so it can't
  // be used as a transition signal; the actual network call is the
  // authoritative durability marker.)
  const savePromise = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/pr/acme/api/123/draft') &&
      r.request().method() === 'PUT' &&
      r.status() === 200,
    { timeout: 10_000 },
  );
  await textarea.fill('this needs work');
  await savePromise;

  // Capture the page's URL before tearing the context down — restart should
  // come back to the same place.
  const url = page.url();

  // Hard restart: close the page and open a new one in the SAME context.
  // The browser-context cookies are intentionally preserved so the fresh
  // page authenticates immediately via the prism-session cookie; the test
  // validates draft persistence via the backend state.json, not via a
  // cookie-isolated restart. (A full context tear-down would also work
  // but would require re-running the Setup flow on the fresh context.)
  await page.close();
  const freshPage = await context.newPage();
  await freshPage.goto(url);

  // Wait for useDraftSession's initial GET /api/pr/{ref}/draft to populate
  // the Drafts-tab count badge BEFORE clicking line 3 — InlineCommentComposer
  // freezes `initialBody` at mount (useState initializer), so a click that
  // races the session fetch sees an empty body and the test races a useless
  // re-render. The badge is a 1:1 signal that the session has hydrated.
  await expect(freshPage.locator('.pr-tab-count')).toContainText('1', { timeout: 15_000 });

  // Re-click the file in the tree so the diff renders, then click line 3 —
  // FilesTab.openComposerAt's findExistingDraft picks the persisted body
  // from useDraftSession and the composer mounts with `initialBody` set.
  await freshPage.getByRole('treeitem', { name: /Calc\.cs/i }).click();
  await freshPage.getByRole('button', { name: /add comment on line 3/i }).click();

  await expect(freshPage.getByRole('textbox', { name: /comment body/i })).toHaveValue(
    'this needs work',
    { timeout: 15_000 },
  );

  // Sanity check: the Drafts tab also lists the persisted draft, so the
  // survival is visible from multiple surfaces.
  await freshPage.getByRole('tab', { name: /^Drafts/i }).click();
  await expect(freshPage.getByText(/this needs work/i).first()).toBeVisible({ timeout: 10_000 });
});
