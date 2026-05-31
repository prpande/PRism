// frontend/e2e/ai-gating-sweep.spec.ts
//
// PR9b-ai-gating § 5.5. Single spec covering the off → on → off flow with
// all five AI-surface classes + InboxPage activity rail.
//
// This is a mock-only spec — no real backend required. All routes are
// intercepted via page.route() before navigation so there is no race
// between the mock registration and any in-flight fetch.
//
// Two stateful variables mirror the real backend's coupled toggle behaviour:
//   aiPreview    — tracks preferences.ui.aiPreview (toggled via POST /api/preferences)
//   capsOn       — tracks /api/capabilities (coupled to aiPreview on the wire per D112)
// Both flip together when the toggle POST fires, which is what
// useAiGate(key) = capabilities[key] && preferences.ui.aiPreview requires.

import { test, expect, type Route } from '@playwright/test';
import { authedAuthState, makeDefaultPreferences } from './fixtures/preferences';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

// A draft session with ONE stale comment at src/Calc.cs:3 — the anchor
// that matches the draft-suggestions mock (filePath=src/Calc.cs, lineNumber=3)
// so the AI suggestion banner renders inside StaleDraftRow.
const staleDraftSession = {
  draftVerdict: null,
  draftVerdictStatus: 'draft',
  draftSummaryMarkdown: null,
  draftComments: [
    {
      id: 'draft-1',
      filePath: 'src/Calc.cs',
      lineNumber: 3,
      side: 'right',
      anchoredSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      anchoredLineContent: '  public static int Add(int a, int b) => a + b;',
      bodyMarkdown: 'is this intentional?',
      status: 'stale',
      isOverriddenStale: false,
    },
  ],
  draftReplies: [],
  iterationOverrides: [],
  pendingReviewId: null,
  pendingReviewCommitOid: null,
  fileViewState: { viewedFiles: {} },
};

// A minimal diff for src/Calc.cs with one hunk so DiffPane renders content
// (it falls back to "Empty file — no changes" when hunks is empty, which
// would prevent the hunk-annotation elements from mounting).
const sampleDiff = {
  range: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb..aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  files: [
    {
      path: 'src/Calc.cs',
      status: 'modified',
      hunks: [
        {
          oldStart: 1,
          oldLines: 4,
          newStart: 1,
          newLines: 4,
          body: '@@ -1,4 +1,4 @@\n namespace Acme;\n public static class Calc {\n-  public static int Add(int x, int y) => x + y;\n+  public static int Add(int a, int b) => a + b;\n }\n',
        },
      ],
    },
    // Needed so FileTree renders a row at level "medium" (matching file-focus
    // mock entry { path: 'src/Calc.Tests.cs', level: 'medium' }). FileTree only
    // renders rows for files in the diff — the AI focus dot is invisible if the
    // file isn't in the diff.
    {
      path: 'src/Calc.Tests.cs',
      status: 'modified',
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 4,
          body: '@@ -1,3 +1,4 @@\n namespace Acme.Tests;\n public class CalcTests {\n   // existing test\n+  // new test\n }\n',
        },
      ],
    },
  ],
  truncated: false,
};

const sampleInbox = {
  sections: [
    {
      id: 'review-requested',
      label: 'Review requested',
      items: [
        {
          reference: { owner: OWNER, repo: REPO, number: PR_NUMBER },
          title: 'Refactor Calc utilities',
          author: 'octocat',
          repo: `${OWNER}/${REPO}`,
          updatedAt: new Date().toISOString(),
          pushedAt: new Date().toISOString(),
          iterationNumber: 1,
          commentCount: 0,
          additions: 1,
          deletions: 1,
          headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          ci: 'none',
          lastViewedHeadSha: null,
          lastSeenCommentId: null,
        },
      ],
    },
  ],
  enrichments: {},
  lastRefreshedAt: new Date().toISOString(),
  tokenScopeFooterEnabled: false,
};

// ---------------------------------------------------------------------------
// Mock setup helper — stateful so toggle POST mutates aiPreview + capsOn
// ---------------------------------------------------------------------------

