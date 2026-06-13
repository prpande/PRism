import { test, expect, type Route } from '@playwright/test';
import { setupBaseRoutes } from './helpers/base-mocks';
import { allOffCapabilities, makeDefaultPreferences } from './fixtures/preferences';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleInbox = {
  sections: [
    {
      id: 'review-requested',
      label: 'Review requested',
      items: [
        {
          reference: { owner: 'acme', repo: 'api', number: 42 },
          title: 'Refactor auth flow',
          author: 'amelia',
          repo: 'acme/api',
          updatedAt: new Date().toISOString(),
          pushedAt: new Date().toISOString(),
          commitCount: 3,
          changedFiles: 0,
          commentCount: 7,
          additions: 50,
          deletions: 10,
          headSha: 'abc',
          ci: 'none',
          lastViewedHeadSha: null,
          lastSeenCommentId: null,
        },
      ],
    },
  ],
  enrichments: {},
  lastRefreshedAt: new Date().toISOString(),
  tokenScopeFooterEnabled: true,
};

// The canonical mocked-mode preferences shape (#332). It mirrors the real
// nested GET /api/preferences wire (ui / inbox / github) so the React tree
// hydrates — a flat-shaped fixture crashes HeaderControls.applyToDocument
// (ACCENT_HUES[undefined].h throws; caught by Playwright on PR #69). The
// activity-rail test below spreads this base and overrides ui.aiPreview /
// inbox.showActivityRail.
const defaultPreferences = makeDefaultPreferences();

// ---------------------------------------------------------------------------
// Shared mock wiring
// ---------------------------------------------------------------------------

/**
 * Wires the three constant read-side routes (auth/state, capabilities, events)
 * via setupBaseRoutes, then the `/api/preferences` snapshot. Tests that need
 * custom preferences register their own `/api/preferences` handler AFTER this
 * call — Playwright matches routes in reverse registration order, so the later
 * handler shadows this one.
 */
async function setupBaseMocks(page: import('@playwright/test').Page) {
  await setupBaseRoutes(page);
  await page.route('**/api/preferences', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(defaultPreferences),
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests — ensure viewport is >= 1180px so the activity rail CSS column is active
// ---------------------------------------------------------------------------

// The activity rail hides below 1180px via CSS (InboxPage.module.css).
// Playwright's default viewport is 1280×720 which is wide enough, but we
// set it explicitly here so the suite is self-documenting.
test.use({ viewport: { width: 1280, height: 800 } });

// ---------------------------------------------------------------------------

test('inbox loads with rows after auth', async ({ page }) => {
  await setupBaseMocks(page);
  await page.route('**/api/inbox', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sampleInbox),
    }),
  );

  await page.goto('/');

  await expect(page.getByText('Review requested')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Refactor auth flow')).toBeVisible();
});

// ---------------------------------------------------------------------------

test('URL paste with valid PR URL navigates to PR detail page', async ({ page }) => {
  await setupBaseMocks(page);
  await page.route('**/api/inbox', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sampleInbox),
    }),
  );
  await page.route('**/api/inbox/parse-pr-url', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        ref: { owner: 'foo', repo: 'bar', number: 9 },
        error: null,
        configuredHost: null,
        urlHost: null,
      }),
    }),
  );
  await page.route('**/api/pr/foo/bar/9', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        pr: {
          reference: { owner: 'foo', repo: 'bar', number: 9 },
          title: 'Sample PR for navigation test',
          body: '',
          author: 'octocat',
          state: 'open',
          headSha: 'abc',
          baseSha: 'def',
          headBranch: 'feature/x',
          baseBranch: 'main',
          mergeability: 'mergeable',
          ciSummary: 'success',
          isMerged: false,
          isClosed: false,
          openedAt: new Date().toISOString(),
        },
        clusteringQuality: 'ok',
        iterations: [],
        commits: [],
        rootComments: [],
        reviewComments: [],
        timelineCapHit: false,
      }),
    }),
  );

  await page.goto('/');
  // Wait for the inbox to load before trying to interact with the toolbar.
  await expect(page.getByText('Refactor auth flow')).toBeVisible({ timeout: 30_000 });

  await page.getByPlaceholder(/paste a pr url/i).fill('https://github.com/foo/bar/pull/9');
  await page.keyboard.press('Enter');

  await expect(page.getByRole('heading', { name: /Sample PR for navigation test/i })).toBeVisible();
  await expect(page.getByText('foo/bar', { exact: true })).toBeVisible();
  await expect(page.getByTestId('pr-header').getByText('#9', { exact: true })).toBeVisible();
});

// ---------------------------------------------------------------------------

