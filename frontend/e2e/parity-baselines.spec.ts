import { test, expect, request } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';
import {
  setupAndOpenHandoffParityFixture,
  setupAndOpenHandoffParityFixtureWithStaleDraft,
} from './helpers/parity-fixture';

// Viewport baseline regression for the design-parity-recovery roadmap. Per
// spec §4.1.3:
//   - Per-zone narrow screenshots; full-page screenshots are too brittle.
//   - `maxDiffPixelRatio: 0.02` — loose tolerance (font hinting + GPU
//     subpixel rendering vary across machines; the no-layout-shift spec
//     documents the same fragility).
//   - Initial baselines are NOT committed in PR1. Each restoration PR
//     (PR2-PR8) is responsible for `--update-snapshots` on the zones it
//     touches, with the *first styled / passing state* as the first
//     committed baseline. PR7 additionally re-captures `inbox` +
//     `inbox-activity-rail` because Row 2 chrome shifts Inbox Y-position
//     (§6.9).
//   - The harness is a regression gate, NOT a parity gate. Parity is gated
//     by the human side-by-side review per §4.1.4. The harness catches
//     per-zone visual drift between baseline updates; it does not verify any
//     baseline matches the handoff and does not catch token-level changes
//     that propagate within tolerance to multiple zones.
//   - Several zones reference `data-testid` selectors that don't yet exist
//     in production components. The carve-out in §4.1.3 says each
//     restoration PR (PR2-PR8) adds its zone's selectors as part of that
//     slice's JSX touch. Until then, the affected tests fail at the locator
//     wait — that's the expected pre-restoration state.

// Each test is wrapped with `test.fixme()` to mark it as a known-broken
// scaffold until its restoration PR lands. Restoration PRs (PR2-PR8) remove
// `.fixme` from their zone as part of the JSX touch that adds the zone's
// `data-testid` and commits the first baseline. Playwright reports these as
// "skipped/expected-fail" rather than hard failures, so CI stays green while
// the scaffolding remains visible in test reports.

const VIEWPORT = { width: 1440, height: 900 };

// Matches the no-layout-shift-on-banner.spec.ts precedent: kill animations
// via per-test addStyleTag (DOM-level), not via Playwright's
// `animations: 'disabled'` screenshot option. One mechanism, not two — the
// addStyleTag pattern is the project's established convention.
const SCREENSHOT_OPTS = {
  maxDiffPixelRatio: 0.02,
};

const KILL_ANIMATIONS_CSS =
  '*, *::before, *::after { animation: none !important; transition: none !important; }';

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await ctx.dispose();
});

test.describe('parity baselines — Inbox', () => {
  test.fixme('inbox', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);
    // setupAndOpenScenarioPr lands on '/', so wait for the inbox list to
    // mount.
    await page.locator('main').waitFor();
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(page.locator('main')).toHaveScreenshot('inbox.png', SCREENSHOT_OPTS);
  });

  test.fixme('inbox-activity-rail', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);
    // Activity rail only renders when preferences.ui.aiPreview === true; enable
    // it before the locator wait so the rail mounts and the test can lock the
    // visual baseline. resetBackendState in beforeEach restores the default
    // (aiPreview=false) between tests, so this enable is per-test.
    //
    // Wire shape: POST /api/preferences accepts exactly one flat dotted-path
    // field per patch (see PRism.Web/Endpoints/PreferencesEndpoints.cs and
    // frontend/src/hooks/usePreferences.ts) — NOT a nested
    // `{ ui: { aiPreview: true } }`. Origin header matches the loopback pattern
    // used in helpers/s4-setup.ts (OriginCheckMiddleware requires it on POST).
    const prefResp = await page.request.post('/api/preferences', {
      data: { aiPreview: true },
      headers: { Origin: 'http://localhost:5180' },
    });
    if (!prefResp.ok()) {
      throw new Error(
        `POST /api/preferences (aiPreview=true) failed: ${prefResp.status()} ${await prefResp.text()}`,
      );
    }
    // The SPA reads preferences on initial page load; without reload the rail
    // wouldn't pick up the new state (the focus-refetch path exists but
    // dispatching a focus event from Playwright is less reliable than a reload).
    await page.reload();
    // Activity rail renders only ≥ 1180px viewport per the handoff
    // non-negotiables documented in .ai/docs/design-handoff.md. The 1440px
    // viewport satisfies this.
    const rail = page.locator('[data-testid="activity-rail"]');
    await rail.waitFor();
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(rail).toHaveScreenshot('inbox-activity-rail.png', SCREENSHOT_OPTS);
  });
});

test.describe('parity baselines — Setup', () => {
  test.fixme('setup-card', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await page.goto('/setup');
    const card = page.locator('[data-testid="setup-card"]');
    await card.waitFor();
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(card).toHaveScreenshot('setup-card.png', SCREENSHOT_OPTS);
  });
});

test.describe('parity baselines — Settings', () => {
  test.fixme('settings-page', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);
    await page.goto('/settings');
    await page.locator('[data-testid="settings-page"]').waitFor();
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(page.locator('[data-testid="settings-page"]')).toHaveScreenshot(
      'settings-page.png',
      SCREENSHOT_OPTS,
    );
  });
});

test.describe('parity baselines — PR Detail', () => {
  test('pr-detail-header', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(page.locator('[data-testid="pr-header"]')).toHaveScreenshot(
      'pr-detail-header.png',
      SCREENSHOT_OPTS,
    );
  });

  test('pr-detail-overview', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);
    const overview = page.locator('[data-testid="overview-tab"]');
    await overview.waitFor();
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(overview).toHaveScreenshot('pr-detail-overview.png', SCREENSHOT_OPTS);
  });

  test('pr-detail-files-tree', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);
    await page.goto('/pr/acme/api/123/files');
    const tree = page.locator('[data-testid="files-tab-tree"]');
    await tree.waitFor();
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(tree).toHaveScreenshot('pr-detail-files-tree.png', SCREENSHOT_OPTS);
  });

  test('pr-detail-files-diff', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);
    await page.goto('/pr/acme/api/123/files');
    // Select the canonical scenario file so the diff pane has content. The
    // scenario fixture defines src/Calc.cs at three iterations (Calc1/2/3).
    await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();
    const diff = page.locator('[data-testid="files-tab-diff"]');
    await diff.waitFor();
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(diff).toHaveScreenshot('pr-detail-files-diff.png', SCREENSHOT_OPTS);
  });

  test.fixme('pr-detail-drafts', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);
    await page.goto('/pr/acme/api/123/drafts');
    const drafts = page.locator('[data-testid="drafts-tab"]');
    await drafts.waitFor();
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(drafts).toHaveScreenshot('pr-detail-drafts.png', SCREENSHOT_OPTS);
  });

  test('pr-detail-reconciliation-panel', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixtureWithStaleDraft(page);
    const panel = page.locator('[data-testid="unresolved-panel"]');
    await panel.waitFor();
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(panel).toHaveScreenshot('pr-detail-reconciliation-panel.png', SCREENSHOT_OPTS);
  });
});

// PR7-only zones (added when the PR tab strip ships):
// test('app-chrome-tabstrip', ...) — see PR7 plan.
//
// PR8-only zones (added when the Ask AI drawer ships):
// test('ask-ai-drawer', ...) — see PR8 plan.