async function setupMocks(page: import('@playwright/test').Page): Promise<{
  getAiPreview: () => boolean;
  setAiPreview: (v: boolean) => void;
}> {
  let aiPreview = false;

  await page.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );

  await page.route('**/api/preferences', async (route: Route) => {
    if (route.request().method() === 'POST') {
      const raw = route.request().postData() ?? '{}';
      const body = JSON.parse(raw) as { aiPreview?: boolean };
      if (typeof body.aiPreview === 'boolean') {
        aiPreview = body.aiPreview;
      }
    }
    const prefs = makeDefaultPreferences();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...prefs,
        ui: { ...prefs.ui, aiPreview },
      }),
    });
  });

  // Capabilities are coupled to aiPreview on the wire (D112 / useAiGate.ts
  // comment). Mock the flip so useAiGate(key) = caps[key] && aiPreview works.
  await page.route('**/api/capabilities', (route: Route) => {
    const caps = aiPreview ? allOnCapabilities : allOffCapabilities;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(caps),
    });
  });

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

  await page.route('**/api/submit/in-flight', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ inFlight: false, prRef: null }),
    }),
  );

  // PR detail — handle GET, PUT/POST (draft mutations, mark-viewed) uniformly.
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

  // Draft session — always return the stale-draft fixture so the
  // UnresolvedPanel mounts on the Drafts tab in both off and on states.
  // AI suggestion only renders when gate is on (useAiGate('draftSuggestions')).
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/draft`, (route: Route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(staleDraftSession),
    });
  });

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/mark-viewed`, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );

  // Diff — use wildcard to match the ?range= or ?commits= query param.
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/diff**`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sampleDiff),
    }),
  );

  // AI endpoints — registered unconditionally; the hooks only fetch when
  // their gate is on, so these are no-ops in the off state.
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/summary`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ body: 'Refactor of Calc utilities.', category: 'Refactor' }),
    }),
  );

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/file-focus`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { path: 'src/Calc.cs', level: 'high' },
        { path: 'src/Calc.Tests.cs', level: 'medium' },
      ]),
    }),
  );

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/hunk-annotations`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { path: 'src/Calc.cs', hunkIndex: 0, body: 'Reads cleaner.', tone: 'calm' },
        { path: 'src/Calc.cs', hunkIndex: 0, body: 'Behavior shift.', tone: 'heads-up' },
        { path: 'src/Calc.cs', hunkIndex: 0, body: 'Possible regression.', tone: 'concern' },
      ]),
    }),
  );

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/draft-suggestions`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      // Anchor matches the stale-draft fixture: src/Calc.cs:3.
      body: JSON.stringify([
        { filePath: 'src/Calc.cs', lineNumber: 3, body: 'Worth a comment here?' },
      ]),
    }),
  );

  return {
    getAiPreview: () => aiPreview,
    setAiPreview: (v: boolean) => {
      aiPreview = v;
    },
  };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test.use({ viewport: { width: 1280, height: 800 } });

test('ai-gating-sweep: off → on → off shows/hides AI surfaces', async ({ page }) => {
  test.setTimeout(120_000);

  await setupMocks(page);

  // ─── STEP 1: OFF state — PR overview ──────────────────────────────────────

  // The Overview tab is the index route — no "/overview" suffix in the
  // router (App.tsx: <Route index element={<OverviewTab />} />). The
  // "/overview" suffix would hit the wildcard catch-all and redirect to "/".
  await page.goto(`/pr/${OWNER}/${REPO}/${PR_NUMBER}`);
  // Wait for the PR header to confirm the page is hydrated.
  await page.locator('[data-testid="pr-header"]').waitFor({ timeout: 30_000 });

  // AiSummaryCard must NOT be visible (gate is off).
  await expect(page.getByTestId('ai-summary-card')).not.toBeVisible();

  // AskAiButton must NOT be visible (gate is off).
  await expect(page.getByRole('button', { name: 'Ask AI' })).not.toBeVisible();

  // Inbox: no activity rail in single-column grid.
  await page.goto('/');
  await expect(page.getByText('Refactor Calc utilities')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('complementary', { name: /activity/i })).not.toBeAttached();

  // ─── STEP 2: Toggle ON ────────────────────────────────────────────────────

  await page.goto(`/pr/${OWNER}/${REPO}/${PR_NUMBER}`);
  await page.locator('[data-testid="pr-header"]').waitFor({ timeout: 30_000 });

  // The toggle button: AiPreviewToggle renders aria-label="AI preview off|on".
  const aiToggle = page.getByRole('button', { name: /AI preview/i });
  const toggleResponse = page.waitForResponse(
    (r) => r.url().includes('/api/preferences') && r.request().method() === 'POST',
  );
  await aiToggle.click();
  await toggleResponse;

  // useCapabilities subscribes to 'focus' — dispatch it so the capabilities
  // hook re-fetches and sees allOnCapabilities (now that aiPreview=true in the
  // mock closure). Without this, useAiGate(key) = caps[key] && aiPreview stays
  // false even though aiPreview flipped because caps[key] is still the stale
  // all-off value from the initial mount fetch.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  // ─── STEP 3: ON state ─────────────────────────────────────────────────────

  // (a) AiSummaryCard on Overview tab.
  await expect(page.getByTestId('ai-summary-card')).toBeVisible({ timeout: 10_000 });

  // (b) AskAiButton visible in header.
  await expect(page.getByRole('button', { name: 'Ask AI' })).toBeVisible({ timeout: 10_000 });

  // (c) Navigate to Files tab — FileTree dots + DiffPane annotations.
  await page.getByRole('tab', { name: /Files/i }).click();

  // FileTree AI focus dots — CSS module classes contain "fileTreeAiHigh"/"fileTreeAiMed".
  await expect(page.locator('[class*="fileTreeAiHigh"]').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[class*="fileTreeAiMed"]').first()).toBeVisible({ timeout: 10_000 });

  // Click the file to load its diff and render hunk annotations.
  await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();

  // All three tone annotations must render in DiffPane.
  await expect(page.getByTestId('ai-hunk-annotation').first()).toBeVisible({ timeout: 10_000 });
  expect(await page.getByTestId('ai-hunk-annotation').count()).toBe(3);

  // TONE_CHIP labels — calm="Note" / heads-up="Behavior change" / concern="Concern".
  await expect(page.locator('.chip-info', { hasText: 'Note' })).toBeVisible();
  await expect(page.locator('.chip-warning', { hasText: 'Behavior change' })).toBeVisible();
  await expect(page.locator('.chip-danger', { hasText: 'Concern' })).toBeVisible();

  // (d) Drafts tab — stale-draft AI suggestion.
  await page.getByRole('tab', { name: /Drafts/i }).click();
  await expect(page.getByTestId('stale-draft-ai-suggestion')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('AI suggestion')).toBeVisible();
  await expect(page.getByText('Worth a comment here?')).toBeVisible();

  // (e) Inbox activity rail — usePreferences + useCapabilities both subscribe
  // to the 'focus' event. Dispatch it so InboxPage re-fetches and sees aiPreview=true
  // and inboxRanking=true from the now-mutated mock state.
  await page.goto('/');
  await expect(page.getByText('Refactor Calc utilities')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('complementary', { name: /activity/i })).toBeVisible({
    timeout: 10_000,
  });

  // ─── STEP 4: Toggle OFF ───────────────────────────────────────────────────

  await page.goto(`/pr/${OWNER}/${REPO}/${PR_NUMBER}`);
  await page.locator('[data-testid="pr-header"]').waitFor({ timeout: 30_000 });

  const offResponse = page.waitForResponse(
    (r) => r.url().includes('/api/preferences') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /AI preview/i }).click();
  await offResponse;

  // Dispatch focus so useCapabilities refetches allOffCapabilities (aiPreview is
  // now false in the mock closure → allOffCapabilities returned → gate collapses).
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  // AiSummaryCard must disappear.
  await expect(page.getByTestId('ai-summary-card')).not.toBeVisible({ timeout: 10_000 });

  // AskAiButton must disappear.
  await expect(page.getByRole('button', { name: 'Ask AI' })).not.toBeVisible();
});
