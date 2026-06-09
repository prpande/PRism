import { test, expect, type Route } from '@playwright/test';

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
          iterationNumber: 3,
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

const authedAuthState = {
  hasToken: true,
  host: 'https://github.com',
  hostMismatch: null,
};

// S6 PR1: GET /api/preferences widened from flat { theme, accent, aiPreview } to
// nested { ui, inbox, github } (spec § 2.4). Playwright frontend consumers
// (HeaderControls, InboxPage, …) now read preferences.ui.theme etc., so the
// Playwright fixture must mirror the new shape or the React tree crashes when
// HeaderControls.applyToDocument(undefined, undefined) → ACCENT_HUES[undefined].h
// throws. Caught by Playwright on PR #69 (4 inbox tests failed at "Refactor auth
// flow" never rendering).
const defaultPreferences = {
  // aiPreview is a deliberate client-side override (false) for these mock-driven tests
  // even though the backend default is now true (#283); contentScale + sectionOrder are
  // always present on the real GET /api/preferences wire, so keep the fixture in contract
  // (Copilot PR #309).
  ui: {
    theme: 'system',
    accent: 'indigo',
    aiPreview: false,
    density: 'comfortable',
    contentScale: 'm',
  },
  inbox: {
    sections: {
      'review-requested': true,
      'awaiting-author': true,
      'authored-by-me': true,
      mentioned: true,
      'recently-closed': true,
    },
    defaultSort: 'updated',
    sectionOrder: 'review-requested,awaiting-author,authored-by-me,mentioned',
    showActivityRail: false, // #283 rail decoupled from AI, default off
  },
  github: {
    host: 'https://github.com',
    configPath: '/fake/config.json',
    logsPath: '/fake/logs',
  },
};

const allOffCapabilities = {
  ai: {
    summary: false,
    fileFocus: false,
    hunkAnnotations: false,
    preSubmitValidators: false,
    composerAssist: false,
    draftSuggestions: false,
    draftReconciliation: false,
    inboxEnrichment: false,
    inboxRanking: false,
  },
};

// ---------------------------------------------------------------------------
// Shared mock wiring
// ---------------------------------------------------------------------------

/**
 * Registers route mocks common to most tests:
 *   /api/auth/state  — authenticated with github.com
 *   /api/preferences — GET returns defaultPreferences (or override); POST echoes back
 *   /api/capabilities — returns allOffCapabilities (or override)
 *   /api/events      — empty SSE heartbeat (keeps the connection-open semantics happy)
 *
 * Tests that need custom preferences/capabilities behaviour should either pass
 * overrides via `opts` or register their own route handlers before calling goto.
 * Playwright matches routes in reverse registration order, so a handler registered
 * after setupBaseMocks will shadow the one registered here for the same pattern.
 */
async function setupBaseMocks(
  page: import('@playwright/test').Page,
  opts: {
    preferences?: typeof defaultPreferences;
    capabilities?: typeof allOffCapabilities;
  } = {},
) {
  await page.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );
  await page.route('**/api/preferences', (route: Route) => {
    // POST: the client sends a partial patch; echo back the resolved preferences.
    // GET: return current preferences snapshot.
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(opts.preferences ?? defaultPreferences),
    });
  });
  await page.route('**/api/capabilities', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(opts.capabilities ?? allOffCapabilities),
    }),
  );
  await page.route('**/api/events', (route: Route) =>
    // Empty SSE stream — keeps the connection-open semantics happy without injecting events.
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ':heartbeat\n\n' }),
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

  await page.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );
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
  await page.route('**/api/events', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ':heartbeat\n\n' }),
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

test.skip('SSE banner appears on inbox-updated event', () => {
  // Deferred: Playwright's route mocking does not naturally support streaming
  // SSE responses. Driving an event mid-test would require a fake EventSource
  // injected via page.addInitScript before the SPA mounts. Out of scope for
  // S2 E2E; covered by the Vitest tests in useInboxUpdates.test.tsx and the
  // backend EventsEndpointsTests integration tests.
});
