// frontend/e2e/ai-onboarding-visual.spec.ts
//
// #485 AI onboarding overlay — visual regression spec (mock-only, both themes,
// three dialog states, 480px-height viewport). CI-only (machine-specific rendering).
//
// States captured:
//   1. Off selected — light theme
//   2. Off selected — dark theme
//   3. Preview selected (default current mode) — light theme
//   4. Preview selected (default current mode) — dark theme
//   5. Live expanded (disclosure loaded) — light theme
//   6. Live expanded (disclosure loaded) — dark theme
//   7. 480px viewport height — Preview state (scroll constraint: lead + SegmentedControl
//      must be visible without scrolling per spec §13/Task 5 Step 7)
//
// No baseline PNGs are committed here. Generate baselines with:
//   node_modules/.bin/playwright test --update-snapshots ai-onboarding-visual
// Linux CI produces the canonical baselines under e2e/__screenshots__/linux/.
// Baselines are committed per-PR (first styled/passing state), not in this PR.
//
// Mock strategy: serve onboardingSeen=false in the preferences route so InboxPage
// mounts the dialog. A single route handler covers GET and POST /api/preferences
// (POST absorbs dialog commit writes so the dialog's internal close() flow works
// without a real backend). Egress-disclosure is mocked for the Live-state capture.

import { test, expect, type Route } from '@playwright/test';
import { setupBaseRoutes } from './helpers/base-mocks';
import { makeDefaultPreferences } from './fixtures/preferences';

const KILL_ANIMATIONS_CSS =
  '*, *::before, *::after { animation: none !important; transition: none !important; }';

const SCREENSHOT_OPTS = { maxDiffPixelRatio: 0.02 };

// Set up all mocks needed to render the dialog. The preferences GET returns
// onboardingSeen=false to trigger the overlay; POST absorbs dismiss writes.
async function setupDialogMocks(
  page: import('@playwright/test').Page,
  opts: { theme?: 'light' | 'dark' } = {},
): Promise<void> {
  await setupBaseRoutes(page);

  const basePrefs = makeDefaultPreferences();
  const theme = opts.theme ?? 'light';

  // Single handler for both GET and POST /api/preferences. Playwright routes
  // match in LIFO order per pattern — one handler avoids two registrations
  // competing for POST requests.
  await page.route('**/api/preferences', (route: Route) => {
    // POST: dialog commit (seen write / mode write) — return current prefs so
    // the SPA's useSWR revalidates without a 4xx. The dialog closes via local
    // state (`setOpen(false)`) regardless of the response body.
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...basePrefs,
          ui: { ...basePrefs.ui, aiMode: 'preview' as const, theme, onboardingSeen: false },
        }),
      });
    }
    // GET: serve onboardingSeen=false so InboxPage mounts the dialog.
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...basePrefs,
        ui: { ...basePrefs.ui, aiMode: 'preview' as const, theme, onboardingSeen: false },
      }),
    });
  });

  // Inbox: empty sections so the inbox renders in the background without distracting
  // content — the dialog is the focus of each screenshot.
  await page.route('**/api/inbox', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sections: [],
        enrichments: {},
        lastRefreshedAt: new Date().toISOString(),
        tokenScopeFooterEnabled: false,
      }),
    }),
  );

  // Egress disclosure — used by the Live-expanded state captures. Returns the
  // same shape as the ai-live-consent.spec.ts fixture to stay in contract sync.
  await page.route('**/api/ai/egress-disclosure', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        recipient: 'Anthropic, via the Claude Code CLI',
        dataCategories: ['Pull request diff', 'Title', 'Description'],
        disclosureVersion: '1',
        alreadyConsented: false,
      }),
    }),
  );

  // AI consent POST (Live path): absorb so the dialog's consent flow works if
  // accidentally triggered — this spec doesn't click Enable Live AI.
  await page.route('**/api/ai/consent', (route: Route) => route.fulfill({ status: 204 }));
}

// CI-only gate: skip on local machines where platform rendering diverges from the
// canonical Linux baselines. Each beforeEach inherits this guard.
test.beforeEach(async () => {
  test.skip(!process.env.CI, 'visual baselines are CI-only (machine-specific rendering)');
});

// ---------------------------------------------------------------------------
// Off state
// ---------------------------------------------------------------------------

