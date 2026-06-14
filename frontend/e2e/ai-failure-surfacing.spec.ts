// frontend/e2e/ai-failure-surfacing.spec.ts
//
// #484 — AI failure surfacing e2e.
//
// Two tests:
//   1. A forced-503 on file-focus makes the persistent toast appear (group
//      "AI generation failure"), shows the seam display name ("hotspots"),
//      and disappears after a successful Retry.
//   2. A failure on PR1's file-focus does NOT show while PR2 is the active
//      route — the provider only shows the toast for the active PR.
//
// Mock-only: all /api/* routes are intercepted via page.route() before
// navigation. AI mode is pre-seeded to 'live' + all-on capabilities so the
// AI hooks actually fire and the toast can appear.
//
// SSE note: the file-focus hook (useFileFocusResult) is gated on
// subscribed=true (D111). The SSE mock emits a `subscriber-assigned` frame
// so subscriberId() resolves and useActivePrUpdates can POST
// /api/events/subscriptions (mocked 204) → subscribed=true → gate opens.
//
// Visual baselines: this spec makes no toHaveScreenshot calls. The toast is
// a fixed-position element rendered by AiFailureContainer; DOM assertions are
// sufficient. Per repo convention, win32 baselines are NOT hand-authored —
// any visual baseline step is CI-only (Linux). Deviation from Task 9 plan
// sub-step "generate visual baseline" recorded here: functional assertions
// provide the same coverage for this slice; the inline-error coexistence visual
// is deferred to a follow-up.

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

// Canonical OWNER/REPO used across all AI e2e specs (ai-gating-sweep,
// ai-live-consent, ai-summary-stale-regenerate).
const OWNER = 'octo';
const REPO = 'repo';
const PR1 = 1;
const PR2 = 2;

// SSE body: subscriber-assigned so subscriberId() resolves and the
// subscribeLoop can POST /api/events/subscriptions → subscribed=true.
const SSE_SUBSCRIBER_ASSIGNED =
  'event: subscriber-assigned\ndata: {"subscriberId":"mock-sub-1"}\n\n';

function makePrDetail(prNumber: number) {
  return {
    pr: {
      reference: { owner: OWNER, repo: REPO, number: prNumber },
      title: `PR #${prNumber}`,
      body: '',
      author: 'octocat',
      state: 'open',
      headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      baseSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      headBranch: `feature/branch-${prNumber}`,
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
}

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

const emptyDraftSession = {
  draftVerdict: null,
  draftVerdictStatus: 'draft',
  draftComments: [],
  draftReplies: [],
  iterationOverrides: [],
  pendingReviewId: null,
  pendingReviewCommitOid: null,
  fileViewState: { viewedFiles: {} },
};

// ---------------------------------------------------------------------------
// Shared mock setup — wires everything except the per-PR AI endpoints, which
// each test registers before calling this (page.route first-match wins, so
// per-test routes registered before setupBaseMocks take precedence).
//
// AI mode is pre-seeded to 'live' + all-on capabilities so the AI hooks fire.
// ---------------------------------------------------------------------------

async function setupBaseMocks(page: import('@playwright/test').Page): Promise<void> {
  const prefs = makeDefaultPreferences();
  const livePrefs = { ...prefs, ui: { ...prefs.ui, aiMode: 'live' as const } };

  await page.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );

  await page.route('**/api/preferences', async (route: Route) =>
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

  // SSE: emit subscriber-assigned so subscribeLoop resolves and D111 gate
  // opens. Without this, useFileFocusResult (and other AI hooks) never fire.
  await page.route('**/api/events', (route: Route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 200 });
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: SSE_SUBSCRIBER_ASSIGNED,
    });
  });

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

  // Egress disclosure — pre-consented so no consent modal fires (we're already
  // in live mode and the test is about the failure toast, not the consent flow).
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

