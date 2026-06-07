import { test, expect, request, type Page } from '@playwright/test';
import { BACKEND_ORIGIN } from './helpers/backend-origin';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';
import {
  setupAndOpenHandoffParityFixture,
  setupAndOpenHandoffParityFixtureWithStaleDraft,
} from './helpers/parity-fixture';

// Three parity tests need a deterministic aiPreview=false to keep their
// baselines stable: resetBackendState in the beforeEach hook uses an
// unauthenticated request context that silently 401s on the /api/preferences
// mutating verb, so any prior test that set aiPreview=true (e.g.
// inbox-activity-rail) leaks through. The helper does the authenticated POST
// from the page's own session. Callers MUST trigger a fresh SPA mount after
// (e.g. page.goto or page.reload) — usePreferences only refetches on mount or
// window 'focus', so a POST against an already-loaded SPA leaves React state
// stale.
async function resetAiPreview(page: Page): Promise<void> {
  const resp = await page.request.post('/api/preferences', {
    data: { aiPreview: false },
    headers: { Origin: BACKEND_ORIGIN },
  });
  if (!resp.ok()) {
    throw new Error(
      `POST /api/preferences (aiPreview=false) failed: ${resp.status()} ${await resp.text()}`,
    );
  }
}

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
  // Pixel parity baselines are a CI-ONLY gate: the canonical baselines are
  // generated in the Linux Playwright container (.github/workflows/ci.yml) and
  // live under __screenshots__/linux/. Local machines render fonts/subpixels
  // differently, so they can never match locally (screenshots are a CI
  // regression gate, not a local one). The non-visual suite covers behaviour
  // locally; these run on CI against the canonical baselines.
  test.skip(!process.env.CI, 'pixel baselines are CI-only (machine-specific rendering)');
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await ctx.dispose();
});

// Avatar determinism (#127): the four avatar'd zones — inbox (sm), pr-detail-header
// (lg), pr-detail-overview (md band), pr-detail-files-diff (sm review-comment widget)
// — must not depend on a live avatars.githubusercontent.com fetch, or the baseline
// would vary with CDN/network timing. Abort the avatar CDN so the deterministic
// initials-fallback circle renders. Mirrors the fonts.gstatic.com abort precedent in
// the pr-detail-files-diff test. Fake-mode fixtures generally carry no avatarUrl (so
// most zones already render initials), but this guarantees determinism even if a
// fixture ever gains one. Registered AFTER the CI-skip hook above so it inherits the
// same local skip (the route only matters when the test actually runs, i.e. on CI).
test.beforeEach(async ({ page }) => {
  await page.route('**/avatars.githubusercontent.com/**', (route) => route.abort());
});

test.describe('parity baselines — Inbox', () => {
  test('inbox', async ({ page }) => {
    // Cold-start of the prod project (single-binary path) needs more wall-clock
    // than the default 30s: the fake-mode swap initialises after the first
    // /api/inbox request, the first GitHubSectionQueryRunner tick gets a 401
    // from real GitHub before the orchestrator settles, and Kestrel's first
    // static-asset request from a fresh worker is cold. Bumping the test
    // timeout to 60s absorbs that cold-start without changing the steady-state
    // wait targets below.
    test.setTimeout(60_000);
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);
    // setupAndOpenScenarioPr's `waitForURL('/')` matches transiently — the SPA
    // can bounce back to '/setup' if the AuthGuard re-evaluates before the
    // fake-mode swap fully settles. Force-navigate to '/' once more (the
    // backing-store has accepted the token by now) so the Inbox actually
    // renders. Mirrors the recovery pattern in `inbox-activity-rail` below
    // (which reloads after toggling preferences for the same reason).
    await page.goto('/');
    // setupAndOpenScenarioPr lands on '/', so wait for the populated Inbox
    // section header to render, not just `<main>`. `<main>` mounts during the
    // Loading state, which would capture "Loading..." instead of the populated
    // list (D64a → D83 weakness). The 45s wait timeout covers the same cold-
    // start window inside the bumped 60s test timeout.
    await page.getByText(/Review requested/).waitFor({ timeout: 45_000 });
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(page.locator('main')).toHaveScreenshot('inbox.png', SCREENSHOT_OPTS);
  });

  test('inbox-activity-rail', async ({ page }) => {
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
      headers: { Origin: BACKEND_ORIGIN },
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
  test('setup-card', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await page.goto('/setup');
    const card = page.locator('[data-testid="setup-card"]');
    await card.waitFor();
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(card).toHaveScreenshot('setup-card.png', SCREENSHOT_OPTS);
  });
});

