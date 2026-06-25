import { test, expect, request } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

// ---------------------------------------------------------------------------
// Checks tab — end-to-end against the REAL fake backend (FakePrChecksReader).
// ---------------------------------------------------------------------------
//
// PRISM_E2E_FAKE_REVIEW=1 (set in playwright.config.ts webServer env for the
// prod project) swaps in FakePrChecksReader, which returns three deterministic
// checks for any PR:
//   • build   Completed / Failure   (1 failing)
//   • lint    InProgress            (in-progress wins the lead glyph)
//   • test    Completed / Success   (passing)
//
// checksGlyphState: anyRunning=true (lint) → lead='in-progress',
// ariaSummary='Checks — running', failingCount=1.
//
// This spec opens the scenario PR (acme/api/123), clicks the Checks tab, and
// asserts the rendered check rows, tab-strip health summary, failing badge, and
// Details links — all DOM assertions, no toHaveScreenshot.
//
// prod project only — the dev project cannot run scenario specs
// (reference_dev_playwright_project_cant_run_scenario_specs).

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await ctx.dispose();
});

test('Checks tab lists fixture checks with health summary, failing badge, and detail panel', async ({
  page,
}) => {
  // Authenticate and land on the inbox (fresh DataDir → no-token state).
  await setupAndOpenScenarioPr(page);

  // Navigate to the scenario PR. PrTabHost's route effect (parsePrRoute → addTab)
  // registers the keep-alive tab from the URL alone — no inbox-row click needed
  // (the fake inbox is empty; see pr-tab-keepalive.spec.ts header comment).
  await page.goto('/pr/acme/api/123');
  await page.locator('[data-testid="pr-header"]').waitFor();
  await expect(page.locator('[data-testid="pr-title"]')).toHaveText('Calc utilities');

  // Click the Checks sub-tab (data-testid="pr-tab-checks" per PrSubTabStrip.tsx:162).
  await page.getByTestId('pr-tab-checks').click();

  // --- Assert: fixture check rows are rendered ---
  // ChecksTab.tsx renders <span data-testid="check-name"> for each check.
  // sortChecks puts failing first (build), then in-progress (lint), then passing (test).
  await expect(page.getByTestId('check-name').filter({ hasText: 'build' })).toBeVisible();
  await expect(page.getByTestId('check-name').filter({ hasText: 'lint' })).toBeVisible();
  await expect(page.getByTestId('check-name').filter({ hasText: 'test' })).toBeVisible();

  // --- Assert: tab aria-label carries the health summary ---
  // checksGlyphState: anyRunning=true (lint is InProgress) → ariaSummary='Checks — running'.
  // The aria-label is set on the tab button via ariaLabel={checksAriaLabel}
  // (PrSubTabStrip.tsx Tab component, aria-label={ariaLabel}).
  await expect(page.getByTestId('pr-tab-checks')).toHaveAttribute('aria-label', /running/i);

  // --- Assert: failing badge shows 1 ---
  // PrSubTabStrip.tsx renders <span data-testid="pr-tab-count"> inside the tab button
  // when count > 0. checksFailingCount=1 (build is Failure). Scoped to the checks tab.
  const checksTab = page.getByTestId('pr-tab-checks');
  await expect(checksTab.getByTestId('pr-tab-count')).toHaveText('1');

  // --- Assert: detail panel shows summary for the auto-selected first row (build, failing) ---
  // sortChecks puts build first (failing tier). The detail panel auto-selects it.
  // FakePrChecksReader sets Summary: "2 errors, 0 warnings" for build.
  await expect(page.getByText('2 errors, 0 warnings')).toBeVisible();

  // --- Assert: the markdown body renders via MarkdownRenderer (data-testid="check-body") ---
  // FakePrChecksReader sets build's Body to "### Build failed\n\n- ...". The hardened
  // renderer turns the heading into DOM, so the body region is visible with that text.
  const body = page.getByTestId('check-body');
  await expect(body).toBeVisible();
  await expect(body).toContainText('Build failed');

  // --- Assert: detail panel "View on GitHub" link points at an https:// URL ---
  // CheckDetail renders <a href={c.detailsUrl}>View on GitHub ↗</a> when detailsUrl is set.
  // FakePrChecksReader sets detailsUrl for all three checks.
  const link = page.getByRole('link', { name: /view on github/i }).first();
  await expect(link).toHaveAttribute('href', /^https:\/\//);
});
