import { test, expect, request } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr, advanceHead } from './helpers/s4-setup';

// ---------------------------------------------------------------------------
// Keep-alive PR-detail tabs — end-to-end against the REAL fake backend.
// ---------------------------------------------------------------------------
//
// WHAT keep-alive guarantees: every visited PR-detail tab stays MOUNTED (just
// `hidden`) while another view is active, so its sub-tab selection, selected
// file, scroll offset, and any latched "PR updated" banner survive IN-APP
// (React Router / SPA) navigation away and back.
//
// WHY the navigation MUST be click-driven, not page.goto: keep-alive lives in
// React component state + a module-level scroll-memory store
// (useTabScrollMemory). A full page reload (`page.goto`) tears down the whole
// React tree and that state is GONE — keep-alive explicitly does NOT promise
// reload survival (it is a local-only PoC; deep-link/reload sharing is a
// non-goal per PrDetailView's own comment). So the background→return cycle is
// driven by real UI CLICKS:
//   - BACKGROUND: click the Header "Inbox" link  (Header.tsx renders a plain
//     react-router <Link to="/"> with the accessible name "Inbox").
//   - RETURN:     click the PrTabStrip pill       (PrTabStrip.tsx renders, per
//     open tab, an outer <div data-prref="owner/repo/number"> containing an
//     inner <div role="tab" aria-label={title}>, inside the
//     [data-testid="pr-tabstrip"] tablist).
// `page.goto` is used ONLY for the very first entry (the /setup → / bootstrap
// inside setupAndOpenScenarioPr); the actual PR is then opened by clicking its
// inbox row (InboxRow.tsx is a <button> whose onClick addTab()s + navigates —
// the SPA path that registers the strip pill).
//
// SINGLE-PR SCOPE: the fake backend serves exactly ONE PR — acme/api/123,
// "Calc utilities" (FakeReviewBackingStore.Scenario). There is intentionally
// no second fixture PR: adding one would add a second inbox row and a second
// tab pill, perturbing the inbox layout + the design-parity screenshot
// baselines (parity-baselines.spec.ts). TWO-PR-TAB INDEPENDENCE (two kept-alive
// views not clobbering each other's sub-tab/scroll/marker) is therefore covered
// by UNIT tests, not here: PrTabHost.test.tsx, the hidden-view a11y isolation
// test, and useTabScrollMemory's cross-view test. This e2e proves the
// single-tab state-preservation contract end-to-end through the real wire.
//
// TALL-DIFF NOTE (Test 1): the canonical src/Calc.cs at the latest head is only
// ~8 lines and does NOT overflow the 900px viewport, so the shared
// [data-app-scroll] scroller would have scrollTop pinned at 0 — a vacuous scroll
// assertion. Like diff-scroll-regression.spec.ts, Test 1 INJECTS a tall
// src/Calc.cs at a fresh head via /test/advance-head BEFORE opening the PR, so
// the scroller genuinely overflows and a non-zero scrollTop is real. /test/reset
// in every other spec's beforeEach wipes the injected head, so nothing else is
// perturbed.

const VIEWPORT = { width: 1440, height: 900 };

// A src/Calc.cs tall enough to overflow the 900px viewport on [data-app-scroll],
// so scrollTop can be set to a genuine non-zero value (and later asserted
// restored). 120 lines mirrors diff-scroll-regression's overflow recipe.
const TALL_SHA = '7777777777777777777777777777777777777777';
const TALL_LINE_COUNT = 120;
const TALL_CONTENT =
  Array.from(
    { length: TALL_LINE_COUNT },
    (_, i) => `// keepalive line ${String(i).padStart(3, '0')}`,
  ).join('\n') + '\n';

