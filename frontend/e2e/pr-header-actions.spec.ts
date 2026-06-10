// frontend/e2e/pr-header-actions.spec.ts
//
// Task 11 — e2e coverage for the #291 PR-detail header redesign.
//
// The old 7-control action cluster was replaced by:
//   • ReviewActionButton (main split + chevron caret menu)  data-testid="review-action-main/chevron"
//   • AskAiPullTab (fixed right-margin pull-tab)            data-testid="ask-ai-pull-tab"
//   • Open-in-GitHub icon-only (unchanged testid)           data-testid="open-in-github-button"
//
// All tests use the hermetic acme/api/123 scenario PR (FakeReviewService) via
// setupAndOpenScenarioPr. AI tests enable aiPreview via POST /api/preferences
// then reload (mirrors ask-ai-drawer.spec.ts).

import { test, expect } from '@playwright/test';
import { BACKEND_ORIGIN } from './helpers/backend-origin';
import {
  resetBackendState,
  setupAndOpenScenarioPr,
  createInlineDraft,
  recordPrViewed,
  injectSubmitFailure,
  SubmitMethod,
} from './helpers/s5-submit';

const VIEWPORT_DEFAULT = { width: 1440, height: 900 };
const VIEWPORT_NARROW = { width: 900, height: 900 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function enableAiPreview(page: import('@playwright/test').Page): Promise<void> {
  const resp = await page.request.post(`${BACKEND_ORIGIN}/api/preferences`, {
    data: { aiPreview: true },
    headers: { Origin: BACKEND_ORIGIN },
  });
  expect(resp.ok()).toBe(true);
}

async function disableAiPreview(page: import('@playwright/test').Page): Promise<void> {
  await page.request.post(`${BACKEND_ORIGIN}/api/preferences`, {
    data: { aiPreview: false },
    headers: { Origin: BACKEND_ORIGIN },
  });
}

// Utility: returns true if two bounding boxes overlap (shares at least 1px).
function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

// Opens the chevron menu on the ReviewActionButton.
async function openChevronMenu(page: import('@playwright/test').Page) {
  const chevron = page.getByTestId('review-action-chevron');
  await expect(chevron).toBeVisible();
  await chevron.click();
  await expect(page.getByRole('menu', { name: 'Review actions' })).toBeVisible();
}

// Selects a verdict from the open caret menu.
async function selectVerdict(page: import('@playwright/test').Page, label: string) {
  const menu = page.getByRole('menu', { name: 'Review actions' });
  await menu.getByRole('menuitem', { name: label }).click();
}

// Stages a leftover OWN pending review (not "foreign"): injects a failure at
// AttachThread so Begin succeeds (creates the review) but the pipeline aborts
// mid-flight; Cancel in the failed-state dialog stamps session.pendingReviewId.
// This is the only reliable path to get `session.pendingReviewId !== null` in
// the fake backend without the full Submit happy-path, which would clear it on
// success.
async function stageOwnPendingReview(page: import('@playwright/test').Page): Promise<void> {
  await setupAndOpenScenarioPr(page);
  await createInlineDraft(page, 3, 'draft for pending-review staging');
  await recordPrViewed(page);
  await injectSubmitFailure(page.request, SubmitMethod.AttachThread, {
    message: 'stop after Begin so a pending review is left behind',
  });
  await page.goto('/pr/acme/api/123');
  // The main ReviewActionButton says "Submit review" (no verdict, no pending).
  // Click it to open the submit dialog.
  await page.getByTestId('review-action-main').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^confirm submit$/i }).click();
  // Wait for the failure banner — Begin succeeded, AttachThread threw.
  await expect(dialog.getByRole('heading', { name: /^submit failed at /i })).toBeVisible({
    timeout: 15_000,
  });
  // Cancel in failed state — this stamps session.pendingReviewId so the next
  // GET /api/pr/.../session returns pendingReviewId !== null.
  await dialog.getByRole('button', { name: /^cancel$/i }).click();
  await expect(dialog).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

