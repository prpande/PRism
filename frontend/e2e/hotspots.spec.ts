// frontend/e2e/hotspots.spec.ts
//
// Task 13 (#408) — functional e2e for the file-focus → Hotspots tab → deep-link
// to the file diff flow.
//
// Flow:
//   1. Seed Live mode + all-on capabilities + provider consent already given,
//      and navigate directly to the PR detail.
//   2. The SSE mock emits a `subscriber-assigned` frame so the subscribe loop
//      POSTs /api/events/subscriptions → 204 → setSubscribed(true). That unlocks
//      the Live file-focus GET (D111: the Live fetch is subscribe-gated).
//   3. Stub the `/ai/file-focus` GET to return a real FileFocusResult envelope
//      ({ entries: [{ path, level, rationale }], fallback: false }) carrying one
//      High file and one Medium file. A real LLM never runs in e2e — the point
//      is the integrated FE flow (tab → row → Files diff), not the ranker.
//   4. Open the Hotspots tab; assert the flagged rows are listed.
//   5. Click the High row; assert the Files tab becomes active (aria-selected)
//      and that file's tree row is selected (data-selected="true").
//
// Mirrors ai-summary-stale-regenerate.spec.ts precisely: import { test, expect }
// from '@playwright/test', reuse the shared preferences fixtures, intercept every
// /api/* route via page.route() before navigation. No real backend request
// leaves the browser, and no real LLM is invoked.
//
// Purely functional (DOM assertions only — zero toHaveScreenshot calls). No new
// win32 visual baselines (spec §12).

import { test, expect, type Route } from '@playwright/test';
import { authedAuthState, makeDefaultPreferences } from './fixtures/preferences';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const allOnCapabilities = {
  ai: {
    summary: true,
    fileFocus: true,
    hunkAnnotations: true,
    preSubmitValidators: true,
    composerAssist: true,
    draftSuggestions: true,
    draftReconciliation: true,
    inboxEnrichment: true,
    inboxRanking: true,
  },
};

const OWNER = 'octo';
const REPO = 'repo';
const PR_NUMBER = 1;

// The two files carried by the diff. HIGH_FILE is the flagged file we deep-link
// into; OTHER_FILE is an unflagged sibling that must NOT be the landing target.
const HIGH_FILE = 'src/Calc.cs';
const MEDIUM_FILE = 'src/Helper.cs';
const OTHER_FILE = 'src/Untouched.cs';

const samplePrDetail = {
  pr: {
    reference: { owner: OWNER, repo: REPO, number: PR_NUMBER },
    title: 'Refactor Calc utilities',
    body: 'Clean up Calc.cs helpers.',
    author: 'octocat',
    state: 'open',
    headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    baseSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    headBranch: 'feature/calc-refactor',
    baseBranch: 'main',
    mergeability: 'mergeable',
    ciSummary: 'success',
    isMerged: false,
    isClosed: false,
    openedAt: '2026-05-01T00:00:00.000Z',
  },
  clusteringQuality: 'ok',
  iterations: [],
  commits: [],
  rootComments: [],
  reviewComments: [],
  timelineCapHit: false,
};

function modifiedFile(path: string) {
  return {
    path,
    status: 'modified',
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        body: '@@ -1 +1 @@\n-old\n+new\n',
      },
    ],
  };
}

// The diff carries all three files so the Files tree renders a row per file and
// the deep-link can select the flagged one.
const sampleDiff = {
  range: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb..aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  files: [modifiedFile(HIGH_FILE), modifiedFile(MEDIUM_FILE), modifiedFile(OTHER_FILE)],
  truncated: false,
};

// Real FileFocusResult envelope: one High + one Medium flagged file, fallback
// false (so the Hotspots tab renders the rows rather than the fallback message).
const fileFocusResult = {
  entries: [
    { path: HIGH_FILE, level: 'high', rationale: 'Core billing math changed here.' },
    { path: MEDIUM_FILE, level: 'medium', rationale: 'Touches a shared helper.' },
    { path: OTHER_FILE, level: 'low', rationale: 'Whitespace-only.' },
  ],
  fallback: false,
};

const draftSession = {
  draftVerdict: null,
  draftVerdictStatus: 'draft',
  draftComments: [],
  draftReplies: [],
  iterationOverrides: [],
  pendingReviewId: null,
  pendingReviewCommitOid: null,
  fileViewState: { viewedFiles: {} },
};

// SSE body: a `subscriber-assigned` frame so subscriberId() resolves and the
// subscribeLoop POSTs /api/events/subscriptions → 204 → setSubscribed(true),
// which unlocks the Live file-focus GET (D111). No pr-updated frame is needed
// here — this spec is about the focus → tab → diff flow, not staleness.
const SSE_BODY = 'event: subscriber-assigned\ndata: {"subscriberId":"mock-sub-1"}\n\n';

