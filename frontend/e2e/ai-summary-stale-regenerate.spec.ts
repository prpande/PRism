// frontend/e2e/ai-summary-stale-regenerate.spec.ts
//
// Task 17 (#374) — functional e2e for the base-change → "Out of date" chip →
// Regenerate flow.
//
// Flow:
//   1. Seed Live mode + all-on capabilities + provider consent already given.
//      Navigate directly to the PR detail.
//   2. The SSE mock emits both a `subscriber-assigned` frame AND an immediate
//      `pr-updated` frame (baseShaChanged: true) in the same response body so
//      that by the time useAiSummary's GET fires (after subscribed=true) the
//      baseShaChanged latch is already true and the freshly-fetched summary is
//      marked stale.
//   3. Assert:
//        (a) ai-summary-card is visible with the initial summary body
//        (b) the "Out of date" chip (data-testid="ai-summary-stale-chip") is visible
//        (c) the Regenerate button (aria-label="Regenerate summary") is visible
//   4. Stub the regenerate POST to return a fresh summary; click Regenerate.
//   5. Assert the fresh summary body renders and the stale chip is gone.
//
// Purely functional (DOM assertions only — zero toHaveScreenshot calls). This
// deliberately deviates from the Task 17 visual-baseline sub-step: the sibling
// AI e2e specs (ai-live-consent, ai-gating-sweep) are functional-only, and
// pixel baselines for a status chip are low value given the win32/linux
// rendering delta. Deviation recorded here per plan deviation policy.
//
// Mock-only: all /api/* routes are intercepted via page.route() before
// navigation. No real backend request leaves the browser.

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
  ],
  truncated: false,
};

const staleDraftSession = {
  draftVerdict: null,
  draftVerdictStatus: 'draft',
  draftComments: [],
  draftReplies: [],
  iterationOverrides: [],
  pendingReviewId: null,
  pendingReviewCommitOid: null,
  fileViewState: { viewedFiles: {} },
};

// The prRef string used by useActivePrUpdates as the filter key.
// Must match `${owner}/${repo}/${number}` exactly (useActivePrUpdates.ts:32).
const PR_REF_STR = `${OWNER}/${REPO}/${PR_NUMBER}`;

// SSE body: `subscriber-assigned` frame so subscriberId() resolves and the
// subscribeLoop can POST /api/events/subscriptions, followed immediately by a
// `pr-updated` frame carrying baseShaChanged: true for our PR. Both frames
// arrive in the same response body so the baseShaChanged latch is true before
// useAiSummary's GET fires (which is gated on subscribed=true).
const SSE_BODY =
  'event: subscriber-assigned\ndata: {"subscriberId":"mock-sub-1"}\n\n' +
  `event: pr-updated\ndata: ${JSON.stringify({
    prRef: PR_REF_STR,
    headShaChanged: false,
    baseShaChanged: true,
    newBaseSha: 'cccccccccccccccccccccccccccccccccccccccc',
    commentCountDelta: 0,
    isMerged: false,
    isClosed: false,
  })}\n\n`;

const INITIAL_SUMMARY_BODY = 'Dependency injection refactor.';
const FRESH_SUMMARY_BODY = 'Summary after base-change regeneration.';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