test('URL paste with host mismatch shows inline error', async ({ page }) => {
  await setupBaseMocks(page);
  await page.route('**/api/inbox', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sampleInbox),
    }),
  );
  await page.route('**/api/inbox/parse-pr-url', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        ref: null,
        error: 'host-mismatch',
        configuredHost: 'https://github.com',
        urlHost: 'ghe.acme.com',
      }),
    }),
  );

  await page.goto('/');
  await expect(page.getByText('Refactor auth flow')).toBeVisible({ timeout: 30_000 });

  await page.getByPlaceholder(/paste a pr url/i).fill('https://ghe.acme.com/foo/bar/pull/1');
  await page.keyboard.press('Enter');

  // The merged inbox input (InboxQueryInput) renders the error in a <span role="alert">.
  // The error message is: "This PR is on ghe.acme.com, but PRism is configured for https://github.com."
  await expect(page.getByRole('alert')).toContainText(/configured for https:\/\/github\.com/i);

  // No navigation occurred — URL must still be the inbox root, not /pr/...
  // (Earlier this asserted on the absence of the now-deleted S3 stub heading,
  // which was tautological and would silently miss a real navigation regression.)
  await expect(page).toHaveURL(/\/$/);
});

// ---------------------------------------------------------------------------

test('activity rail is gated by inbox.showActivityRail, independent of AI preview', async ({
  page,
}) => {
  // #283: the activity rail is a fabricated, non-AI mockup decoupled from the AI-preview
  // toggle onto inbox.showActivityRail (config-only, default false). This test proves the
  // decouple: with AI preview ON the whole time, the rail stays hidden while the flag is
  // false and only appears once the flag is flipped (simulating a config.json edit — there
  // is deliberately no Settings UI for it).
  let showActivityRail = false;

  // setupBaseRoutes wires auth/state + events (constant) + an all-off
  // capabilities; this test overrides preferences and capabilities below
  // (registered after, so LIFO route matching makes the overrides win).
  await setupBaseRoutes(page);
  await page.route('**/api/preferences', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // AI preview stays ON (the new default) the whole time, to prove the rail's
      // visibility is driven purely by inbox.showActivityRail, not by AI.
      body: JSON.stringify({
        ...defaultPreferences,
        ui: { ...defaultPreferences.ui, aiPreview: true },
        inbox: { ...defaultPreferences.inbox, showActivityRail },
      }),
    });
  });
  // AI fully on — proves the rail does NOT ride the AI gate.
  await page.route('**/api/capabilities', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ai: { ...allOffCapabilities.ai, inboxRanking: true, inboxEnrichment: true },
      }),
    }),
  );
  await page.route('**/api/inbox', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sampleInbox),
    }),
  );

  // Flag off (default) + AI on → rail NOT rendered.
  await page.goto('/');
  await expect(page.getByText('Refactor auth flow')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('complementary', { name: /activity/i })).not.toBeAttached();

  // Flip the dedicated flag on (config-edit equivalent — no UI control by design) and
  // remount: the rail now appears, with AI preview unchanged.
  showActivityRail = true;
  await page.goto('/');
  await expect(page.getByText('Refactor auth flow')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('complementary', { name: /activity/i })).toBeVisible({
    timeout: 10_000,
  });
});

// ---------------------------------------------------------------------------

test('manual Refresh button drives the loading bar and re-enables', async ({ page }) => {
  // #311: clicking the inbox Refresh button POSTs /api/inbox/refresh, which drives
  // the inbox loading bar active (button disabled during the in-flight request) and
  // then re-enables once the refresh settles. Note: the GET '**/api/inbox' route glob
  // does NOT match '/api/inbox/refresh' (no trailing wildcard), so the POST is otherwise
  // unhandled — it must be stubbed explicitly here.
  await setupBaseMocks(page);
  await page.route('**/api/inbox', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sampleInbox),
    }),
  );
  // Stub the refresh POST with a short delay so the active loading-bar / disabled-button
  // transition is observable, without an arbitrary long sleep.
  await page.route('**/api/inbox/refresh', async (route: Route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.fulfill({ status: 200, contentType: 'application/json', body: '' });
  });

  await page.goto('/');
  await expect(page.getByText('Refactor auth flow')).toBeVisible({ timeout: 30_000 });

  const refreshButton = page.getByTestId('inbox-refresh-button');
  await expect(refreshButton).toBeVisible();
  await expect(refreshButton).toBeEnabled();

  await refreshButton.click();

  // The loading bar reaches the active state while the refresh POST is in flight…
  await expect(page.getByTestId('inbox-loading-bar')).toHaveAttribute('data-active', 'true');

  // …and once the refresh settles, the button re-enables (timing-tolerant: we assert the
  // settled end-state rather than racing the loading-bar's exact off frame).
  await expect(refreshButton).toBeEnabled();
});

// ---------------------------------------------------------------------------

// NOTE: "SSE banner appears on inbox-updated event" is intentionally NOT an E2E
// test. Playwright's route mocking does not naturally support streaming SSE
// responses, and driving an event mid-test would require a fake EventSource
// injected via page.addInitScript before the SPA mounts. That behavior is covered
// by the Vitest tests in useInboxUpdates.test.tsx and the backend
// EventsEndpointsTests integration tests, so no permanently-skipped placeholder is
// kept here (#334).
