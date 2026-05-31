import { test, expect, type Route, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// ---------------------------------------------------------------------------
// Spec § 6 — Accessibility baseline audit (Pass 1: automated axe-core).
//
// One spec, many tests. Each visits a top-level surface, waits for the page
// to settle, then runs axe-core and asserts zero violations at "serious" or
// "critical" impact. "moderate" and "minor" findings are surfaced in the
// failure message when blockers exist but do not themselves block.
//
// Scope (spec § 6.1): /setup, /, /pr/{ref}, /pr/{ref}/files, /pr/{ref}/drafts,
// /settings, plus the cheatsheet-open state on any page (we use /).
//
// The PR6 prefers-reduced-motion verification is folded in here per the
// plan's "PR6 e2e or accessibility audit" deferral: the LoadingScreen
// component must suppress its pulse animation under
// `prefers-reduced-motion: reduce`.
// ---------------------------------------------------------------------------

const authedAuthState = {
  hasToken: true,
  host: 'https://github.com',
  hostMismatch: null,
};

const defaultPreferences = {
  ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable' },
  inbox: {
    sections: {
      'review-requested': true,
      'awaiting-author': true,
      'authored-by-me': true,
      mentioned: true,
      'ci-failing': true,
    },
  },
  github: {
    host: 'https://github.com',
    // Fixture-only sentinel paths — the Settings page just renders these as
    // copyable strings, axe-core doesn't care, and using a clearly synthetic
    // value avoids implying any real platform's data-dir layout.
    configPath: '<dataDir>/config.json',
    logsPath: '<dataDir>/logs',
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

// Fixed timestamps for deterministic axe-core runs — `InboxRow.formatAge()`
// uses `Date.now() - updatedAt`, so a fixed timestamp close to "now" still
// renders different strings ("just now" / "1h ago" / …) as wall-clock time
// moves, and a future timestamp produces a negative delta. Pin to a far-past
// constant so the rendered age string is stably 'older' (delta > 24h on every
// realistic run) and the accessible-name text is byte-stable across runs.
const FIXED_TS = '2024-01-01T00:00:00.000Z';

const sampleInbox = {
  sections: [
    {
      id: 'review-requested',
      label: 'Review requested',
      items: [
        {
          reference: { owner: 'octocat', repo: 'Hello-World', number: 1 },
          title: 'Sample pull request for a11y audit',
          author: 'amelia',
          repo: 'octocat/Hello-World',
          updatedAt: FIXED_TS,
          pushedAt: FIXED_TS,
          iterationNumber: 1,
          commentCount: 3,
          additions: 25,
          deletions: 4,
          headSha: 'abc',
          ci: 'none',
          lastViewedHeadSha: null,
          lastSeenCommentId: null,
        },
      ],
    },
  ],
  enrichments: {},
  lastRefreshedAt: FIXED_TS,
  tokenScopeFooterEnabled: true,
};

const samplePrDetail = {
  pr: {
    reference: { owner: 'octocat', repo: 'Hello-World', number: 1 },
    title: 'Sample pull request for a11y audit',
    body: 'A small PR used as the a11y-audit fixture.',
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
    openedAt: FIXED_TS,
  },
  clusteringQuality: 'ok',
  iterations: [],
  commits: [],
  rootComments: [],
  reviewComments: [],
  timelineCapHit: false,
};

// ReviewSessionDto-shaped fixture (matches frontend/src/api/types.ts) — the
// PrDetailPage crashes into its ErrorBoundary if the draft session response
// doesn't match this shape, which would shadow the axe-core findings we
// actually want to surface on the PR detail surfaces.
const emptyDraftSession = {
  draftVerdict: null,
  draftVerdictStatus: 'draft',
  draftSummaryMarkdown: null,
  draftComments: [],
  draftReplies: [],
  iterationOverrides: [],
  pendingReviewId: null,
  pendingReviewCommitOid: null,
  fileViewState: { viewedFiles: {} },
};

async function setupBaseMocks(p: Page): Promise<void> {
  await p.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );
  await p.route('**/api/preferences', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(defaultPreferences),
    }),
  );
  await p.route('**/api/capabilities', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(allOffCapabilities),
    }),
  );
  await p.route('**/api/events', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ':heartbeat\n\n' }),
  );
  await p.route('**/api/inbox', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sampleInbox),
    }),
  );
  // Wire shape matches PRism.Web/Endpoints/SubmitInFlightEndpoint.cs:
  //   SubmitInFlightResponse(bool InFlight, string? PrRef)
  // i.e. `{ inFlight: bool, prRef: string|null }` — singular, NOT `refs: []`.
  // Even though inFlight=false makes prRef dormant here, contract-accuracy
  // keeps the mock from masking future integration regressions.
  await p.route('**/api/submit/in-flight', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ inFlight: false, prRef: null }),
    }),
  );
  // PR detail (GET on the base ref returns the detail DTO; the same path with
  // /draft suffix returns the draft session for the Drafts tab).
  await p.route('**/api/pr/octocat/Hello-World/1', (route: Route) => {
    if (route.request().method() === 'POST' || route.request().method() === 'PUT') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(samplePrDetail),
    });
  });
  await p.route('**/api/pr/octocat/Hello-World/1/draft', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(emptyDraftSession),
    }),
  );
  await p.route('**/api/pr/octocat/Hello-World/1/mark-viewed', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  // Files tab issues a diff fetch keyed by commit range; a non-empty empty-diff
  // response keeps the tab rendering without hitting an error placeholder.
  await p.route('**/api/pr/octocat/Hello-World/1/diff**', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ files: [], truncated: false }),
    }),
  );
}

