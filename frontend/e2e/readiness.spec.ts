// frontend/e2e/readiness.spec.ts
//
// #593 B1 visual gate: merge-readiness badge state matrix.
//
// Injection: Playwright route.fulfill on **/api/inbox — the same mocked-mode
// technique used by inbox.spec.ts, inbox-enrichment.spec.ts, etc. The
// mergeReadiness field on PrInboxItem is optional (defaults to 'none'), so
// existing fixtures that omit it stay valid.
//
// Structure:
//   § OPEN STATES — 8 states × light+dark: behaviour assertions (badge present,
//     correct label, data-readiness attr) + CI-gated pixel snapshots.
//   § NO-BADGE CASES — merged / closed / draft rows show NO [data-readiness].
//   § TOOLTIP — focus on a 'conflicts' badge opens the popover with the
//     one-liner explanation.
//
// Pixel-snapshot assertions are gated on process.env.CI to match the repo
// convention (parity-baselines.spec.ts, draft-pr-marker.spec.ts). Baselines
// live under __screenshots__/linux/ — bootstrapped from the CI artifact after
// first push.

import { test, expect, type Route } from '@playwright/test';
import { setupBaseRoutes } from './helpers/base-mocks';
import { makeDefaultPreferences } from './fixtures/preferences';
import type { MergeReadiness } from '../src/components/shared/mergeReadiness';
import { READINESS_SHORT, READINESS_TOOLTIP } from '../src/components/shared/mergeReadiness';
import { expectVisual } from './helpers/visual';

// ---------------------------------------------------------------------------
// Constants (mirrors parity-baselines.spec.ts conventions exactly)
// ---------------------------------------------------------------------------

const VIEWPORT = { width: 1440, height: 900 };

const SCREENSHOT_OPTS = {
  maxDiffPixelRatio: 0.02,
};

const KILL_ANIMATIONS_CSS =
  '*, *::before, *::after { animation: none !important; transition: none !important; }';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const defaultPreferences = makeDefaultPreferences();

/** Base inbox item — all required wire fields, mergeReadiness absent (defaults to none). */
const baseItem = {
  reference: { owner: 'acme', repo: 'api', number: 42 },
  title: 'Refactor auth flow',
  author: 'amelia',
  avatarUrl: null,
  repo: 'acme/api',
  updatedAt: new Date('2026-06-01T10:00:00Z').toISOString(),
  pushedAt: new Date('2026-06-01T10:00:00Z').toISOString(),
  iterationNumber: 3,
  commentCount: 2,
  additions: 50,
  deletions: 10,
  commitCount: 1,
  changedFiles: 1,
  headSha: 'abc123',
  ci: 'none' as const,
  lastViewedHeadSha: null,
  lastSeenCommentId: null,
  mergedAt: null,
  closedAt: null,
  isDraft: false,
};

function makeInboxResponse(
  item: typeof baseItem & { mergeReadiness?: MergeReadiness; changesRequested?: number | null },
) {
  return {
    sections: [
      {
        id: 'review-requested',
        label: 'Review requested',
        items: [item],
      },
    ],
    enrichments: {},
    lastRefreshedAt: new Date().toISOString(),
    tokenScopeFooterEnabled: false,
    ciProbeComplete: true,
    aiEnrichmentSettled: [],
    stale: false,
  };
}

/** Wire up base mocks + preferences (no activity rail) + a custom inbox body. */
async function setupMocks(
  page: import('@playwright/test').Page,
  inboxBody: object,
  theme: 'light' | 'dark' = 'light',
) {
  await setupBaseRoutes(page);
  await page.route('**/api/preferences', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...defaultPreferences,
        // Force a deterministic theme so light and dark screenshots are controlled.
        ui: { ...defaultPreferences.ui, theme },
        inbox: { ...defaultPreferences.inbox, groupByRepo: false },
      }),
    }),
  );
  await page.route('**/api/inbox', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(inboxBody),
    }),
  );
}

// ---------------------------------------------------------------------------
// § OPEN STATES (8 states × light + dark)
// ---------------------------------------------------------------------------

