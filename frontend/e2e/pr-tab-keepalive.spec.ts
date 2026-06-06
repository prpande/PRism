import { test, expect, request } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

// ---------------------------------------------------------------------------
// Keep-alive PR-detail tabs — end-to-end against the REAL fake backend.
// ---------------------------------------------------------------------------
//
// WHAT keep-alive guarantees: every visited PR-detail tab stays MOUNTED (just
// `hidden`) while another view is active, so its sub-tab selection, selected
// file, scroll offset, and any latched "PR updated" banner survive IN-APP
// (React Router / SPA) navigation away and back.
//
// WHY the BACKGROUND→RETURN cycle MUST be click-driven, not page.goto:
// keep-alive lives in React component state + a module-level scroll-memory store
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
//
// HOW the tab gets registered: the INITIAL entry uses `page.goto('/pr/.../123')`.
// PrTabHost's route effect (parsePrRoute(pathname) → addTab(route.ref)) registers
// the keep-alive tab from the URL alone — so a direct navigation both mounts the
// view AND makes the PrTabStrip pill appear. An inbox-row click is NOT required
// (and would not work here: the fake backend's inbox is EMPTY — FakePrDiscovery's
// scenario item is an IPrDiscovery.GetInboxAsync surface, but the inbox is built
// by the ISectionQueryRunner-based InboxRefreshOrchestrator, which has no fake
// and returns six empty sections). The initial-entry method does not affect the
// contract under test: keep-alive is the SURVIVAL of in-app background→return
// nav, which the click-driven steps below exercise.
//
// SINGLE-PR SCOPE: the fake backend serves exactly ONE PR — acme/api/123,
// "Calc utilities" (FakeReviewBackingStore.Scenario). TWO-PR-TAB INDEPENDENCE
// (two kept-alive views not clobbering each other's sub-tab/scroll/marker) is
// covered by UNIT tests, not here: PrTabHost.test.tsx, the hidden-view a11y
// isolation test, and useTabScrollMemory's cross-view test. This e2e proves the
// single-tab state-preservation contract end-to-end through the real wire.
//
// SCROLL-OFFSET NOTE: keep-alive's scroll preservation (useTabScrollMemory) is
// NOT asserted end-to-end here. It saves/restores scrollTop on the
// [data-app-scroll] container, which is the scroll viewport only in the Electron
// desktop shell (App.tsx: "data-app-shell + data-app-scroll let the desktop
// shell scroll page content"). In a plain browser [data-app-scroll] is sized to
// its content and the WINDOW scrolls, so [data-app-scroll].scrollTop stays 0 —
// the offset is not browser-observable and any e2e assertion on it is vacuous or
// fails. The save/restore logic (including cross-view-swap ordering) is unit-
// tested in useTabScrollMemory.test.tsx. This e2e proves the browser-observable
// half of the contract: the active sub-tab and the selected file survive.

const VIEWPORT = { width: 1440, height: 900 };

// Opens the scenario PR by navigating to its route. PrTabHost's route effect
// (parsePrRoute → addTab) registers the keep-alive tab from the URL alone, so a
// direct navigation mounts the view AND registers the PrTabStrip pill — no
// inbox-row click required (the fake inbox is empty; see the header comment).
async function openScenarioPr(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/pr/acme/api/123');
  await page.locator('[data-testid="pr-header"]').waitFor();
  await expect(page.locator('[data-testid="pr-title"]')).toHaveText('Calc utilities');
}

// Clicks the Header "Inbox" link (SPA nav) to BACKGROUND the current PR view,
// then waits for the inbox to be visible.
async function backgroundViaInboxLink(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('link', { name: /^Inbox$/ }).click();
  // The inbox toolbar's paste-URL input is the deterministic "inbox is visible"
  // signal. The fake backend serves an EMPTY inbox (no scenario row), so we
  // anchor on always-present inbox chrome rather than a PR row.
  await expect(page.getByPlaceholder(/paste a pr url/i)).toBeVisible();
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
    // try/finally so the request context is always disposed even if the reset
    // POST throws (e.g. backend not yet up) — otherwise the context leaks.
    try {
      await resetBackendState(ctx);
    } finally {
      await ctx.dispose();
    }
    await page.setViewportSize(VIEWPORT);
  });

  // -------------------------------------------------------------------------
  // Test 1 — Files sub-tab selection + selected file survive PR → Inbox → PR
  // -------------------------------------------------------------------------
  test('Files sub-tab and selected file survive PR→Inbox→PR via in-app nav', async ({ page }) => {
    await setupAndOpenScenarioPr(page); // authenticate (fresh DataDir → no-token)
    await openScenarioPr(page);

    // --- Switch to the Files sub-tab (component state, not a URL route) ---
    await page.locator('[data-testid="pr-tab-files"]').click();
    await page.locator('[data-testid="files-tab-tree"]').waitFor();

    // --- Select the canonical file ---
    const fileRow = page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]');
    await fileRow.click();
    await expect(page.locator('[data-testid="files-tab-diff"]')).toBeVisible();
    // Selected-file marker: FileTree stamps data-selected={isSelected} on the
    // row (FileTree.tsx). This is the contract attribute re-checked after return.
    await expect(fileRow).toHaveAttribute('data-selected', 'true');

    // --- BACKGROUND via the Header Inbox link (SPA), RETURN via the strip pill ---
    await backgroundViaInboxLink(page);
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
    await openScenarioPr(page);
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
    await expect(banner).toHaveCount(0, { timeout: 15_000 });
  });
});