// #134: the standalone /settings page was replaced by the routed Settings modal.
// Its visual coverage now lives in settings-modal-visual.spec.ts (appearance /
// github-connection / narrow), so the old settings-page parity baseline is gone.

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
    // Reset aiPreview BEFORE the goto — the goto mounts FilesTab fresh,
    // which is when usePreferences's initial fetch picks up aiPreview=false.
    // Without this gate, FilesTab's auto-select renders the AI focus dot on
    // the selected file row whenever a prior test (e.g. inbox-activity-rail)
    // has leaked aiPreview=true through resetBackendState's unauthenticated
    // POST. See the resetAiPreview helper docstring at the top of this file.
    await resetAiPreview(page);
    await page.goto('/pr/acme/api/123/files');
    const tree = page.locator('[data-testid="files-tab-tree"]');
    await tree.waitFor();
    // Wait for the auto-selected row to settle so the screenshot is captured
    // post-selection (the row's tinted background is the new baseline).
    await page.locator('[data-testid="files-tab-tree-row"][data-selected="true"]').waitFor();
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(tree).toHaveScreenshot('pr-detail-files-tree.png', SCREENSHOT_OPTS);
  });

  test('pr-detail-files-diff', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    // Block Google Fonts requests before any navigation so both isolated runs
    // (cold cache) and full-suite runs (Geist cached from prior pages) render
    // with the system fallback font. Page-level route intercepts fire before
    // cache lookup, so aborting here is effective even when Geist IS in the
    // Chromium session cache from earlier tests. Without this, full-suite
    // Geist (larger metrics) vs isolated fallback (smaller metrics) produce
    // a height difference that exceeds the 2% pixel-ratio tolerance.
    await page.route('**/fonts.googleapis.com/**', (route) => route.abort());
    await page.route('**/fonts.gstatic.com/**', (route) => route.abort());
    await setupAndOpenHandoffParityFixture(page);
    // Reset aiPreview BEFORE the goto so FilesTab's usePreferences picks up
    // aiPreview=false on its initial mount. See the resetAiPreview helper
    // docstring at the top of this file. Without this gate, the inbox-
    // activity-rail leak produces a ~77 px height discrepancy in the diff
    // container between full-suite and isolated runs.
    await resetAiPreview(page);
    await page.goto('/pr/acme/api/123/files');
    // Select the canonical scenario file so the diff pane has content. The
    // scenario fixture defines src/Calc.cs at three iterations (Calc1/2/3).
    await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();
    const diff = page.locator('[data-testid="files-tab-diff"]');
    await diff.waitFor();
    // Wait for ALL 8 pure-insert rows to render before screenshotting.
    // The fixture's src/Calc.cs diff is pure-insert (8 lines), so the 8th
    // .diff-line--insert element is the signal that the diff data is fully
    // present. tr.first().waitFor() was insufficient: the first <tr>
    // (hunk-header) exists before all insert rows are laid out.
    await diff.locator('tr.diff-line--insert').nth(7).waitFor();
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(diff).toHaveScreenshot('pr-detail-files-diff.png', SCREENSHOT_OPTS);
  });

  test('split mode uses 4-column <tr> layout; unified collapses to 3-column layout', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);
    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();
    const diff = page.locator('[data-testid="files-tab-diff"]');
    await diff.waitFor();
    // Wait for at least one diff-line row to render — the diff data fetch
    // completes asynchronously, so the container may exist before the rows do.
    await diff.locator('tr').first().waitFor();

    // Default mode is 'side-by-side'. The fixture diff for src/Calc.cs is a
    // pure-insert file (all lines added against an empty base), so
    // WordDiffOverlay is not emitted (it only fires for adjacent delete+insert
    // pairs). Instead verify the structural signature of split mode: each
    // data row has 4 <td> cells (old-gutter | old-content | new-gutter |
    // new-content) via the SplitDiffLineRow solo-insert layout.
    const splitDataRows = await diff
      .locator('tr')
      .filter({ hasNot: page.locator('td[colspan]') }) // exclude hunk-header (colSpan=4) + comment rows
      .all();
    expect(splitDataRows.length).toBeGreaterThan(0);
    for (const row of splitDataRows) {
      const cellCount = await row.locator('td').count();
      expect(cellCount).toBe(4); // split: old-gutter | old-content | new-gutter | new-content
    }

    // Select Unified via the inline diff-view tiles (the toolbar text button is
    // gone). Click the label rather than the clip-hidden radio input.
    await page.locator('label:has([data-testid="diff-view-unified"])').click();
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="diff-pane"].diff-pane--unified'),
    );

    // In unified mode, data rows have 3 <td> cells
    // (old-gutter | new-gutter | content) — the two-column side-by-side
    // layout collapses to a single content column.
    const unifiedDataRows = await diff
      .locator('tr')
      .filter({ hasNot: page.locator('td[colspan]') }) // exclude hunk-header + comment rows
      .all();
    expect(unifiedDataRows.length).toBeGreaterThan(0);
    for (const row of unifiedDataRows) {
      const cellCount = await row.locator('td').count();
      expect(cellCount).toBe(3); // unified: old-gutter | new-gutter | content
    }
  });

  test('viewport <900px forces unified className regardless of stored diffMode', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await setupAndOpenHandoffParityFixture(page);
    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();
    const diffPane = page.locator('[data-testid="diff-pane"]');
    await diffPane.waitFor();
    await expect(diffPane).toHaveClass(/diff-pane--unified/);
  });

  test('pr-detail-drafts', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixtureWithStaleDraft(page);
    await page.goto('/pr/acme/api/123/drafts');
    const drafts = page.locator('[data-testid="drafts-tab-root"]');
    await drafts.waitFor();
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(drafts).toHaveScreenshot('pr-detail-drafts.png', SCREENSHOT_OPTS);
  });

  test('pr-detail-reconciliation-panel', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixtureWithStaleDraft(page);
    // Unlike pr-detail-files-tree / pr-detail-files-diff (which `goto`
    // /files AFTER the POST, triggering a fresh SPA mount that picks up
    // aiPreview=false on the initial usePreferences fetch), the stale-
    // draft fixture has ALREADY navigated to /files and reloaded by the
    // time we're here. usePreferences only refetches on mount or window
    // 'focus' (frontend/src/hooks/usePreferences.ts:73-80), so a bare POST
    // updates the backend but leaves the SPA's React state pointing at
    // whatever aiPreview was at the fixture's final reload. The reload()
    // after the POST forces a fresh mount → fresh fetch → the
    // StaleDraftRow's draftSuggestionsEnabled-gated AI-suggestion span
    // (~26 px) consistently absent. Copilot iter-1 caught this race.
    await resetAiPreview(page);
    await page.reload();
    const panel = page.locator('[data-testid="unresolved-panel"]');
    await panel.waitFor();
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(panel).toHaveScreenshot('pr-detail-reconciliation-panel.png', SCREENSHOT_OPTS);
  });
});