test.describe('#291 ReviewActionButton + AskAiPullTab', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetBackendState(request);
    await page.setViewportSize(VIEWPORT_DEFAULT);
    await setupAndOpenScenarioPr(page);
    await page.goto('/pr/acme/api/123');
    await page.waitForSelector('[data-testid="pr-header"]');
  });

  test.afterEach(async ({ page, request }) => {
    await disableAiPreview(page);
    await resetBackendState(request);
    const tokensResp = await request.post(`${BACKEND_ORIGIN}/test/clear-tokens`, {
      headers: { Origin: BACKEND_ORIGIN },
    });
    if (!tokensResp.ok()) {
      throw new Error(
        `/test/clear-tokens failed: ${tokensResp.status()} ${await tokensResp.text()}`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // A. Verdict label + fill
  // -------------------------------------------------------------------------

  test('B-verdict-1 — default state shows "Submit review" with accent fill', async ({ page }) => {
    const main = page.getByTestId('review-action-main');
    await expect(main).toBeVisible();
    // Accessible text is "Submit review" (no pending asterisk in default state).
    await expect(main).toHaveText(/Submit review/);
    // Fill is accent (no verdict selected yet).
    await expect(main).toHaveClass(/fill-accent/);
  });

  test('B-verdict-2 — select Approve via chevron → main shows "Approve" with approve fill', async ({
    page,
  }) => {
    await openChevronMenu(page);
    await selectVerdict(page, 'Approve');

    const main = page.getByTestId('review-action-main');
    await expect(main).toHaveText(/Approve/);
    await expect(main).toHaveClass(/fill-approve/);

    // Computed background should be greenish (--success). Assert non-transparent.
    const bg = await main.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg).not.toBe('transparent');
  });

  test('B-verdict-3 — select Request changes → main shows "Request changes" with warning fill', async ({
    page,
  }) => {
    await openChevronMenu(page);
    await selectVerdict(page, 'Request changes');

    const main = page.getByTestId('review-action-main');
    await expect(main).toHaveText(/Request changes/);
    await expect(main).toHaveClass(/fill-request-changes/);
  });

  test('B-verdict-4 — select Comment → main shows "Comment" with info fill', async ({ page }) => {
    await openChevronMenu(page);
    await selectVerdict(page, 'Comment');

    const main = page.getByTestId('review-action-main');
    await expect(main).toHaveText(/Comment/);
    await expect(main).toHaveClass(/fill-comment/);
  });

  test('B-verdict-5 — re-selecting same verdict clears it (toggle)', async ({ page }) => {
    // Select Approve, then re-select Approve to clear.
    await openChevronMenu(page);
    await selectVerdict(page, 'Approve');
    await expect(page.getByTestId('review-action-main')).toHaveText(/Approve/);

    // Re-open and select Approve again to toggle off.
    await openChevronMenu(page);
    await selectVerdict(page, 'Approve');

    // After clearing: reverts to default "Submit review" with accent fill.
    const main = page.getByTestId('review-action-main');
    await expect(main).toHaveText(/Submit review/);
    await expect(main).toHaveClass(/fill-accent/);
  });

  // -------------------------------------------------------------------------
  // B. Pending asterisk
  // -------------------------------------------------------------------------

  test('B-pending-1 — session with own pending review shows asterisk and "Resume review"', async ({
    page,
  }) => {
    // Tear down the current page so we can stage the pending review state.
    await stageOwnPendingReview(page);

    // After Cancel, the session has pendingReviewId set. Navigate to PR detail
    // to get the latest session state.
    await page.goto('/pr/acme/api/123');
    await page.waitForSelector('[data-testid="pr-header"]');

    const main = page.getByTestId('review-action-main');
    // The accessible label is "Resume review" (the asterisk is aria-hidden so it
    // doesn't change the accessible name — it's a purely visual dirty-marker).
    await expect(main).toHaveText(/Resume review/);
    // The pending marker ("*") IS rendered in the DOM (aria-hidden span with its
    // own testid — a stable hook, unlike the runtime-hashed CSS-module class).
    await expect(main.getByTestId('review-action-pending')).toBeVisible();
    await expect(main).toContainText('*');

    // Tooltip reflects pending state.
    const title = await main.getAttribute('title');
    expect(title).toMatch(/pending review on github/i);
  });

  // -------------------------------------------------------------------------
  // C. Pull-tab rest / hover / open + drawer-edge shift
  // -------------------------------------------------------------------------

  test('C-pull-tab-1 — pull-tab visible at rest on PR-detail with AI on', async ({ page }) => {
    await enableAiPreview(page);
    await page.reload();
    await page.waitForSelector('[data-testid="pr-header"]');

    const tab = page.getByTestId('ask-ai-pull-tab');
    await expect(tab).toBeVisible();
    // At rest: label is hidden (max-width:0 / opacity:0 via CSS) — but the button
    // itself is visible and has aria-label="Ask AI".
    await expect(tab).toHaveAttribute('aria-label', 'Ask AI');
    await expect(tab).toHaveAttribute('aria-expanded', 'false');
  });

  test('C-pull-tab-2 — clicking pull-tab opens drawer, aria-label becomes "Close"', async ({
    page,
  }) => {
    await enableAiPreview(page);
    await page.reload();
    await page.waitForSelector('[data-testid="pr-header"]');

    const tab = page.getByTestId('ask-ai-pull-tab');
    await tab.click();

    // Drawer opens.
    const drawer = page.getByTestId('ask-ai-drawer');
    await expect(drawer).toHaveAttribute('aria-hidden', 'false');

    // Pull-tab label and aria state change.
    await expect(tab).toHaveAttribute('aria-label', 'Close');
    await expect(tab).toHaveAttribute('aria-expanded', 'true');
  });

  test('C-pull-tab-3 — open pull-tab moves right edge to drawer width', async ({ page }) => {
    await enableAiPreview(page);
    await page.reload();
    await page.waitForSelector('[data-testid="pr-header"]');

    const tab = page.getByTestId('ask-ai-pull-tab');
    const boxBefore = await tab.boundingBox();
    expect(boxBefore).not.toBeNull();

    await tab.click();
    await page.getByTestId('ask-ai-drawer').waitFor({ state: 'visible' });

    // Wait for the CSS transition (220ms ease-out) to settle before measuring.
    await page.waitForTimeout(300);

    const boxAfter = await tab.boundingBox();
    expect(boxAfter).not.toBeNull();

    // The tab's right edge should shift left by approximately the drawer width (400px).
    // We check that x moved left by at least 350px (tolerates rounding/transition).
    const drawerWidth = await page.evaluate(
      () =>
        parseInt(
          getComputedStyle(document.documentElement).getPropertyValue('--ask-ai-drawer-width'),
        ) || 400,
    );
    expect(boxBefore!.x - boxAfter!.x).toBeGreaterThanOrEqual(drawerWidth - 50);
  });

  test('C-pull-tab-4 — pull-tab absent when NOT on PR-detail route', async ({ page }) => {
    await enableAiPreview(page);
    // Navigate to inbox — pull-tab must not render outside /pr/* routes.
    await page.goto('/');
    await page.waitForURL((u) => u.pathname === '/');
    const tab = page.getByTestId('ask-ai-pull-tab');
    await expect(tab).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // D. Anti-collision — pull-tab must not overlap Files-tab toolbar or diff
  // -------------------------------------------------------------------------

  test('D-anti-collision-1 — pull-tab does not overlap toolbar at default viewport (1440px)', async ({
    page,
  }) => {
    await enableAiPreview(page);
    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-diff"]').waitFor();
    await page.reload();
    await page.waitForSelector('[data-testid="pr-header"]');
    await page.locator('[data-testid="files-tab-diff"]').waitFor();

    const tab = page.getByTestId('ask-ai-pull-tab');
    await expect(tab).toBeVisible();

    const tabBox = await tab.boundingBox();
    expect(tabBox).not.toBeNull();

    // Get toolbar bounding box.
    const toolbarBox = await page.locator('.files-tab-toolbar').boundingBox();
    expect(toolbarBox).not.toBeNull();

    // No overlap with toolbar band (interactive controls).
    // Note: the pull-tab is position:fixed on the right viewport edge; it sits
    // ABOVE the diff area in z-order and intentionally overlays the diff column
    // (which extends to the viewport right edge). The requirement is only that it
    // does NOT cover the FILES-TAB TOOLBAR that holds the DiffViewToggle and
    // DiffSettingsMenu controls — i.e., the tab's top edge must be ≥ toolbar bottom.
    expect(
      rectsOverlap(tabBox!, toolbarBox!),
      `pull-tab overlaps toolbar: tab={x:${tabBox!.x},y:${tabBox!.y},w:${tabBox!.width},h:${tabBox!.height}} toolbar={x:${toolbarBox!.x},y:${toolbarBox!.y},w:${toolbarBox!.width},h:${toolbarBox!.height}}`,
    ).toBe(false);

    // Verify pull-tab top edge is at or below the toolbar bottom edge (clearance check).
    expect(tabBox!.y).toBeGreaterThanOrEqual(toolbarBox!.y + toolbarBox!.height - 1);

    // Also assert pull-tab doesn't overlap the diff-settings-trigger specifically.
    const gearBox = await page.getByTestId('diff-settings-trigger').boundingBox();
    if (gearBox) {
      expect(
        rectsOverlap(tabBox!, gearBox),
        `pull-tab overlaps diff-settings-trigger: ${JSON.stringify(gearBox)}`,
      ).toBe(false);
    }
  });

  test('D-anti-collision-2 — pull-tab does not overlap toolbar at narrow viewport (900px)', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORT_NARROW);
    await enableAiPreview(page);
    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-diff"]').waitFor();
    await page.reload();
    await page.waitForSelector('[data-testid="pr-header"]');
    await page.locator('[data-testid="files-tab-diff"]').waitFor();

    const tab = page.getByTestId('ask-ai-pull-tab');
    await expect(tab).toBeVisible();

    const tabBox = await tab.boundingBox();
    const toolbarBox = await page.locator('.files-tab-toolbar').boundingBox();
    expect(tabBox).not.toBeNull();
    expect(toolbarBox).not.toBeNull();

    expect(
      rectsOverlap(tabBox!, toolbarBox!),
      `pull-tab overlaps toolbar at 900px: tab=${JSON.stringify(tabBox)} toolbar=${JSON.stringify(toolbarBox)}`,
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // E. No-reflow — main button width must not change when verdict changes
  // -------------------------------------------------------------------------

  test('E-no-reflow-1 — button width unchanged across verdict changes (default density)', async ({
    page,
  }) => {
    const main = page.getByTestId('review-action-main');

    // Baseline width with no verdict.
    const widthDefault = await main.evaluate((el) => el.getBoundingClientRect().width);
    expect(widthDefault).toBeGreaterThan(0);

    // Switch to Approve.
    await openChevronMenu(page);
    await selectVerdict(page, 'Approve');
    const widthApprove = await main.evaluate((el) => el.getBoundingClientRect().width);

    // Switch to Request changes (the longest label).
    await openChevronMenu(page);
    await selectVerdict(page, 'Request changes');
    const widthRequest = await main.evaluate((el) => el.getBoundingClientRect().width);

    // Switch to Comment.
    await openChevronMenu(page);
    await selectVerdict(page, 'Comment');
    const widthComment = await main.evaluate((el) => el.getBoundingClientRect().width);

    // All widths must be the same (within 1px for subpixel rounding).
    const widths = [widthDefault, widthApprove, widthRequest, widthComment];
    const maxW = Math.max(...widths);
    const minW = Math.min(...widths);
    expect(maxW - minW).toBeLessThanOrEqual(1);
  });

  test('E-no-reflow-2 — button width unchanged under compact density', async ({ page }) => {
    // Enable compact density via /api/preferences.
    const compactResp = await page.request.post(`${BACKEND_ORIGIN}/api/preferences`, {
      data: { density: 'compact' },
      headers: { Origin: BACKEND_ORIGIN },
    });
    expect(compactResp.ok()).toBe(true);
    await page.reload();
    await page.waitForSelector('[data-testid="pr-header"]');

    // Confirm density was applied.
    const densityAttr = await page.evaluate(
      () => document.documentElement.getAttribute('data-density') ?? '',
    );
    expect(densityAttr).toBe('compact');

    const main = page.getByTestId('review-action-main');
    const widthDefault = await main.evaluate((el) => el.getBoundingClientRect().width);
    expect(widthDefault).toBeGreaterThan(0);

    await openChevronMenu(page);
    await selectVerdict(page, 'Request changes');
    const widthRequest = await main.evaluate((el) => el.getBoundingClientRect().width);

    expect(Math.abs(widthDefault - widthRequest)).toBeLessThanOrEqual(1);

    // Reset density.
    await page.request.post(`${BACKEND_ORIGIN}/api/preferences`, {
      data: { density: 'comfortable' },
      headers: { Origin: BACKEND_ORIGIN },
    });
  });
});

// ---------------------------------------------------------------------------
// F. Pull-tab CSS anchor verification
//
// Asserts that the pull-tab's computed `top` places it at or below the
// toolbar bottom edge — confirming the CSS `top: 314px` measured and set in
// Task 11 (toolbar bottom 302px + 12px gutter = 314px). This is a permanent
// regression gate: if the header layout changes and the toolbar grows, this
// test will fail and the CSS anchor must be re-measured (re-run b1-capture.spec.ts
// measurement section and update AskAiPullTab.module.css).
// ---------------------------------------------------------------------------

test.describe('F-pull-tab-css-anchor', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetBackendState(request);
    await page.setViewportSize(VIEWPORT_DEFAULT);
  });

  test.afterEach(async ({ page, request }) => {
    await page.request.post(`${BACKEND_ORIGIN}/api/preferences`, {
      data: { aiPreview: false },
      headers: { Origin: BACKEND_ORIGIN },
    });
    await resetBackendState(request);
    await request.post(`${BACKEND_ORIGIN}/test/clear-tokens`, {
      headers: { Origin: BACKEND_ORIGIN },
    });
  });

  test('pull-tab CSS top places it below the toolbar at both viewports', async ({ page }) => {
    await setupAndOpenScenarioPr(page);
    const resp = await page.request.post(`${BACKEND_ORIGIN}/api/preferences`, {
      data: { aiPreview: true },
      headers: { Origin: BACKEND_ORIGIN },
    });
    expect(resp.ok()).toBe(true);

    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-diff"]').waitFor();
    await page.reload();
    await page.waitForSelector('[data-testid="pr-header"]');
    await page.locator('[data-testid="files-tab-diff"]').waitFor();

    const tab = page.getByTestId('ask-ai-pull-tab');
    await expect(tab).toBeVisible();

    // Verify at 1440px: pull-tab top ≥ toolbar bottom.
    const result1440 = await page.evaluate(() => {
      const toolbar = document.querySelector('.files-tab-toolbar');
      const tabEl = document.querySelector('[data-testid="ask-ai-pull-tab"]') as HTMLElement | null;
      if (!toolbar || !tabEl) return null;
      return {
        toolbarBottom: toolbar.getBoundingClientRect().bottom,
        tabTop: tabEl.getBoundingClientRect().top,
      };
    });
    expect(result1440).not.toBeNull();
    expect(result1440!.tabTop).toBeGreaterThanOrEqual(result1440!.toolbarBottom - 1);

    // Verify at 900px: same invariant even if toolbar wraps.
    await page.setViewportSize(VIEWPORT_NARROW);
    await page.waitForTimeout(200);
    const result900 = await page.evaluate(() => {
      const toolbar = document.querySelector('.files-tab-toolbar');
      const tabEl = document.querySelector('[data-testid="ask-ai-pull-tab"]') as HTMLElement | null;
      if (!toolbar || !tabEl) return null;
      return {
        toolbarBottom: toolbar.getBoundingClientRect().bottom,
        tabTop: tabEl.getBoundingClientRect().top,
      };
    });
    expect(result900).not.toBeNull();
    expect(result900!.tabTop).toBeGreaterThanOrEqual(result900!.toolbarBottom - 1);
  });
});