// Opens the scenario PR by CLICKING its inbox row (the SPA path that addTab()s,
// registering the strip pill) and waits for the detail header to settle.
async function openScenarioPrViaInboxRow(page: import('@playwright/test').Page): Promise<void> {
  // InboxRow renders a <button aria-label="Calc utilities · …"> with the title
  // inside. getByRole('button', { name: /Calc utilities/ }) matches it via the
  // accessible name (aria-label). This is the real-user click path — it runs
  // addTab() + navigate(), so the PrTabStrip pill appears afterwards.
  await page.getByRole('button', { name: /Calc utilities/ }).click();
  await page.locator('[data-testid="pr-header"]').waitFor();
  await expect(page.locator('[data-testid="pr-title"]')).toHaveText('Calc utilities');
}

// Clicks the Header "Inbox" link (SPA nav) to BACKGROUND the current PR view,
// then waits for the inbox to be visible.
async function backgroundViaInboxLink(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('link', { name: /^Inbox$/ }).click();
  // The scenario inbox row is the deterministic "inbox is visible" signal.
  await expect(page.getByRole('button', { name: /Calc utilities/ })).toBeVisible();
}

// Clicks the PrTabStrip pill for the scenario PR (SPA nav) to RETURN to the
// kept-alive view. Scoped to the tablist so it does NOT match the view-root
// [data-prref] (PrDetailView's root carries the same data-prref but lives
// inside [data-app-scroll], below the strip).
async function returnViaTabPill(page: import('@playwright/test').Page): Promise<void> {
  await page
    .locator('[data-testid="pr-tabstrip"] [data-prref="acme/api/123"] [role="tab"]')
    .click();
}