async function setupMocks(page: import('@playwright/test').Page): Promise<{
  setRegenerateResponse: (kind: 'ok' | 'error') => void;
}> {
  // Preferences start in live mode — consent is pre-given. No consent-flow
  // dance needed in this spec; we test the stale→regenerate path directly.
  const prefs = makeDefaultPreferences();
  const livePrefs = { ...prefs, ui: { ...prefs.ui, aiMode: 'live' as const } };

  await page.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );

  await page.route('**/api/preferences', async (route: Route) => {
    // Serve live-mode preferences on both GET and POST (POST is idempotent in
    // this spec — we don't change the mode).
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(livePrefs),
    });
  });

  await page.route('**/api/capabilities', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(allOnCapabilities),
    }),
  );

  // SSE stream: subscriber-assigned + immediate pr-updated (baseShaChanged).
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

  // Subscription POST: 204 → setSubscribed(true) → unlocks useAiSummary.
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
      body: JSON.stringify(staleDraftSession),
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

  // Initial AI summary GET — returns a real body (live mode + all-on caps).
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/summary`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ body: INITIAL_SUMMARY_BODY, category: 'fix' }),
    }),
  );

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/file-focus`, (route: Route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/hunk-annotations`, (route: Route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route(
    `**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/draft-suggestions`,
    (route: Route) => route.fulfill({ status: 204 }),
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

  // Regenerate POST — mutable; test controls the response via setRegenerateResponse.
  let regenerateKind: 'ok' | 'error' = 'ok';
  await page.route(
    `**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/summary/regenerate`,
    (route: Route) => {
      if (regenerateKind === 'ok') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ body: FRESH_SUMMARY_BODY, category: 'refactor' }),
        });
      }
      return route.fulfill({ status: 503 });
    },
  );

  return {
    setRegenerateResponse: (kind: 'ok' | 'error') => {
      regenerateKind = kind;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.use({ viewport: { width: 1280, height: 800 } });

test('ai-summary-stale-regenerate: base-change marks summary stale and Regenerate refreshes it', async ({
  page,
}) => {
  test.setTimeout(120_000);

  await setupMocks(page);

  // Navigate directly to the PR detail with live mode pre-seeded.
  await page.goto(`/pr/${OWNER}/${REPO}/${PR_NUMBER}`);
  await page.locator('[data-testid="pr-header"]').waitFor({ timeout: 30_000 });

  // ── Step 1: initial summary visible ────────────────────────────────────────

  // The ai-summary-card must appear (live mode + all-on caps + subscribed).
  const summaryCard = page.getByTestId('ai-summary-card');
  await expect(summaryCard).toBeVisible({ timeout: 20_000 });

  // The initial summary body must be present.
  await expect(page.getByText(INITIAL_SUMMARY_BODY)).toBeVisible({ timeout: 10_000 });

  // ── Step 2: stale chip and Regenerate button appear ─────────────────────────

  // The SSE pr-updated frame (baseShaChanged: true) was delivered alongside the
  // subscriber-assigned frame, so the baseShaChanged latch is already true when
  // the summary GET completes. isStale = baseShaChanged && !staleCleared = true.
  // In live mode, AiSummaryCard renders the chip + button when showStale=true.

  const staleChip = page.getByTestId('ai-summary-stale-chip');
  await expect(staleChip).toBeVisible({ timeout: 10_000 });
  await expect(staleChip).toHaveText(/out of date/i);

  const regenerateBtn = page.getByRole('button', { name: /regenerate summary/i });
  await expect(regenerateBtn).toBeVisible({ timeout: 5_000 });
  await expect(regenerateBtn).not.toBeDisabled();

  // The old summary body must still be visible (retained body during stale state).
  await expect(page.getByText(INITIAL_SUMMARY_BODY)).toBeVisible();

  // ── Step 3: click Regenerate → fresh summary, chip cleared ─────────────────

  // Wait for the regenerate POST to settle before asserting the fresh body.
  const regeneratePostPromise = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/summary/regenerate`) &&
      r.request().method() === 'POST',
    { timeout: 30_000 },
  );

  await regenerateBtn.click();

  await regeneratePostPromise;

  // Fresh summary body must appear.
  await expect(page.getByText(FRESH_SUMMARY_BODY)).toBeVisible({ timeout: 10_000 });

  // The stale chip must be gone (staleCleared=true after a successful regenerate).
  await expect(staleChip).not.toBeVisible({ timeout: 5_000 });

  // The summary card itself stays visible (it now shows the fresh body).
  await expect(summaryCard).toBeVisible();
});
