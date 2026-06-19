// frontend/e2e/ai-live-consent.spec.ts
//
// P1 First-Light § consent flow. Two tests covering the EgressConsentModal
// that gates the Live AI mode:
//
//   1. Happy path: click Live → modal appears → Accept → consent POST fires →
//      preferences POST flips aiMode to 'live' → navigate to PR detail →
//      ai-summary-card is visible.
//
//   2. Decline: click Live → modal appears → Decline → modal closes, aiMode
//      stays as-is (no 'live' preferences POST), summary card not present.
//
// Mock-only: all /api/* routes are intercepted via page.route() before
// navigation so there is no race between mock registration and in-flight
// fetches.
//
// SSE subscription note (D111 gate):
//   The ai-summary-card only fetches after the SSE subscription establishes
//   (useActivePrUpdates subscribe POST settles → subscribed=true → gated
//   useAiSummary fires). The /api/events mock therefore emits a real
//   `subscriber-assigned` SSE frame so subscriberId() resolves, and
//   /api/events/subscriptions (POST) is mocked 204 so the subscribeLoop
//   flips subscribed=true.

import { test, expect, type Route } from '@playwright/test';
import { authedAuthState, makeDefaultPreferences } from './fixtures/preferences';

// ---------------------------------------------------------------------------
// Fixtures (mirror ai-gating-sweep exactly so mock shapes stay in sync)
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

// The SSE body emits a `subscriber-assigned` frame so subscriberId() resolves
// immediately. useActivePrUpdates then POSTs /api/events/subscriptions (mocked
// 204 below) and flips subscribed=true — which is the D111 gate that allows
// useAiSummary to fire.
const SSE_SUBSCRIBER_ASSIGNED =
  'event: subscriber-assigned\ndata: {"subscriberId":"mock-sub-1"}\n\n';

// ---------------------------------------------------------------------------
// Mock setup helper
// ---------------------------------------------------------------------------

