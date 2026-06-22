import { test, expect, request } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

// ---------------------------------------------------------------------------
// #563 — Inbox keep-alive (end-to-end, real fake backend).
//
// WHAT this proves: navigating from the Inbox into a PR detail and back via
// IN-APP (SPA) navigation no longer remounts the Inbox — its active filter
// survives the round trip, where today it resets to default. The Inbox is the
// keep-alive counterpart of the PR-detail tabs (PrTabHost); this is the parent
// slice's deferred Inbox keep-alive item.
//
// WHY the fake backend (not route mocks): the cycle must round-trip through a
// REAL, loadable PR detail. Mocking the PR endpoint to an error crashes the PR
// view into the root ErrorBoundary, which unmounts the whole tree (Inbox
// included) — a test artifact, not a keep-alive failure. The fake backend serves
// the canonical PR acme/api/123 ("Calc utilities"), which loads cleanly.
//
// WHY click-driven (not page.goto for the cycle): keep-alive lives in React
// component state. A full reload (page.goto) tears down the React tree and that
// state is GONE — keep-alive explicitly does NOT promise reload survival. So the
// background→return cycle is real UI navigation:
//   - BACKGROUND: click the Header "Inbox" link (a react-router <Link to="/">).
//   - RETURN:     click the PrTabStrip pill for the open PR.
// The INITIAL page.goto('/pr/...') only opens the PR (registers the tab pill);
// the filter is typed AFTER, during the SPA keep-alive phase.
//
// SCROLL-OFFSET NOTE (same as pr-tab-keepalive.spec.ts): useTabScrollMemory
// saves/restores scrollTop on [data-app-scroll], the scroll viewport only in the
// desktop shell; in a plain browser the WINDOW scrolls, so an e2e scrollTop
// assertion is vacuous. The save/restore logic is unit-tested
// (useTabScrollMemory.test.tsx). This e2e proves the browser-observable half: the
// Inbox stays mounted-but-hidden over a PR, and its filter survives the round trip.
// ---------------------------------------------------------------------------

const VIEWPORT = { width: 1280, height: 800 };
const SEARCH = /filter inbox, or paste a pr url/i;
const FILTER_TEXT = 'keep-this-across-nav';

test.describe('inbox keep-alive (#563)', () => {
  test.beforeEach(async ({ page }) => {
    const ctx = await request.newContext();
    try {
      await resetBackendState(ctx);
    } finally {
      await ctx.dispose();
    }
    await page.setViewportSize(VIEWPORT);
  });

  test('active filter survives Inbox→PR→Inbox via in-app navigation', async ({ page }) => {
    await setupAndOpenScenarioPr(page); // authenticate → lands on the inbox

    // Open the scenario PR (registers the PrTabStrip pill). This initial goto is
    // the only full load; the keep-alive cycle below is pure SPA navigation.
    await page.goto('/pr/acme/api/123');
    await page.locator('[data-testid="pr-header"]').waitFor();
    await expect(page.locator('[data-testid="pr-title"]')).toHaveText('Calc utilities');

    // --- BACKGROUND to the Inbox (SPA) and apply a filter there ---
    await page.getByRole('link', { name: /^Inbox$/ }).click();
    const search = page.getByRole('searchbox', { name: SEARCH });
    await expect(search).toBeVisible();
    // First-run AI onboarding can overlay the inbox on its initial mount; dismiss
    // it so it doesn't intercept the keep-alive cycle below. Dismissal lives in
    // InboxPage state, so keep-alive also keeps it gone on return (defensive: the
    // dialog may already be suppressed for a returning user, hence the catch).
    await page
      .getByRole('button', { name: /maybe later/i })
      .click({ timeout: 5000 })
      .catch(() => {});
    await search.fill(FILTER_TEXT);
    await expect(search).toHaveValue(FILTER_TEXT);

    const inbox = page.locator('[data-testid="inbox-page"]');
    await expect(inbox).toBeVisible();

    // --- RETURN to the PR (SPA via the tab pill): Inbox hides but stays MOUNTED ---
    await page
      .locator('[data-testid="pr-tabstrip"] [data-prref="acme/api/123"] [role="tab"]')
      .click();
    await expect(page).toHaveURL(/\/pr\/acme\/api\/123/);
    await expect(inbox).toBeAttached(); // keep-alive: not remounted, just hidden
    await expect(inbox).toBeHidden();

    // --- BACK to the Inbox (SPA): the filter must survive (today it resets) ---
    await page.getByRole('link', { name: /^Inbox$/ }).click();
    await expect(inbox).toBeVisible();
    await expect(page.getByRole('searchbox', { name: SEARCH })).toHaveValue(FILTER_TEXT);
  });
});