test.describe('parity baselines — app chrome', () => {
  test('app-chrome-tabstrip', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);
    // Open the single fixture PR (acme/api/123). PrDetailPage's addTab effect
    // (Task 6) seeds openTabs with this ref; the Task 6 setTitle effect fills
    // in the title once usePrDetail resolves.
    await page.goto('/pr/acme/api/123');
    await page.locator('[data-testid="pr-header"]').waitFor();
    // Navigate back to Inbox via SPA routing (NOT page.goto, which would
    // trigger a hard reload and wipe the in-memory openTabs state per D59).
    // The Header has a <Link to="/">Inbox</Link> that uses react-router
    // pushState — openTabs survives.
    await page.getByRole('link', { name: 'Inbox' }).click();
    await page.waitForURL(/\/$/);
    await page.locator('[data-testid="pr-tabstrip"]').waitFor();
    // SSE per-PR fanout is subscription-gated: SseChannel.OnActivePrUpdated only
    // delivers `pr-updated` to subscribers registered for that prRef via
    // POST /api/events/subscriptions. useActivePrUpdates auto-subscribes on
    // PrDetailPage mount AND auto-unsubscribes on unmount — so navigating to
    // Inbox above DELETED the subscription. Without re-subscribing here, the
    // emit-pr-updated POST below fans out to zero subscribers, useTabUnreadSignal
    // never sees the event, and the tabUnread class never appears. Resubscribe
    // explicitly so the inactive-tab unread visual can be captured. The Origin
    // header satisfies OriginCheckMiddleware (matches the loopback pattern in
    // helpers/s4-setup.ts).
    const subResp = await page.request.post('/api/events/subscriptions', {
      data: { PrRef: 'acme/api/123' },
      headers: { Origin: BACKEND_ORIGIN },
    });
    if (!subResp.ok()) {
      throw new Error(
        `POST /api/events/subscriptions failed: ${subResp.status()} ${await subResp.text()}`,
      );
    }
    // Mark the tab unread via the existing /test/emit-pr-updated hook (S6 PR9).
    // Endpoint binds EmitPrUpdatedRequest(Owner, Repo, Number, HeadShaChanged,
    // CommentCountChanged, NewHeadSha, CommentCountDelta) — see
    // PRism.Web/TestHooks/TestEndpoints.cs:42-49 + :137-153 for the validation
    // rules. We use CommentCountChanged=true + delta=1 to fire an unread signal
    // without an SHA change (head-sha change would also work but requires the
    // backend to know the next sha; not needed here).
    const emitResp = await page.request.post('/test/emit-pr-updated', {
      data: {
        Owner: 'acme',
        Repo: 'api',
        Number: 123,
        HeadShaChanged: false,
        CommentCountChanged: true,
        NewHeadSha: null,
        CommentCountDelta: 1,
      },
      headers: { Origin: BACKEND_ORIGIN },
    });
    if (!emitResp.ok()) {
      throw new Error(
        `POST /test/emit-pr-updated failed: ${emitResp.status()} ${await emitResp.text()}`,
      );
    }
    // Wait for the unread dot to render. CSS-module classes are hashed —
    // match on partial class. If the selector turns out flaky, add a
    // `data-state="unread"` attribute to the tab via a follow-up.
    await page.locator('[data-testid="pr-tabstrip"] [class*="tabUnread"]').first().waitFor();
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(page.locator('[data-testid="pr-tabstrip"]')).toHaveScreenshot(
      'app-chrome-tabstrip.png',
      SCREENSHOT_OPTS,
    );
  });
});