async function setupMocks(page: import('@playwright/test').Page): Promise<{
  getAiMode: () => 'off' | 'preview' | 'live';
  setAiMode: (v: 'off' | 'preview' | 'live') => void;
  getConsentPostCount: () => number;
  getModePostValues: () => string[];
}> {
  let aiMode: 'off' | 'preview' | 'live' = 'off';
  let consentPostCount = 0;
  const modePostValues: string[] = [];

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
      const body = JSON.parse(raw) as { 'ui.ai.mode'?: string };
      if (typeof body['ui.ai.mode'] === 'string') {
        const next = body['ui.ai.mode'] as 'off' | 'preview' | 'live';
        aiMode = next;
        modePostValues.push(next);
      }
    }
    const prefs = makeDefaultPreferences();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...prefs,
        ui: { ...prefs.ui, aiMode },
      }),
    });
  });

  await page.route('**/api/capabilities', (route: Route) => {
    const caps = aiMode !== 'off' ? allOnCapabilities : allOffCapabilities;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(caps),
    });
  });

  // Emit subscriber-assigned so subscriberId() resolves and the subscribeLoop
  // can POST /api/events/subscriptions. Without this frame, subscribed stays
  // false and useAiSummary never fires (D111 gate).
  await page.route('**/api/events', (route: Route) => {
    if (route.request().method() === 'POST') {
      // /api/events/ping or similar POST — 200 OK
      return route.fulfill({ status: 200 });
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: SSE_SUBSCRIBER_ASSIGNED,
    });
  });

  // Subscription POST: useActivePrUpdates calls this after subscriberId()
  // resolves. 204 → setSubscribed(true) → unlocks useAiSummary.
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

  // AI summary — returns a deterministic body only when aiMode === 'live'.
  // The 204 branch (absent) maps to useAiSummary's 'absent' path → card hidden.
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/summary`, (route: Route) => {
    if (aiMode === 'live') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ body: 'Dependency injection refactor.', category: 'fix' }),
      });
    }
    // off or preview → no summary
    return route.fulfill({ status: 204 });
  });

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/file-focus`, (route: Route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/hunk-annotations`, (route: Route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/draft-suggestions`, (route: Route) =>
    route.fulfill({ status: 204 }),
  );

  // Egress disclosure
  await page.route('**/api/ai/egress-disclosure', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        recipient: 'Anthropic, via the Claude Code CLI',
        dataCategories: ['Pull request diff', 'Title', 'Description'],
        disclosureVersion: '1',
        alreadyConsented: false,
      }),
    }),
  );

  // Consent POST
  await page.route('**/api/ai/consent', (route: Route) => {
    if (route.request().method() === 'POST') {
      consentPostCount++;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404 });
  });

  return {
    getAiMode: () => aiMode,
    setAiMode: (v: 'off' | 'preview' | 'live') => {
      aiMode = v;
    },
    getConsentPostCount: () => consentPostCount,
    getModePostValues: () => [...modePostValues],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.use({ viewport: { width: 1280, height: 800 } });

test('ai-live-consent: happy path — Accept enables Live and shows summary card', async ({
  page,
}) => {
  test.setTimeout(120_000);

  const { getConsentPostCount, getModePostValues } = await setupMocks(page);

  // Navigate to the AI settings pane (#496: AI-mode control relocated here from Appearance)
  await page.goto('/settings/ai');
  const liveRadio = page.getByRole('radio', { name: 'Live' });
  await liveRadio.waitFor({ timeout: 30_000 });

  // Clicking Live must NOT immediately commit the preference — it intercepts
  // to fetch the disclosure and open the consent modal.
  const consentPostPromise = page.waitForResponse(
    (r) => r.url().includes('/api/ai/consent') && r.request().method() === 'POST',
    { timeout: 30_000 },
  );
  const prefsPostPromise = page.waitForResponse(
    (r) =>
      r.url().includes('/api/preferences') &&
      r.request().method() === 'POST' &&
      // Only the Live flip — not the GET that runs on page load
      (r.request().postData() ?? '').includes('live'),
    { timeout: 30_000 },
  );

  await liveRadio.click();

  // The consent modal must appear
  const modal = page.getByRole('dialog', { name: 'Enable Live AI' });
  await expect(modal).toBeVisible({ timeout: 10_000 });

  // Disclosure content must be populated (modal fetches it on open)
  await expect(modal.getByText('Anthropic, via the Claude Code CLI')).toBeVisible({
    timeout: 10_000,
  });
  await expect(modal.getByText('Pull request diff')).toBeVisible();

  // Click "Enable Live" — triggers consent POST then preferences POST
  await modal.getByRole('button', { name: 'Enable Live' }).click();

  // Wait for both network calls to settle
  await consentPostPromise;
  await prefsPostPromise;

  // Consent POST must have fired exactly once
  expect(getConsentPostCount()).toBe(1);
  // Preferences POST must have set the mode to 'live'
  expect(getModePostValues()).toContain('live');

  // Modal must close
  await expect(modal).not.toBeVisible({ timeout: 10_000 });

  // AI-mode control must reflect the committed mode (Live)
  await expect(page.getByRole('radio', { name: 'Live' })).toHaveAttribute('aria-checked', 'true');

  // Navigate to the PR detail — fresh navigation remounts the view so
  // useCapabilities/usePreferences refetch the updated mock state (aiMode='live').
  await page.goto(`/pr/${OWNER}/${REPO}/${PR_NUMBER}`);
  await page.locator('[data-testid="pr-header"]').waitFor({ timeout: 30_000 });

  // AiSummaryCard must be visible; the mock returns a real body only for Live.
  await expect(page.getByTestId('ai-summary-card')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Dependency injection refactor.')).toBeVisible({ timeout: 10_000 });
});

test('ai-live-consent: decline — modal closes, Live not committed, summary card absent', async ({
  page,
}) => {
  test.setTimeout(120_000);

  const { getAiMode, getConsentPostCount, getModePostValues } = await setupMocks(page);

  // Navigate to the AI settings pane (#496: AI-mode control relocated here from Appearance)
  await page.goto('/settings/ai');
  const liveRadio = page.getByRole('radio', { name: 'Live' });
  await liveRadio.waitFor({ timeout: 30_000 });

  await liveRadio.click();

  // Consent modal must appear
  const modal = page.getByRole('dialog', { name: 'Enable Live AI' });
  await expect(modal).toBeVisible({ timeout: 10_000 });

  // Click "Decline"
  await modal.getByRole('button', { name: 'Decline' }).click();

  // Modal must close
  await expect(modal).not.toBeVisible({ timeout: 10_000 });

  // The AI-mode mock closure must still be 'off' — no Live commit
  expect(getAiMode()).toBe('off');

  // No consent POST must have fired
  expect(getConsentPostCount()).toBe(0);

  // No preferences POST for 'live' must have occurred
  expect(getModePostValues().includes('live')).toBe(false);

  // The AI-mode control must NOT show Live selected (Off is still committed)
  await expect(page.getByRole('radio', { name: 'Live' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true');

  // Navigate to the PR detail — aiMode is still 'off', so capabilities return
  // all-off, and the summary card must not render.
  await page.goto(`/pr/${OWNER}/${REPO}/${PR_NUMBER}`);
  await page.locator('[data-testid="pr-header"]').waitFor({ timeout: 30_000 });

  await expect(page.getByTestId('ai-summary-card')).not.toBeVisible({ timeout: 10_000 });
});