test.describe('onboarding dialog — Off state', () => {
  test('light theme', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setupDialogMocks(page, { theme: 'light' });
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Set up AI for your reviews' });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const offRadioLight = dialog.getByRole('radio', { name: 'Off' });
    await offRadioLight.click();
    // Wait for the selection to settle (aria-checked flips) before capturing, so the
    // screenshot can't race the click's state/style transition.
    await expect(offRadioLight).toHaveAttribute('aria-checked', 'true');
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(dialog).toHaveScreenshot('onboarding-dialog-off-light.png', SCREENSHOT_OPTS);
  });

  test('dark theme', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setupDialogMocks(page, { theme: 'dark' });
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Set up AI for your reviews' });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const offRadioDark = dialog.getByRole('radio', { name: 'Off' });
    await offRadioDark.click();
    // Wait for the selection to settle (aria-checked flips) before capturing, so the
    // screenshot can't race the click's state/style transition.
    await expect(offRadioDark).toHaveAttribute('aria-checked', 'true');
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(dialog).toHaveScreenshot('onboarding-dialog-off-dark.png', SCREENSHOT_OPTS);
  });
});

// ---------------------------------------------------------------------------
// Preview state (default — current mode in the fixture)
// ---------------------------------------------------------------------------

test.describe('onboarding dialog — Preview state', () => {
  test('light theme', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setupDialogMocks(page, { theme: 'light' });
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Set up AI for your reviews' });
    // Preview is already selected (aiMode='preview' in the fixture); no click needed.
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(dialog).toHaveScreenshot('onboarding-dialog-preview-light.png', SCREENSHOT_OPTS);
  });

  test('dark theme', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setupDialogMocks(page, { theme: 'dark' });
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Set up AI for your reviews' });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(dialog).toHaveScreenshot('onboarding-dialog-preview-dark.png', SCREENSHOT_OPTS);
  });
});

// ---------------------------------------------------------------------------
// Live expanded state (disclosure loaded)
// ---------------------------------------------------------------------------

test.describe('onboarding dialog — Live expanded state', () => {
  test('light theme (disclosure loaded)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setupDialogMocks(page, { theme: 'light' });
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Set up AI for your reviews' });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('radio', { name: 'Live' }).click();
    // Wait for the disclosure body to populate (fetched after Live is selected).
    await expect(dialog.getByText('Anthropic, via the Claude Code CLI')).toBeVisible({
      timeout: 10_000,
    });
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(dialog).toHaveScreenshot('onboarding-dialog-live-light.png', SCREENSHOT_OPTS);
  });

  test('dark theme (disclosure loaded)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setupDialogMocks(page, { theme: 'dark' });
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Set up AI for your reviews' });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('radio', { name: 'Live' }).click();
    await expect(dialog.getByText('Anthropic, via the Claude Code CLI')).toBeVisible({
      timeout: 10_000,
    });
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(dialog).toHaveScreenshot('onboarding-dialog-live-dark.png', SCREENSHOT_OPTS);
  });
});

// ---------------------------------------------------------------------------
// 480px viewport height — scroll-constraint test
// ---------------------------------------------------------------------------

test.describe('onboarding dialog — 480px viewport height (short-viewport scroll constraint)', () => {
  test('Preview state — lead + SegmentedControl visible without scrolling', async ({ page }) => {
    // Spec §13/Task 5 Step 7: at a 480px-high viewport, the dialog's lead paragraph
    // AND the SegmentedControl must both be in the viewport without the user scrolling.
    // This capture documents the constraint and detects regressions that push the
    // control below the fold (e.g. an oversized lead or excessive padding above it).
    await page.setViewportSize({ width: 1280, height: 480 });
    await setupDialogMocks(page, { theme: 'light' });
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Set up AI for your reviews' });
    await expect(dialog).toBeVisible({ timeout: 30_000 });

    // Both critical elements must be visible (in-viewport) without any scroll.
    // SegmentedControl renders role="radiogroup" with aria-label="AI mode"
    // (SegmentedControl.tsx) — NOT role="group".
    const segmentedControl = dialog.getByRole('radiogroup', { name: 'AI mode' });
    await expect(segmentedControl).toBeVisible({ timeout: 10_000 });
    // The lead is the first <p> inside the dialog.
    const lead = dialog.locator('p').first();
    await expect(lead).toBeVisible();

    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(dialog).toHaveScreenshot('onboarding-dialog-480px-preview.png', SCREENSHOT_OPTS);
  });
});
