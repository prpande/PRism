import { test, expect, request, type Page } from '@playwright/test';
import { BACKEND_ORIGIN } from './helpers/backend-origin';
import {
  resetBackendState,
  setupAndOpenScenarioPr,
  advanceHead,
  reloadPr,
} from './helpers/s4-setup';

// #486 — change-navigation rail (whole-file minimap + prev/next controls).
//
// FIXTURE CONSTRAINT (Option C — see docs/plans/2026-06-15-diff-change-navigation.md
// Task 8 + follow-up #498): the hermetic fake backend
// (FakePrReader.GetDiffAsync) always emits a single all-addition hunk for
// src/Calc.cs, so whole-file mode renders ONE contiguous change block = one
// full-height tick. That is enough to lock the rail/controls CHROME and the live
// wiring — presence, aria-hidden, hover-intent expand, viewport tracking, the
// controls counter — but it cannot exercise multi-tick navigation, mixed tick
// colors, the drag-scrub gap between ticks, or a dense diff. Those need a richer
// base/head/scattered-hunk fixture and are tracked in #498; their
// logic is already covered by the DiffChangeNav unit tests (computeChanges /
// computeTicks, goToChange clamp, drag-scrub, hover-intent grace window).

// A file tall enough to overflow the diff pane at 1440x900 so nav.hasOverflow is
// true and the rail mounts (Calc3's 8 lines never overflow a 900px-tall pane).
// Seeded as the new head via advance-head; the diff is all-insert against the
// empty base (see the fixture constraint above).
const TALL_CALC = [
  'namespace Acme;',
  'public static class Calc {',
  ...Array.from(
    { length: 40 },
    (_, i) => `  public static int Op${i}(int a, int b) => a + b + ${i};`,
  ),
  '}',
  '',
].join('\n');
const TALL_HEAD_SHA = '4444444444444444444444444444444444444444';

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  // Authenticated mutation: page.request shares the browser context's session
  // cookie, so this must run AFTER setupAndOpenScenarioPr (the unauthenticated
  // request context used by resetBackendState 401s on this mutating verb).
  const resp = await page.request.post('/api/preferences', {
    data: { theme },
    headers: { Origin: BACKEND_ORIGIN },
  });
  if (!resp.ok()) {
    throw new Error(
      `POST /api/preferences (theme=${theme}) failed: ${resp.status()} ${await resp.text()}`,
    );
  }
}

// Lands on the Files tab with whole-file mode on and the change-nav rail mounted.
// `theme` (optional) is applied after auth and before the /files mount so the
// SPA's initial usePreferences fetch picks it up and applyThemeToDocument runs.
async function openWholeFileWithRail(page: Page, theme?: 'light' | 'dark'): Promise<void> {
  await setupAndOpenScenarioPr(page);
  if (theme) await setTheme(page, theme);
  // Swap in a tall file at a new head so whole-file mode overflows and the rail
  // mounts. The 'all' iteration view (the default) diffs base..currentHead.
  await advanceHead(page, TALL_HEAD_SHA, [{ path: 'src/Calc.cs', content: TALL_CALC }]);
  await reloadPr(page, { owner: 'acme', repo: 'api', number: 123 }, TALL_HEAD_SHA);
  await page.goto('/pr/acme/api/123/files');
  await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();
  const diff = page.locator('[data-testid="files-tab-diff"]');
  await diff.waitFor();
  // Wait for several insert rows so the PrDetailLoader snapshot cache is
  // populated before the whole-file fetch (mirrors the parity whole-file test;
  // an early fetch 422s with snapshot-evicted).
  await diff.locator('tr.diff-line--insert').nth(7).waitFor();
  // "Show full file" lives in the DiffSettingsMenu gear; the rail only renders in
  // whole-file mode.
  await page.locator('[data-testid="diff-settings-trigger"]').click();
  const showFullFile = page.locator('[data-testid="show-full-file-checkbox"]');
  await showFullFile.click();
  await expect(showFullFile).toBeChecked();
  await page.keyboard.press('Escape'); // close the gear popover so it isn't over the rail
  // Whole-file engaged once the hunk-header rows are gone. Generous timeout: this
  // spec runs early in the suite, so the whole-file fetch + interleave + re-render
  // can exceed the 5s default on a cold backend (observed flaky on CI otherwise).
  await expect(page.locator('.diff-line--hunk-header')).toHaveCount(0, { timeout: 15_000 });
}