async function runAxe(p: Page): Promise<void> {
  const results = await new AxeBuilder({ page: p }).analyze();
  const blockers = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  // Gate ONLY on serious/critical, but stringify ALL violations into the
  // failure message so any co-occurring moderate/minor findings are visible
  // for diagnosis (matches the header-comment intent).
  expect(blockers, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test.use({ viewport: { width: 1280, height: 800 } });

test.describe('A11y audit — automated axe-core pass per spec § 6', () => {
  test('setup (/setup) — no serious/critical violations', async ({ page }) => {
    await setupBaseMocks(page);
    // Setup screen renders even with hasToken=true; redirect off it lands on
    // / when authed, so we mock the no-token branch for /setup specifically.
    await page.unroute('**/api/auth/state');
    await page.route('**/api/auth/state', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hasToken: false, host: 'https://github.com', hostMismatch: null }),
      }),
    );
    await page.goto('/setup');
    await expect(page.getByRole('heading', { name: /connect to github/i })).toBeVisible({
      timeout: 30_000,
    });
    await runAxe(page);
  });

  test('inbox (/) — no serious/critical violations', async ({ page }) => {
    await setupBaseMocks(page);
    await page.goto('/');
    await expect(page.getByText('Sample pull request for a11y audit')).toBeVisible({
      timeout: 30_000,
    });
    await runAxe(page);
  });

  test('PR overview (/pr/octocat/Hello-World/1) — no serious/critical violations', async ({
    page,
  }) => {
    await setupBaseMocks(page);
    await page.goto('/pr/octocat/Hello-World/1');
    await expect(
      page.getByRole('heading', { name: /sample pull request for a11y audit/i }),
    ).toBeVisible({ timeout: 30_000 });
    await runAxe(page);
  });

  test('PR files (/pr/octocat/Hello-World/1/files) — no serious/critical violations', async ({
    page,
  }) => {
    await setupBaseMocks(page);
    await page.goto('/pr/octocat/Hello-World/1/files');
    await expect(
      page.getByRole('heading', { name: /sample pull request for a11y audit/i }),
    ).toBeVisible({ timeout: 30_000 });
    await runAxe(page);
  });

  test('PR drafts (/pr/octocat/Hello-World/1/drafts) — no serious/critical violations', async ({
    page,
  }) => {
    await setupBaseMocks(page);
    await page.goto('/pr/octocat/Hello-World/1/drafts');
    await expect(
      page.getByRole('heading', { name: /sample pull request for a11y audit/i }),
    ).toBeVisible({ timeout: 30_000 });
    await runAxe(page);
  });

  test('settings (/settings) — no serious/critical violations', async ({ page }) => {
    await setupBaseMocks(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: /appearance/i, level: 2 })).toBeVisible({
      timeout: 30_000,
    });
    await runAxe(page);
  });

  test('cheatsheet open — no serious/critical violations', async ({ page }) => {
    await setupBaseMocks(page);
    await page.goto('/');
    await expect(page.getByText('Sample pull request for a11y audit')).toBeVisible({
      timeout: 30_000,
    });
    // Move focus off the URL-paste input so `?` is not typed into a text field.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeVisible();
    await runAxe(page);
  });
});

// ---------------------------------------------------------------------------
// PR6 deferral fold-in: prefers-reduced-motion suppresses LoadingScreen pulse.
//
// The LoadingScreen renders during the brief window between App mount and the
// /api/auth/state response. We delay that response indefinitely so the screen
// stays mounted long enough for the assertion. Under `reducedMotion: 'reduce'`
// the .pulseLogo CSS rule sets `animation: none` (LoadingScreen.module.css).
// ---------------------------------------------------------------------------

// Helper for routes that should hang for the test duration. Awaiting a
// never-resolving Promise makes the "request stays pending" contract explicit
// rather than relying on the implicit Playwright semantics of a sync handler
// that doesn't call fulfill/continue/abort — which is non-obvious to read and
// brittle to a future Playwright upgrade.
const HANG_FOREVER = async () => {
  await new Promise<void>(() => {
    /* never resolves; cleanup happens at page close */
  });
};

test.describe('A11y audit — LoadingScreen honors prefers-reduced-motion', () => {
  test('pulse animation is suppressed under reducedMotion: reduce', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // Hold the auth response open so the LoadingScreen stays visible. useAuth
    // stays in its pending state and App renders <LoadingScreen />.
    await page.route('**/api/auth/state', HANG_FOREVER);
    await page.goto('/');
    const loadingRegion = page.getByRole('status').first();
    await expect(loadingRegion).toBeVisible({ timeout: 5_000 });
    // Bind by CSS-modules-hashed class substring rather than sibling index, so
    // the test fails fast if the LoadingScreen reorders its <img> elements OR
    // if the 10s internal timer fires and swaps pulseLogo → logoStill before
    // the assertion runs. Either case would otherwise produce a silent
    // false-pass because logoStill also has `animation: none`.
    const pulseLogo = loadingRegion.locator('img[class*="pulseLogo"]');
    await expect(pulseLogo).toBeVisible();
    const animationName = await pulseLogo.evaluate(
      (el) => window.getComputedStyle(el).animationName,
    );
    // Under prefers-reduced-motion: reduce, the @media override sets
    // `animation: none` — getComputedStyle reports 'none' for animationName.
    expect(animationName).toBe('none');
  });
});