test.describe('parity baselines — PR Detail — whole-file', () => {
  test('pr-detail-files-diff-whole-file: toggle whole-file then capture parity baseline', async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);
    await resetAiPreview(page);
    // Hard-reload to /files so React state (including AskAiDrawer isOpen) is
    // reset to initial values. SPA navigation keeps prior isOpen=true state
    // if the drawer was opened during fixture setup; a full page load clears it.
    await page.goto(`${BACKEND_ORIGIN}/pr/acme/api/123/files`);

    await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();
    const diff = page.locator('[data-testid="files-tab-diff"]');
    await diff.waitFor();
    // Wait for all 8 insert rows to render — mirrors the pr-detail-files-diff baseline
    // test. The PrDetailLoader snapshot-cache is guaranteed populated once the diff rows
    // are present, so the subsequent whole-file fetch doesn't 422 with snapshot-evicted.
    await diff.locator('tr.diff-line--insert').nth(7).waitFor();

    // "Show full file" now lives in the DiffSettingsMenu gear panel.
    // Open the gear, verify the checkbox is unchecked, then enable whole-file.
    const gear = page.locator('[data-testid="diff-settings-trigger"]');
    await expect(gear).toBeVisible();
    await gear.click();
    const showFullFileCheckbox = page.locator('[data-testid="show-full-file-checkbox"]');
    await expect(showFullFileCheckbox).toBeVisible();
    await expect(showFullFileCheckbox).not.toBeChecked();
    expect(await page.locator('tr[data-fill="true"]').count()).toBe(0);

    await showFullFileCheckbox.click();
    await expect(showFullFileCheckbox).toBeChecked();
    // Wait for hunk-header rows to disappear (wholeFileEnabled=true, fetchStatus='ok').
    // The fixture's hunk spans all content lines; the file's trailing newline produces
    // ONE empty filled-context row at headLines.length (the split of a terminal-newline
    // string emits an extra empty element). Waiting for the hunk-header to leave is the
    // correct liveness signal; the filled-row count assertion below pins the behavior.
    await expect(page.locator('.diff-line--hunk-header')).toHaveCount(0);
    await expect(page.locator('tr[data-fill="true"]')).toHaveCount(1);

    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(page.locator('[data-testid="diff-pane"]')).toHaveScreenshot(
      'pr-detail-files-diff-whole-file.png',
      SCREENSHOT_OPTS,
    );

    // Toggle off + scroll-reset assertion: uncheck the checkbox to revert.
    await page.locator('[data-testid="diff-pane"]').evaluate((el) => {
      (el.querySelector('.diff-pane-body') as HTMLElement).scrollTop = 500;
    });
    await showFullFileCheckbox.click();
    await expect(showFullFileCheckbox).not.toBeChecked();
    const scrollTop = await page.locator('[data-testid="diff-pane"]').evaluate((el) => {
      return (el.querySelector('.diff-pane-body') as HTMLElement).scrollTop;
    });
    expect(scrollTop).toBe(0);
  });

  test('whole-file toggle disabled when iteration is not "all"', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);
    await page.goto('/pr/acme/api/123/files');
    // Wait for the files tab to fully load before switching iteration.
    await page.locator('[data-testid="files-tab-tree"]').waitFor();

    // The iteration-tab-strip exposes data-testid per iteration (added in Task 10).
    await page.locator('[data-testid="iteration-tab-1"]').click();

    // "Show full file" is now in the DiffSettingsMenu gear. Open it and assert
    // the checkbox is disabled with the expected helper text.
    await page.locator('[data-testid="diff-settings-trigger"]').click();
    const checkbox = page.locator('[data-testid="show-full-file-checkbox"]');
    await expect(checkbox).toBeDisabled();
    await expect(page.locator('[data-testid="show-full-file-helper"]')).toContainText(
      /'all' iteration view/,
    );
  });

  test('whole-file force-failure renders banner and reverts toggle', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);

    // Canonical scenario's headSha is a known stable value.
    const headSha = '3333333333333333333333333333333333333333';

    const forceResp = await page.request.post(`${BACKEND_ORIGIN}/test/file/force-failure`, {
      data: { path: 'src/Calc.cs', sha: headSha, problemType: '/file/too-large' },
      headers: { Origin: BACKEND_ORIGIN },
    });
    expect(forceResp.ok()).toBe(true);

    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();
    // Wait for the diff to fully load before clicking the toggle. This ensures
    // the PrDetailLoader snapshot-cache is populated so the /file endpoint
    // does not 422 with snapshot-evicted.
    await page.locator('[data-testid="files-tab-diff"] tr.diff-line--insert').first().waitFor();
    // "Show full file" now lives in the DiffSettingsMenu gear. Open it and
    // enable whole-file view for the current file.
    await page.locator('[data-testid="diff-settings-trigger"]').click();
    const checkbox = page.locator('[data-testid="show-full-file-checkbox"]');
    await checkbox.click();

    const banner = page.locator('[data-testid="whole-file-failure-banner"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/file is too large/i);
    // After failure the checkbox stays checked (showFullFile=true) but
    // wholeFileEnabled derives to false (failed path excluded).
    await expect(checkbox).toBeChecked();

    await banner.locator('button[aria-label="Dismiss whole-file error banner"]').click();
    await expect(banner).toHaveCount(0);
    // Dismissing the banner clicks outside the gear popover, which (correctly)
    // closes it and unmounts the checkbox. Re-open the gear to assert that the
    // global showFullFile preference persisted across the failure.
    await page.locator('[data-testid="diff-settings-trigger"]').click();
    await expect(checkbox).toBeChecked();
  });
});