// Escape a path for use inside a RegExp (paths carry `.` and `/`).
function pathPattern(path: string): RegExp {
  return new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

async function setupMocks(page: import('@playwright/test').Page): Promise<void> {
  // Preferences start in live mode — consent is pre-given (egress-disclosure
  // alreadyConsented: true below), so no consent modal fires.
  const prefs = makeDefaultPreferences();
  const livePrefs = { ...prefs, ui: { ...prefs.ui, aiMode: 'live' as const } };

  await page.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );

  await page.route('**/api/preferences', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(livePrefs),
    }),
  );

  await page.route('**/api/capabilities', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(allOnCapabilities),
    }),
  );

  // SSE stream: subscriber-assigned so the subscribe loop can POST.
  await page.route('**/api/events', (route: Route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 200 });
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: SSE_BODY,
    });
  });

  // Subscription POST: 204 → setSubscribed(true) → unlocks the Live file-focus GET.
  await page.route('**/api/events/subscriptions**', (route: Route) =>
    route.fulfill({ status: 204 }),
  );

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

  await page.route('**/api/submit/in-flight', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ inFlight: false, prRef: null }),
    }),
  );

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}`, (route: Route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(samplePrDetail),
    });
  });

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/draft`, (route: Route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(draftSession),
    });
  });

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/mark-viewed`, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/diff**`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sampleDiff),
    }),
  );

  // Summary GET — real body so the summary card doesn't error (not under test here).
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/summary`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ body: 'Dependency injection refactor.', category: 'refactor' }),
    }),
  );

  // The spec's subject: the file-focus GET returns a real FileFocusResult envelope.
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/file-focus`, (route: Route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(fileFocusResult),
    });
  });

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/hunk-annotations`, (route: Route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/draft-suggestions`, (route: Route) =>
    route.fulfill({ status: 204 }),
  );

  // Egress disclosure (pre-consented — alreadyConsented: true so no modal fires).
  await page.route('**/api/ai/egress-disclosure', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        recipient: 'Anthropic, via the Claude Code CLI',
        dataCategories: ['Pull request diff', 'Title', 'Description'],
        disclosureVersion: '1',
        alreadyConsented: true,
      }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.use({ viewport: { width: 1280, height: 800 } });

test('hotspots: tab lists flagged files and deep-links to the diff', async ({ page }) => {
  test.setTimeout(120_000);

  await setupMocks(page);

  // Navigate directly to the PR detail with live mode pre-seeded.
  await page.goto(`/pr/${OWNER}/${REPO}/${PR_NUMBER}`);
  await page.locator('[data-testid="pr-header"]').waitFor({ timeout: 30_000 });

  // ── Step 1: open the Hotspots tab ──────────────────────────────────────────

  // The Hotspots tab is rendered only when the fileFocus capability is on
  // (Live + all-on caps here). It is subscribe-gated, so wait for it to appear.
  const hotspotsTab = page.getByTestId('pr-tab-hotspots');
  await expect(hotspotsTab).toBeVisible({ timeout: 20_000 });
  await hotspotsTab.click();

  // ── Step 2: the flagged files are listed ───────────────────────────────────

  // Rows are <button>s whose accessible name includes the file path + rationale.
  const highRow = page.getByRole('button', { name: pathPattern(HIGH_FILE) });
  const mediumRow = page.getByRole('button', { name: pathPattern(MEDIUM_FILE) });
  await expect(highRow).toBeVisible({ timeout: 10_000 });
  await expect(mediumRow).toBeVisible();

  // The Low file is filtered out of the triage surface (High→Medium only).
  await expect(page.getByRole('button', { name: pathPattern(OTHER_FILE) })).toHaveCount(0);

  // ── Step 3: click the High row → Files tab active, that file's diff selected ─

  await highRow.click();

  // The Files tab becomes the active tab.
  await expect(page.getByTestId('pr-tab-files')).toHaveAttribute('aria-selected', 'true', {
    timeout: 10_000,
  });

  // The flagged file's tree row is selected (deep-link landed on the right file).
  // The row carries data-testid="files-tab-tree-row", data-selected and data-path
  // all on the same element (FileTree.tsx), so select it directly by data-path.
  const targetTreeRow = page.locator(
    `[data-testid="files-tab-tree-row"][data-path="${HIGH_FILE}"]`,
  );
  await expect(targetTreeRow).toHaveAttribute('data-selected', 'true', { timeout: 10_000 });
});