test.describe('keep-alive PR-detail tabs (e2e, real fake backend)', () => {
  test.beforeEach(async ({ page }) => {
    const ctx = await request.newContext();
    await resetBackendState(ctx);
    await ctx.dispose();
    await page.setViewportSize(VIEWPORT);
  });

  // -------------------------------------------------------------------------
  // Test 1 — sub-tab + selected file + scroll survive PR → Inbox → PR (SPA nav)
  // -------------------------------------------------------------------------
  test('Files sub-tab, selected file, and scroll offset survive PR→Inbox→PR via in-app nav', async ({
    page,
  }) => {
    await setupAndOpenScenarioPr(page);
    // Inject a tall src/Calc.cs at a fresh head BEFORE first detail load so the
    // Files diff genuinely overflows [data-app-scroll]. advanceHead re-seeds the
    // active-PR cache to TALL_SHA, so the navigation below sees it synchronously
    // (no poller race) — same pattern as diff-scroll-regression.spec.ts.
    await advanceHead(page, TALL_SHA, [{ path: 'src/Calc.cs', content: TALL_CONTENT }]);

    await openScenarioPrViaInboxRow(page);

    // --- Switch to the Files sub-tab (component state, not a URL route) ---
    await page.locator('[data-testid="pr-tab-files"]').click();
    await page.locator('[data-testid="files-tab-tree"]').waitFor();

    // --- Select the canonical file ---
    const fileRow = page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]');
    await fileRow.click();
    await expect(page.locator('[data-testid="files-tab-diff"]')).toBeVisible();
    // Selected-file marker: FileTree stamps data-selected={isSelected} on the
    // row (FileTree.tsx:180). This is the assertion re-checked after return —
    // chosen over the hashed CSS-module class because it is a stable contract
    // attribute.
    await expect(fileRow).toHaveAttribute('data-selected', 'true');

    // --- Scroll the shared scroller down to a genuine non-zero offset ---
    const scroller = page.locator('[data-app-scroll]');
    // Confirm the tall diff actually overflows, then set scrollTop within range.
    const target = await scroller.evaluate((el) => {
      el.scrollTop = Math.min(300, el.scrollHeight - el.clientHeight);
      return el.scrollTop;
    });
    // TEETH: a 0 here would mean the diff didn't render tall enough and the
    // scroll-restore assertion below would be vacuous.
    expect(target).toBeGreaterThan(0);

    // --- BACKGROUND via the Header Inbox link (SPA) ---
    await backgroundViaInboxLink(page);

    // --- RETURN via the PrTabStrip pill (SPA) ---
    await returnViaTabPill(page);

    // --- ASSERT state survived ---
    // (a) Files sub-tab is the active one (its wrapper is not hidden) AND the
    //     Files layout marker is re-stamped on the shared scroller.
    await expect(page.locator('[data-subtab="files"]:not([hidden])')).toBeVisible();
    await expect(page.locator('[data-app-scroll][data-files-active]')).toHaveCount(1);

    // (b) Calc.cs is still the selected file.
    await expect(
      page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]'),
    ).toHaveAttribute('data-selected', 'true');

    // (c) Scroll offset restored (useTabScrollMemory saves on deactivation
    //     cleanup, restores on re-activation setup). Poll because restore runs
    //     in a layout effect after the marker effect re-establishes overflow —
    //     never a fixed sub-second sleep (Windows CI is slow).
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 15_000 })
      .toBeGreaterThan(0);
    const restored = await scroller.evaluate((el) => el.scrollTop);
    expect(Math.abs(restored - target)).toBeLessThanOrEqual(5);
  });

  // -------------------------------------------------------------------------
  // Test 2 — a backgrounded pr-updated banner LATCHES while hidden, then CLEARS
  // on return (OQ8 contract).
  // -------------------------------------------------------------------------
  //
  // Non-vacuous by construction: BannerRefresh renders INSIDE PrDetailView,
  // whose root is `hidden={!active}`. While backgrounded the view is hidden, so
  // when the pr-updated SSE event arrives the banner becomes ATTACHED (present
  // in the DOM, inside a [hidden] subtree) but NOT visible. We assert that
  // latched-while-hidden state FIRST — that is the proof the event genuinely
  // arrived while the view was backgrounded. On return, useActivationTransition
  // fires reload() + clearUnread() + updates.clear(), flipping hasUpdate false
  // so BannerRefresh unmounts entirely (toHaveCount(0)) — the OQ8 contract.
  test('backgrounded pr-updated banner latches while hidden and clears on return (OQ8)', async ({
    page,
  }) => {
    // Listen for the active-PR subscription POST BEFORE entering the PR — the
    // event publish must land AFTER the page is in ActivePrSubscriberRegistry or
    // SseChannel drops it silently (see no-layout-shift-on-banner.spec.ts).
    const subscriptionPosted = page.waitForResponse(
      (r) =>
        r.url().endsWith('/api/events/subscriptions') && r.request().method() === 'POST' && r.ok(),
      { timeout: 15_000 },
    );

    await setupAndOpenScenarioPr(page);
    await openScenarioPrViaInboxRow(page);
    await subscriptionPosted;

    // --- BACKGROUND via the Header Inbox link (SPA) ---
    await backgroundViaInboxLink(page);

    // --- Fire the pr-updated event (deterministic /test/emit-pr-updated hook).
    // Absolute URL pinned to 5180 with the Origin header — copied from
    // no-layout-shift-on-banner.spec.ts (Vite proxies /api/* but NOT /test/*).
    const emitResp = await page.request.post('http://localhost:5180/test/emit-pr-updated', {
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
    expect(emitResp.ok()).toBe(true);

    // --- TEETH: prove the backgrounded (hidden) view LATCHED the event ---
    // The banner is inside the `hidden={!active}` PrDetailView root, so it
    // becomes attached-but-not-visible. If this passed only because the banner
    // were outside the hidden subtree, the not-visible assertion would catch it.
    const banner = page.locator('[data-testid="reload-banner"]');
    await expect(banner).toBeAttached({ timeout: 15_000 });
    await expect(banner).not.toBeVisible();

    // --- RETURN via the PrTabStrip pill (SPA) ---
    await returnViaTabPill(page);

    // --- ASSERT cleared: on re-activation useActivationTransition clears the
    // latched banner, so BannerRefresh unmounts (hasUpdate flips false). This is
    // the OQ8 contract.
    await expect(banner).toHaveCount(0);
  });
});