test.describe('parity baselines — Ask AI', () => {
  test('ask-ai-drawer', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);

    // Ask AI button is gated on preferences.ui.aiPreview (see AskAiButton.tsx:9).
    // Enable it through the real backend, then reload so usePreferences refetches
    // and the button mounts. Wire shape + Origin header pattern matches the
    // inbox-activity-rail test above (flat dotted-path field, loopback Origin).
    const prefResp = await page.request.post('/api/preferences', {
      data: { aiPreview: true },
      headers: { Origin: BACKEND_ORIGIN },
    });
    if (!prefResp.ok()) {
      throw new Error(
        `POST /api/preferences (aiPreview=true) failed: ${prefResp.status()} ${await prefResp.text()}`,
      );
    }
    await page.reload();
    await page.locator('[data-testid="pr-header"]').waitFor();

    // Open the drawer.
    await page.getByRole('button', { name: 'Ask AI' }).click();
    const drawer = page.locator('[data-testid="ask-ai-drawer"]');
    await expect(drawer).toHaveAttribute('aria-hidden', 'false');

    // Seed two user messages so the capture shows the typical post-conversation
    // state (user bubble + AI reply, twice). cycleIndexRef is bumped
    // synchronously at submit time (see AskAiDrawerContext.tsx:115-116), so the
    // first reply uses AI_UNAVAILABLE_RESPONSES[0] and the second uses
    // AI_UNAVAILABLE_RESPONSES[1]. The reply itself lands after the 600ms
    // AI_REPLY_DELAY_MS timer.
    const composer = drawer.getByRole('textbox', { name: 'Message' });
    const sendButton = drawer.getByRole('button', { name: 'Send' });

    await composer.fill('Why this change?');
    await sendButton.click();
    await expect(drawer.getByText(/summarize the diff per file/)).toBeVisible({ timeout: 5_000 });

    await composer.fill('What about tests?');
    await sendButton.click();
    await expect(drawer.getByText(/surface tests that exercise/)).toBeVisible({ timeout: 5_000 });

    // Kill the 220ms slide-in transition AFTER the reply waits — by now both
    // replies have rendered and the drawer is fully docked, so freezing here
    // captures the steady state.
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(drawer).toHaveScreenshot('ask-ai-drawer.png', SCREENSHOT_OPTS);
  });
});