// The 8 open-state values that should render a badge.
const OPEN_STATES: MergeReadiness[] = [
  'ready',
  'ready-with-changes-requested',
  'conflicts',
  'behind-base',
  'changes-requested',
  'review-required',
  'blocked-by-protection',
  'unstable',
];

test.use({ viewport: VIEWPORT });

test.describe('readiness badge — open states', () => {
  for (const theme of ['light', 'dark'] as const) {
    test.describe(`theme: ${theme}`, () => {
      // Pixel baselines are CI-only (same guard as parity-baselines.spec.ts); the non-pixel
      // assertions below run locally and on CI. test.skip in a beforeEach would skip only the
      // current test, not the describe block, so pixel shots are gated per-test via process.env.CI.
      for (const readiness of OPEN_STATES) {
        const shortLabel = READINESS_SHORT[readiness];

        test(`[${theme}] ${readiness} — badge label "${shortLabel}" visible`, async ({ page }) => {
          const item = { ...baseItem, mergeReadiness: readiness };
          const inboxBody = makeInboxResponse(item);
          await setupMocks(page, inboxBody, theme);
          await page.goto('/');

          // Wait for the row to render.
          await page
            .getByRole('button', { name: /Refactor auth flow/ })
            .waitFor({ timeout: 30_000 });

          // 1. Badge button exists with correct aria-label.
          const badge = page.getByRole('button', {
            name: `Merge readiness: ${shortLabel}`,
          });
          await expect(badge).toBeVisible();

          // 2. data-readiness attribute matches the wire value.
          await expect(badge).toHaveAttribute('data-readiness', readiness);

          // 3. Badge is a bare glyph (#593) — an inline SVG, no visible text label.
          await expect(badge.locator('svg')).toBeVisible();
          await expect(badge).not.toContainText(shortLabel);

          // 4. Row-level aria-label includes the readiness suffix (accessibility).
          const row = page.getByRole('button', { name: /Refactor auth flow/ }).first();
          const rowLabel = await row.getAttribute('aria-label');
          expect(rowLabel).toContain(shortLabel);

          // Pixel snapshot — CI only.
          if (process.env.CI) {
            await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
            await expectVisual(badge, `readiness-badge-${readiness}-${theme}.png`, SCREENSHOT_OPTS);
          }
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// § NO-BADGE CASES — merged / closed / draft / none
// ---------------------------------------------------------------------------

test.describe('readiness badge — no badge for merged/closed/draft/none', () => {
  test('merged row: no [data-readiness] element', async ({ page }) => {
    const item = {
      ...baseItem,
      mergedAt: new Date().toISOString(),
      mergeReadiness: 'merged' as MergeReadiness,
    };
    await setupMocks(page, makeInboxResponse(item));
    await page.goto('/');
    await page.getByRole('button', { name: /Refactor auth flow/ }).waitFor({ timeout: 30_000 });
    await expect(page.locator('[data-readiness]')).toHaveCount(0);
  });

  test('closed row: no [data-readiness] element', async ({ page }) => {
    const item = {
      ...baseItem,
      closedAt: new Date().toISOString(),
      mergeReadiness: 'closed' as MergeReadiness,
    };
    await setupMocks(page, makeInboxResponse(item));
    await page.goto('/');
    await page.getByRole('button', { name: /Refactor auth flow/ }).waitFor({ timeout: 30_000 });
    await expect(page.locator('[data-readiness]')).toHaveCount(0);
  });

  test('draft row: no [data-readiness] element', async ({ page }) => {
    // Draft rows derive to MergeReadiness.None (rule step 3) — the badge should not appear.
    const item = {
      ...baseItem,
      isDraft: true,
      mergeReadiness: 'none' as MergeReadiness,
    };
    await setupMocks(page, makeInboxResponse(item));
    await page.goto('/');
    await page.getByRole('button', { name: /Refactor auth flow/ }).waitFor({ timeout: 30_000 });
    await expect(page.locator('[data-readiness]')).toHaveCount(0);
  });

  test('none readiness: no [data-readiness] element', async ({ page }) => {
    const item = { ...baseItem, mergeReadiness: 'none' as MergeReadiness };
    await setupMocks(page, makeInboxResponse(item));
    await page.goto('/');
    await page.getByRole('button', { name: /Refactor auth flow/ }).waitFor({ timeout: 30_000 });
    await expect(page.locator('[data-readiness]')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// § TOOLTIP — focus opens popover with one-liner
// ---------------------------------------------------------------------------

test.describe('readiness badge — tooltip', () => {
  test('focus on conflicts badge opens tooltip popover with one-liner', async ({ page }) => {
    const item = { ...baseItem, mergeReadiness: 'conflicts' as MergeReadiness };
    await setupMocks(page, makeInboxResponse(item));
    await page.goto('/');

    const badge = page.getByRole('button', { name: 'Merge readiness: Conflicts' });
    await badge.waitFor({ timeout: 30_000 });

    // Focus the badge to trigger the popover (onFocus calls openNow immediately, no delay).
    await badge.focus();

    // The popover is portaled into document.body with role="tooltip".
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible({ timeout: 5_000 });

    // Tooltip contains the one-liner explanation from READINESS_TOOLTIP.
    await expect(tooltip).toContainText(READINESS_TOOLTIP['conflicts']);

    // Tooltip also contains the long-form reason chip.
    await expect(tooltip).toContainText('Has conflicts');

    // Escape closes the popover.
    await page.keyboard.press('Escape');
    await expect(tooltip).not.toBeVisible();
  });

  test('focus on ready-with-changes-requested tooltip shows one-liner and counts fact', async ({
    page,
  }) => {
    const item = {
      ...baseItem,
      mergeReadiness: 'ready-with-changes-requested' as MergeReadiness,
      approvals: 1,
      changesRequested: 2,
    };
    await setupMocks(page, makeInboxResponse(item));
    await page.goto('/');

    const badge = page.getByRole('button', {
      name: 'Merge readiness: Ready (changes)',
    });
    await badge.waitFor({ timeout: 30_000 });
    await badge.focus();

    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible({ timeout: 5_000 });
    await expect(tooltip).toContainText(READINESS_TOOLTIP['ready-with-changes-requested']);
    // Counts fact: "Changes requested by 2 · 1 approval"
    await expect(tooltip).toContainText('Changes requested by 2');
    await expect(tooltip).toContainText('1 approval');

    // Pixel snapshot of the open popover — CI only.
    if (process.env.CI) {
      await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
      await expectVisual(
        page.locator('[role="tooltip"]'),
        'readiness-tooltip-ready-with-changes-requested.png',
        SCREENSHOT_OPTS,
      );
    }
  });

  test('blur closes the tooltip', async ({ page }) => {
    const item = { ...baseItem, mergeReadiness: 'review-required' as MergeReadiness };
    await setupMocks(page, makeInboxResponse(item));
    await page.goto('/');

    const badge = page.getByRole('button', { name: 'Merge readiness: Review required' });
    await badge.waitFor({ timeout: 30_000 });
    await badge.focus();

    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible({ timeout: 5_000 });

    // Tab away to blur.
    await page.keyboard.press('Tab');
    await expect(tooltip).not.toBeVisible();
  });

  // aria-describedby wiring: the badge button should point to the tooltip's id when open.
  test('badge has aria-describedby pointing at open tooltip', async ({ page }) => {
    const item = { ...baseItem, mergeReadiness: 'unstable' as MergeReadiness };
    await setupMocks(page, makeInboxResponse(item));
    await page.goto('/');

    const badge = page.getByRole('button', { name: 'Merge readiness: Unstable' });
    await badge.waitFor({ timeout: 30_000 });

    // Before focus: no aria-describedby.
    await expect(badge).not.toHaveAttribute('aria-describedby');

    await badge.focus();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible({ timeout: 5_000 });

    // After focus: aria-describedby is set to the tooltip's id.
    const describedBy = await badge.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const tooltipId = await tooltip.getAttribute('id');
    expect(describedBy).toBe(tooltipId);
  });
});