// Wire the standard PR-data routes (detail, draft, mark-viewed, diff) for a
// given PR number. Must be called AFTER setupBaseMocks so the per-test
// page.route calls for AI endpoints are already registered first (first-match).
async function setupPrRoutes(
  page: import('@playwright/test').Page,
  prNumber: number,
): Promise<void> {
  await page.route(`**/api/pr/${OWNER}/${REPO}/${prNumber}`, (route: Route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makePrDetail(prNumber)),
    });
  });

  await page.route(`**/api/pr/${OWNER}/${REPO}/${prNumber}/draft`, (route: Route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(emptyDraftSession),
    });
  });

  await page.route(`**/api/pr/${OWNER}/${REPO}/${prNumber}/mark-viewed`, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );

  await page.route(`**/api/pr/${OWNER}/${REPO}/${prNumber}/diff**`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sampleDiff),
    }),
  );

  // Other AI endpoints return 204 (absent/no-content) by default so they don't
  // inject additional failures. The per-test routes for file-focus take
  // precedence because they are registered before these catch-all routes.
  await page.route(`**/api/pr/${OWNER}/${REPO}/${prNumber}/ai/summary`, (route: Route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route(`**/api/pr/${OWNER}/${REPO}/${prNumber}/ai/hunk-annotations`, (route: Route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route(`**/api/pr/${OWNER}/${REPO}/${prNumber}/ai/draft-suggestions`, (route: Route) =>
    route.fulfill({ status: 204 }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.use({ viewport: { width: 1280, height: 800 } });

test('ai-failure-503: file-focus 503 surfaces toast; Retry+recovery hides it', async ({ page }) => {
  test.setTimeout(120_000);

  // Register the mutable file-focus route FIRST (first-match wins in Playwright).
  // failNext controls whether subsequent requests return 503 or the healthy body.
  let failNext = true;
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}/ai/file-focus`, (route: Route) => {
    if (failNext) {
      return route.fulfill({ status: 503 });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries: [], fallback: false }),
    });
  });

  await setupBaseMocks(page);
  await setupPrRoutes(page, PR1);

  await page.goto(`/pr/${OWNER}/${REPO}/${PR1}`);
  await page.locator('[data-testid="pr-header"]').waitFor({ timeout: 30_000 });

  // The toast must appear after the 503 response is processed.
  const toast = page.getByRole('group', { name: 'AI generation failure' });
  await expect(toast).toBeVisible({ timeout: 20_000 });

  // The toast must name the failed seam using its display name ("hotspots" for
  // file-focus, as mapped in AiFailureToast.tsx's DISPLAY_NAME table).
  await expect(toast).toContainText('hotspots');

  // Flip the route to healthy BEFORE clicking Retry so the retry fetch succeeds.
  failNext = false;

  // Retry button: enabled (not in-flight state).
  const retryBtn = toast.getByRole('button', { name: 'Retry' });
  await expect(retryBtn).toBeEnabled();
  await retryBtn.click();

  // After a successful retry the hook calls clear() → the provider removes the
  // seam → the container hides the toast.
  await expect(toast).toBeHidden({ timeout: 20_000 });
});

test("ai-failure-active-pr-only: PR1 failure invisible while PR2 is active", async ({ page }) => {
  test.setTimeout(120_000);

  // PR1 file-focus always 503 (permanently failing for this test).
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}/ai/file-focus`, (route: Route) =>
    route.fulfill({ status: 503 }),
  );

  // PR2 file-focus always healthy.
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR2}/ai/file-focus`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries: [], fallback: false }),
    }),
  );

  await setupBaseMocks(page);
  await setupPrRoutes(page, PR1);
  await setupPrRoutes(page, PR2);

  const toast = page.getByRole('group', { name: 'AI generation failure' });

  // Navigate to PR1 — failure fires, toast appears.
  await page.goto(`/pr/${OWNER}/${REPO}/${PR1}`);
  await page.locator('[data-testid="pr-header"]').waitFor({ timeout: 30_000 });
  await expect(toast).toBeVisible({ timeout: 20_000 });

  // Navigate to PR2 — PR1 stays keep-alive mounted (backgrounded), but the
  // provider's active key is now PR2 whose file-focus is healthy → no toast.
  //
  // NOTE: page.goto causes a full SPA navigation (react-router URL change).
  // PR1's PrDetailView is hidden (keep-alive) but still mounted, so its
  // failure entry stays recorded in the provider. The provider renders ONLY
  // the active PR's failures, so the toast must be hidden for PR2.
  await page.goto(`/pr/${OWNER}/${REPO}/${PR2}`);
  await page.locator('[data-testid="pr-header"]').waitFor({ timeout: 30_000 });
  await expect(toast).toBeHidden({ timeout: 10_000 });

  // Navigate back to PR1 — it becomes active again; provider re-shows its failure.
  await page.goto(`/pr/${OWNER}/${REPO}/${PR1}`);
  await page.locator('[data-testid="pr-header"]').waitFor({ timeout: 30_000 });
  await expect(toast).toBeVisible({ timeout: 20_000 });
});
