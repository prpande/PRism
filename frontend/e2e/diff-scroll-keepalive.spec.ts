import { test, expect } from '@playwright/test';
import { BACKEND_ORIGIN } from './helpers/backend-origin';
import { resetBackendState, setupAndOpenScenarioPr, advanceHead } from './helpers/s4-setup';

// Regression guard for #590 — the kept-alive Files tab must PRESERVE the inner
// diff-body scroll position across an in-app background→return cycle (a regression
// of #180). Root cause (isolated live): deactivating a PrDetailView removes the
// `data-files-active` marker, which reflows `.diff-pane-body` to non-scrollable and
// CLAMPS its scrollTop to 0 — irrecoverably. DiffPane now records the live offset
// (useDiffScrollCapture) and PrDetailView writes it back on re-activation
// (useDiffScrollRestore); this spec proves the browser-observable contract.
//
// WHY this is browser-observable (unlike useTabScrollMemory's OUTER scroller, which
// pr-tab-keepalive.spec.ts deliberately does NOT assert): in files-active mode the
// `[data-files-active]` marker binds the shell to the viewport so the diff scrolls
// INTERNALLY in `.diff-pane-body`. That element's scrollTop is real and observable
// in a plain browser — verified live against a real PR.
//
// WHY the background→return cycle is click-driven (not page.goto): keep-alive lives
// in React state + a module-level store; a full reload tears it down. So we click
// the Header "Inbox" link to background and the PrTabStrip pill to return — same as
// pr-tab-keepalive.spec.ts.

const VIEWPORT = { width: 1440, height: 900 };
const TALL_SHA = '6666666666666666666666666666666666666666';

// A src/Calc.cs with far more lines than the 900px viewport, so the diff body is a
// genuine internal scroller (scrollHeight >> clientHeight). The canonical 8-line
// fixture cannot overflow; advanceHead injects this at a fresh head (wiped by every
// other spec's /test/reset).
const LINE_COUNT = 150;
const TALL_CONTENT =
  Array.from({ length: LINE_COUNT }, (_, i) => `// line ${String(i).padStart(3, '0')}`).join('\n') +
  '\n';

const TARGET_SCROLL = 600;

test.describe('kept-alive Files tab preserves diff scroll on return (#590)', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetBackendState(request);
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);
    // Suppress the #485 AI-onboarding overlay (returning-user pattern, mirrors
    // ai-onboarding-overlay.spec.ts). resetBackendState's onboardingSeen patch runs
    // on a SEPARATE, unauthenticated request context, so it silently no-ops; this
    // POST rides the page's now-authenticated cookie jar so the write actually lands.
    // Without it the dialog mounts over the inbox and its modal-backdrop intercepts
    // the return-via-tab-pill click. The test body's page.goto remounts the SPA, so
    // preferences refetch with onboardingSeen=true before we ever reach the inbox.
    const seenResp = await page.request.post(`${BACKEND_ORIGIN}/api/preferences`, {
      data: { 'ui.ai.onboardingSeen': true },
      headers: { 'Content-Type': 'application/json', Origin: BACKEND_ORIGIN },
    });
    expect(seenResp.ok(), `POST onboardingSeen=true failed: ${seenResp.status()}`).toBe(true);
    // Inject the tall diff at a fresh head before the first PR-detail load.
    await advanceHead(page, TALL_SHA, [{ path: 'src/Calc.cs', content: TALL_CONTENT }]);
  });

  test('diff-body scrollTop survives PR→Inbox→PR via in-app nav', async ({ page }) => {
    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();
    await expect(page.locator('[data-testid="files-tab-diff"]')).toBeVisible();

    const body = page.locator('.diff-pane-body');
    // The injected lines render as solo-insert rows; the last settling signals the
    // diff is laid out and the body has its full scrollHeight.
    await page
      .locator('[data-testid="files-tab-diff"] tr.diff-line--insert')
      .nth(LINE_COUNT - 1)
      .waitFor();

    // Sanity (non-vacuous): the body is a genuine internal scroller.
    const overflow = await body.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(overflow).toBeGreaterThan(TARGET_SCROLL);

    // Scroll the diff body down; the capture listener records the offset.
    await body.evaluate((el, top) => {
      el.scrollTop = top;
      el.dispatchEvent(new Event('scroll'));
    }, TARGET_SCROLL);
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(TARGET_SCROLL);

    // --- BACKGROUND via the Header Inbox link (SPA) ---
    await page.getByRole('link', { name: /^Inbox$/ }).click();
    await expect(page.getByPlaceholder(/paste a pr url/i)).toBeVisible();

    // --- RETURN via the PrTabStrip pill (SPA) ---
    await page
      .locator('[data-testid="pr-tabstrip"] [data-prref="acme/api/123"] [role="tab"]')
      .click();

    // Files is active again and the layout marker re-stamped.
    await expect(page.locator('[data-subtab="files"]:not([hidden])')).toBeVisible();
    await expect(page.locator('[data-app-scroll][data-files-active]')).toHaveCount(1);

    // THE #590 CONTRACT: the diff-body scroll is restored (not reset to 0). Poll —
    // restore runs in a layout effect after the marker re-applies; Windows CI is slow.
    await expect
      .poll(() => body.evaluate((el) => el.scrollTop), { timeout: 15000 })
      .toBe(TARGET_SCROLL);
  });
});
