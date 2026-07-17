import { test, expect, request } from '@playwright/test';
import { BACKEND_ORIGIN } from './helpers/backend-origin';
import { setupAndOpenScenarioPr, resetBackendState } from './helpers/s4-setup';
import { expectVisual } from './helpers/visual';

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

  // Set up the subscription-POST listener BEFORE navigating to the PR detail
  // — useActivePrUpdates fires `POST /api/events/subscriptions` from a
  // useEffect that runs on mount (frontend/src/hooks/useActivePrUpdates.ts:43-46).
  // Awaiting this completion before /test/emit-pr-updated avoids a subtle race:
  // if the publish lands before the subscriber is in ActivePrSubscriberRegistry,
  // SseChannel.OnActivePrUpdated finds no subscribers and silently drops the
  // event, and the test then times out on `waitFor reload-banner` with no
  // diagnostic surface.
  const subscriptionPosted = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/events/subscriptions') && r.request().method() === 'POST' && r.ok(),
    { timeout: 15_000 },
  );

  await page.goto('/pr/acme/api/123');

  await page.locator('[data-testid="pr-header"]').waitFor();
  // Wait for the PR detail data to settle (the scenario PR's title is "Calc
  // utilities" per PRism.Web/TestHooks/FakePrReader.cs). Don't use
  // page.waitForLoadState('networkidle') — the active-PR poller fires every 1s
  // (PRISM_POLLER_CADENCE_SECONDS=1 in playwright.config.ts) and never lets
  // networkidle settle.
  await expect(page.locator('[data-testid="pr-title"]')).toHaveText('Calc utilities');
  await expect(page.locator('[data-testid="pr-tab-files"]')).toBeVisible();
  await subscriptionPosted;
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  });

  const targets = [
    '[data-testid="pr-header"]',
    '[data-testid="pr-title"]',
    '[data-testid="pr-tab-files"]',
  ];
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
  //
  // Absolute backend URL via BACKEND_ORIGIN (honors PRISM_E2E_PORT, #239) with a
  // matching Origin header, so the /test/* POST reaches the served backend on
  // whatever port the run booted. Mirrors the resetBackendState helper's pattern.
  const emitResp = await page.request.post(`${BACKEND_ORIGIN}/test/emit-pr-updated`, {
    data: {
      owner: 'acme',
      repo: 'api',
      number: 123,
      headShaChanged: true,
      commentCountChanged: false,
      newHeadSha: '5555555555555555555555555555555555555555',
      commentCountDelta: 0,
    },
    headers: { Origin: BACKEND_ORIGIN },
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

  // Supplementary visual signal — loose 1% pixel tolerance, banner masked. CI runs
  // Playwright in the Linux container (.github/workflows/ci.yml), so the canonical
  // baseline lives under __screenshots__/linux/; any local machine renders subpixels
  // differently and can never match it, so screenshots are a CI-only regression gate.
  // The outer CI check keeps that intent readable here; expectVisual (#751) enforces
  // the full contract underneath (skip outside CI, throw if CI ever runs this on a
  // non-Linux platform). The load-bearing assertion is the getBoundingClientRect loop
  // above, which runs on EVERY platform, local and CI.
  if (process.env.CI) {
    await expectVisual(page, 'pr-detail-with-banner-masked.png', {
      mask: [page.locator('[data-testid="reload-banner"]')],
      maxDiffPixelRatio: 0.01,
    });
  }
});