test.describe('#486 change-navigation rail — interaction (hermetic)', () => {
  test.beforeEach(async () => {
    // This spec runs early in the suite, so it eats the backend cold-start (first
    // .NET request + fake-mode swap init). The full flow (auth + advance-head +
    // reload + goto + whole-file toggle + fetch) exceeded the 30s default on a
    // cold CI runner; mirror the parity inbox test's cold-start headroom.
    test.setTimeout(60_000);
    const ctx = await request.newContext();
    await resetBackendState(ctx);
    await ctx.dispose();
  });

  test('whole-file mode mounts the rail + controls; hover expands; scroll tracks', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWholeFileWithRail(page);

    // Controls render with a 1-based counter (never the em dash — #486 review).
    const controls = page.getByRole('group', { name: 'Change navigation' });
    await expect(controls).toBeVisible();
    await expect(controls).toContainText('1 / 1');

    // The rail mounts and is hidden from the a11y tree.
    const rail = page.getByTestId('change-minimap');
    await expect(rail).toBeVisible();
    await expect(rail).toHaveAttribute('aria-hidden', 'true');

    // Hover-intent: hovering widens the rail (data-expanded driven by JS, not
    // CSS :hover, so it can linger past small strays).
    await rail.hover();
    await expect(rail).toHaveAttribute('data-expanded', 'true');

    // The viewport indicator tracks live scrolling. This guards the regression
    // the listener-reattach fix addressed (useChangeNavigation deps include
    // `changes` so the scroll listener binds once the body mounts late).
    const viewport = page.getByTestId('change-minimap-viewport');
    const body = page.locator('.diff-pane-body');
    await body.evaluate((el) => {
      el.scrollTop = 0;
    });
    const topAtStart = await viewport.evaluate(
      (el) => parseFloat((el as HTMLElement).style.top) || 0,
    );
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect
      .poll(async () => viewport.evaluate((el) => parseFloat((el as HTMLElement).style.top) || 0))
      .toBeGreaterThan(topAtStart);
  });

  test('n / p keys are wired and clamp at the single change', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWholeFileWithRail(page);
    const controls = page.getByRole('group', { name: 'Change navigation' });
    await expect(controls).toContainText('1 / 1');
    // The global n/p handler fires whenever the diff body is visible and focus is
    // not in an input. With a single change the moves clamp to no-ops; assert the
    // handler is wired (no throw) and the counter holds. Meaningful multi-change
    // navigation is unit-tested and deferred to the rich-fixture follow-up.
    await page.keyboard.press('n');
    await page.keyboard.press('p');
    await expect(controls).toContainText('1 / 1');
  });
});

// Pixel baselines are a CI-only gate: canonical baselines are rendered in the
// Linux Playwright container and live under __screenshots__/linux/. Local
// machines render fonts/subpixels differently, so these are skipped off-CI (the
// interaction suite above covers behaviour locally). Mirrors parity-baselines.
const SCREENSHOT_OPTS = { maxDiffPixelRatio: 0.02 };
const KILL_ANIMATIONS_CSS =
  '*, *::before, *::after { animation: none !important; transition: none !important; }';
const THEMES = ['light', 'dark'] as const;

test.describe('#486 change-navigation rail — visual baselines', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!process.env.CI, 'pixel baselines are CI-only (machine-specific rendering)');
    const ctx = await request.newContext();
    await resetBackendState(ctx);
    await ctx.dispose();
    // Determinism: block web fonts + avatar CDN so the baseline doesn't vary
    // with network timing / cached Geist metrics (mirrors parity-baselines).
    await page.route('**/fonts.googleapis.com/**', (route) => route.abort());
    await page.route('**/fonts.gstatic.com/**', (route) => route.abort());
    await page.route('**/avatars.githubusercontent.com/**', (route) => route.abort());
  });

  test.afterEach(async ({ page }) => {
    // Restore the default theme so a dark capture doesn't leak into other specs'
    // baselines on the long-running shared backend. Best-effort + authenticated
    // (resetBackendState's preference reset is unauthenticated and silently 401s).
    try {
      await page.request.post('/api/preferences', {
        data: { theme: 'light' },
        headers: { Origin: BACKEND_ORIGIN },
      });
    } catch {
      /* best-effort */
    }
  });

  for (const theme of THEMES) {
    test(`rail at rest (${theme})`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openWholeFileWithRail(page, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
      await expect(page.locator('[data-testid="diff-pane"]')).toHaveScreenshot(
        `change-nav-rail-rest-${theme}.png`,
        SCREENSHOT_OPTS,
      );
    });

    test(`rail expanded on hover (${theme})`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openWholeFileWithRail(page, theme);
      const rail = page.getByTestId('change-minimap');
      await rail.hover();
      await expect(rail).toHaveAttribute('data-expanded', 'true');
      await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
      await expect(page.locator('[data-testid="diff-pane"]')).toHaveScreenshot(
        `change-nav-rail-expanded-${theme}.png`,
        SCREENSHOT_OPTS,
      );
    });
  }
});
