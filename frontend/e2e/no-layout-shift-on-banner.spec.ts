import { test, expect, request } from '@playwright/test';
import { setupAndOpenScenarioPr, resetBackendState } from './helpers/s4-setup';

// Spec § 8 ("no layout shift when a PR with new commits arrives") + plan PR9
// Task 9.1. The round-1 ce-doc-review reframe: assert layout invariance directly
// via getBoundingClientRect() rather than depending on byte-equality screenshot
// comparison (font hinting + GPU subpixel rendering make pixel comparison
// fragile across runs and OSes). Screenshot diff remains as a supplementary
// signal at a loose threshold, on per-platform-pinned snapshot directories.
//
// The reload banner mounts BETWEEN PrHeader and UnresolvedPanel in PrDetailPage
// (frontend/src/pages/PrDetailPage.tsx:130-178), so the DoD line is specifically
// about the PR-header zone above the banner — that content stays put when the
// banner arrives. Below-banner content (UnresolvedPanel, Outlet) does shift
// down by the banner's height; that's the document-flow consequence the spec
// accepts. The screenshot below masks the banner zone so its presence/absence
// doesn't fail the diff on its own pixels.

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await ctx.dispose();
});

test('PR-header zone layout invariant before and after reload banner arrives', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  await setupAndOpenScenarioPr(page);
  await page.goto('/pr/acme/api/123');

  await page.locator('[data-testid="pr-header"]').waitFor();
  // Wait for the PR detail data to settle (the scenario PR's title is "Calc
  // utilities" per PRism.Web/TestHooks/FakePrReader.cs). Don't use
  // page.waitForLoadState('networkidle') — the active-PR poller fires every 1s
  // (PRISM_POLLER_CADENCE_SECONDS=1 in playwright.config.ts) and never lets
  // networkidle settle.
  await expect(page.locator('h1.pr-title')).toHaveText('Calc utilities');
  await expect(page.locator('[data-testid="pr-tab-files"]')).toBeVisible();
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  });

  const targets = ['[data-testid="pr-header"]', 'h1.pr-title', '[data-testid="pr-tab-files"]'];
  const captureBoxes = (sels: string[]) =>
    page.evaluate((selectors) => {
      return selectors.map((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { sel, missing: true } as const;
        const r = el.getBoundingClientRect();
        return { sel, top: r.top, left: r.left, width: r.width, height: r.height } as const;
      });
    }, sels);

  const before = await captureBoxes(targets);

  // Trigger the banner via the deterministic /test/emit-pr-updated hook (S6 PR9
  // backend addition). The straightforward /test/advance-head path doesn't work
  // here: that hook pre-warms IActivePrCache to the just-advanced sha, so the
  // ActivePrPoller never observes a mismatch and never publishes ActivePrUpdated.
  // The new hook publishes directly via IReviewEventBus so SseChannel fans out
  // `event: pr-updated` to the subscribed page, and BannerRefresh renders.
  const emitResp = await page.request.post('/test/emit-pr-updated', {
    data: {
      owner: 'acme',
      repo: 'api',
      number: 123,
      headShaChanged: true,
      commentCountChanged: false,
      newHeadSha: '5555555555555555555555555555555555555555',
      commentCountDelta: 0,
    },
    headers: { Origin: 'http://localhost:5180' },
  });
  if (!emitResp.ok()) {
    throw new Error(`/test/emit-pr-updated failed: ${emitResp.status()} ${await emitResp.text()}`);
  }

  await page
    .locator('[data-testid="reload-banner"]')
    .waitFor({ state: 'visible', timeout: 15_000 });

  const after = await captureBoxes(targets);

  // Bounding boxes must match within 1px tolerance for browser-rounding nuance.
  for (let i = 0; i < before.length; i++) {
    const b = before[i];
    const a = after[i];
    expect(a.sel).toBe(b.sel);
    if ('missing' in b || 'missing' in a) {
      expect(a).toEqual(b);
      continue;
    }
    expect(Math.abs(a.top - b.top), `${b.sel} top shifted`).toBeLessThanOrEqual(1);
    expect(Math.abs(a.left - b.left), `${b.sel} left shifted`).toBeLessThanOrEqual(1);
    expect(Math.abs(a.width - b.width), `${b.sel} width changed`).toBeLessThanOrEqual(1);
    expect(Math.abs(a.height - b.height), `${b.sel} height changed`).toBeLessThanOrEqual(1);
  }

  // Supplementary visual signal — loose 1% pixel tolerance, banner masked. The
  // per-platform snapshot directory (configured via expect.toHaveScreenshot
  // pathTemplate in playwright.config.ts) keeps cross-OS font-rendering
  // differences from poisoning the diff.
  await expect(page).toHaveScreenshot('pr-detail-no-banner.png', {
    mask: [page.locator('[data-testid="reload-banner"]')],
    maxDiffPixelRatio: 0.01,
  });
});
