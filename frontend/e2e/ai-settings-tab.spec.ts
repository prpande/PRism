// frontend/e2e/ai-settings-tab.spec.ts
//
// #496 — AI Settings tab (Phase 1) e2e.
//
// Two functional scenarios:
//   1. Tab + persistence: open Settings → AI nav item → the AI pane renders
//      (heading "AI" + the two spinbuttons). Step the "Provider timeout"
//      spinbutton up, reload, reopen the AI tab, and assert the stepped value
//      persisted. Persistence rides the mutable page.route preferences store —
//      the established settings-spec convention (density-toggle.spec.ts,
//      settings-flow.spec.ts), where the POST mutates an in-memory store and the
//      post-reload GET re-serves it. (The default playwright.config webServer
//      boots a real backend, but these /api/* routes are page.route-intercepted,
//      so the mock store — not the backend dataDir — is the persistence seam.)
//
//   2. Timeout toast deep-link: force a seam 503 carrying { reason: "timeout" }
//      on a PR view (file-focus). The failure toast then shows "Adjust timeout";
//      clicking it deep-links to /settings/ai with a backgroundLocation so the
//      Settings modal opens OVER the PR (the PR DOM stays mounted, NOT torn down
//      to the Inbox).
//
// Mock-only: all /api/* routes are page.route()-intercepted before navigation,
// mirroring ai-failure-surfacing.spec.ts (the #484 spec). The #484 seam-failure
// injection is a plain route.fulfill({ status: 503 }) — a BARE 503 with no body.
// Scenario 2 needs the { reason: "timeout" } body so readFailureReason() in
// client.ts surfaces 'timeout' and the toast renders "Adjust timeout"; this spec
// emits that JSON body directly in its own file-focus route. There is no shared
// seam-stub fixture to extend — the #484 harness is per-spec page.route mocks.
//
// Visual baselines: this spec makes NO toHaveScreenshot calls — all assertions
// are DOM/functional. The AI pane has NO visual baseline (settings-modal-visual.spec.ts
// only screenshots the Appearance / GitHub / narrow views, never the AI pane), so the
// #525 "Summary length" row adds nothing to regenerate. No nav tab was added either, so
// the nav sidebar shown in the Appearance/GitHub screenshots is unchanged.

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
const PR1 = 1;

const SSE_SUBSCRIBER_ASSIGNED =
  'event: subscriber-assigned\ndata: {"subscriberId":"mock-sub-1"}\n\n';

// The shared makeDefaultPreferences() fixture predates the #496/#525 numeric AI knobs;
// the real GET /api/preferences always emits them and AiPane reads them, so add
// them to the mock store. Defaults mirror AiConfig (providerTimeoutSeconds=240,
// hunkAnnotationCap=10, summaryMaxChars=1000).
function makeAiPreferences() {
  const prefs = makeDefaultPreferences();
  return {
    ...prefs,
    ui: {
      ...prefs.ui,
      aiMode: 'live' as const,
      providerTimeoutSeconds: 240,
      hunkAnnotationCap: 10,
      summaryMaxChars: 1000,
    },
  };
}

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
// Mock wiring
// ---------------------------------------------------------------------------

// Settings-pane wiring: auth + a MUTABLE preferences store (the persistence
// seam) + capabilities. Mirrors density-toggle.spec.ts. Returns the store so a
// test can inspect it if needed.
async function setupSettingsMocks(page: import('@playwright/test').Page) {
  const store = makeAiPreferences();

  await page.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );

  await page.route('**/api/capabilities', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(allOnCapabilities),
    }),
  );

  await page.route('**/api/events', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ':heartbeat\n\n' }),
  );

  await page.route('**/api/preferences', async (route: Route) => {
    if (route.request().method() === 'POST') {
      // PATCH body is a single { [key]: value }. The AI numeric knobs PATCH via
      // the dotted ui.ai.* keys (PreferencesContext.writeKey); persist them onto
      // store.ui so the post-reload GET re-serves the stepped value.
      const body = (await route.request().postDataJSON()) as Record<string, unknown>;
      for (const [key, value] of Object.entries(body)) {
        if (key === 'ui.ai.providerTimeoutSeconds' && typeof value === 'number') {
          store.ui.providerTimeoutSeconds = value;
        } else if (key === 'ui.ai.hunkAnnotationCap' && typeof value === 'number') {
          store.ui.hunkAnnotationCap = value;
        } else if (key === 'ui.ai.summaryMaxChars' && typeof value === 'number') {
          store.ui.summaryMaxChars = value;
        } else if (key === 'ui.ai.mode' && typeof value === 'string') {
          store.ui.aiMode = value as 'off' | 'preview' | 'live';
        } else if (key.startsWith('ui.ai.features.') && typeof value === 'boolean') {
          // #536 per-feature toggle: mutate the features sub-object so the post-action
          // GET re-serves the toggled flag. store.ui.features is guaranteed to exist
          // (makeAiPreferences → makeDefaultPreferences now always includes all nine keys).
          const seam = key.slice('ui.ai.features.'.length) as keyof typeof store.ui.features;
          if (store.ui.features) store.ui.features[seam] = value;
        }
      }
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(store),
    });
  });

  return { store };
}

// PR-view wiring for scenario 2 — mirrors ai-failure-surfacing.spec.ts. AI mode
// is pre-seeded 'live' + all-on so the file-focus hook fires; the SSE emits
// subscriber-assigned so the D111 gate opens and the hook runs.
async function setupPrViewMocks(page: import('@playwright/test').Page) {
  const prefs = makeAiPreferences();

  await page.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );

  await page.route('**/api/preferences', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(prefs) }),
  );

  await page.route('**/api/capabilities', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(allOnCapabilities),
    }),
  );

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

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}`, (route: Route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makePrDetail(PR1)),
    });
  });

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}/draft`, (route: Route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(emptyDraftSession),
    });
  });

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}/mark-viewed`, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}/diff**`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sampleDiff),
    }),
  );

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}/ai/summary`, (route: Route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}/ai/hunk-annotations`, (route: Route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}/ai/draft-suggestions`, (route: Route) =>
    route.fulfill({ status: 204 }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.use({ viewport: { width: 1280, height: 800 } });

test('ai-tab: AI pane renders; Provider timeout step persists across reload', async ({ page }) => {
  test.setTimeout(60_000);
  await setupSettingsMocks(page);

  // Open Settings on the appearance pane, then navigate to the AI tab via the nav.
  await page.goto('/settings/appearance');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });

  await dialog.getByRole('link', { name: 'AI' }).click();

  // AI pane: heading + both spinbuttons.
  await expect(page.getByRole('heading', { name: 'AI', level: 2 })).toBeVisible();
  const timeout = page.getByRole('spinbutton', { name: 'Provider timeout' });
  const cap = page.getByRole('spinbutton', { name: 'Annotation cap' });
  const summaryLen = page.getByRole('spinbutton', { name: 'Summary length' });
  await expect(timeout).toBeVisible();
  await expect(cap).toBeVisible();
  await expect(summaryLen).toBeVisible();

  // Baseline value (default 240).
  await expect(timeout).toHaveAttribute('aria-valuenow', '240');

  // #525 Summary length: default 1000, step 100 → 1100, and the PATCH is mutable.
  await expect(summaryLen).toHaveAttribute('aria-valuenow', '1000');
  const summaryPost = page.waitForResponse(
    (r) => r.url().includes('/api/preferences') && r.request().method() === 'POST',
  );
  await summaryLen.focus();
  await summaryLen.press('ArrowUp');
  await summaryPost;
  await expect(summaryLen).toHaveAttribute('aria-valuenow', '1100');

  // Step UP: focus the spinbutton, press ArrowUp (step=30 → 270). Wait for the
  // PATCH to land before reloading so the store is mutated before the reload GET
  // (slow CI runners otherwise race the reload ahead of the in-flight POST).
  const postPromise = page.waitForResponse(
    (r) => r.url().includes('/api/preferences') && r.request().method() === 'POST',
  );
  await timeout.focus();
  await timeout.press('ArrowUp');
  await postPromise;
  await expect(timeout).toHaveAttribute('aria-valuenow', '270');

  // Reload — the PATCH persisted to the mock store; the next GET serves 270.
  await page.reload();

  // Reopen Settings → AI tab. (A reload lands on /settings/appearance, the modal
  // route; navigate to the AI pane again.)
  const dialogAfter = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialogAfter).toBeVisible({ timeout: 30_000 });
  await dialogAfter.getByRole('link', { name: 'AI' }).click();

  const timeoutAfter = page.getByRole('spinbutton', { name: 'Provider timeout' });
  await expect(timeoutAfter).toHaveAttribute('aria-valuenow', '270', { timeout: 10_000 });
});

test('ai-tab: timeout 503 toast deep-links to /settings/ai over the mounted PR', async ({
  page,
}) => {
  test.setTimeout(120_000);

  // file-focus returns a 503 carrying { reason: "timeout" } so readFailureReason
  // surfaces 'timeout' → the toast shows "Adjust timeout". (Registered FIRST so
  // it wins over any catch-all; setupPrViewMocks registers no file-focus route.)
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}/ai/file-focus`, (route: Route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ reason: 'timeout' }),
    }),
  );

  await setupPrViewMocks(page);

  await page.goto(`/pr/${OWNER}/${REPO}/${PR1}`);
  await page.locator('[data-testid="pr-header"]').waitFor({ timeout: 30_000 });

  // The timeout-aware toast appears with the "Adjust timeout" deep-link control.
  const toast = page.getByRole('group', { name: 'AI generation failure' });
  await expect(toast).toBeVisible({ timeout: 20_000 });
  const adjust = toast.getByRole('button', { name: /adjust timeout/i });
  await expect(adjust).toBeVisible();

  // Click it → deep-link to /settings/ai with backgroundLocation, so the Settings
  // modal opens OVER the PR.
  await adjust.click();

  await expect(page).toHaveURL(/\/settings\/ai$/, { timeout: 10_000 });
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI', level: 2 })).toBeVisible();

  // The PR is STILL mounted behind the modal — its header is in the DOM, NOT torn
  // down to the Inbox.
  await expect(page.locator('[data-testid="pr-header"]')).toBeAttached();
});

// ---------------------------------------------------------------------------
// #536: AI features accordion — Live toggle, Preview gate, real-wire gate
// ---------------------------------------------------------------------------

test('ai-tab: Live — expand AI features, toggle Summary off, POST fires + store reflects it', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { store } = await setupSettingsMocks(page);

  await page.goto('/settings/ai');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });

  // AI pane should be open (navigated directly to /settings/ai).
  await expect(page.getByRole('heading', { name: 'AI', level: 2 })).toBeVisible();

  // Expand the "AI features" disclosure button (Live-only).
  const featuresBtn = dialog.getByRole('button', { name: /AI features/i });
  await expect(featuresBtn).toBeVisible({ timeout: 10_000 });
  await featuresBtn.click();

  // The AI features group should now be visible.
  const featuresGroup = dialog.getByRole('group', { name: 'AI features' });
  await expect(featuresGroup).toBeVisible();

  // Find the "Summary" switch and toggle it off.
  const summarySwitch = featuresGroup.getByRole('switch', { name: /summary/i });
  await expect(summarySwitch).toBeVisible();
  // Default is on (checked). Switch is an <input type="checkbox" role="switch"> so
  // Playwright's .isChecked() / toBeChecked() reads the native checked property.
  await expect(summarySwitch).toBeChecked();

  // Wait for the POST that carries { "ui.ai.features.summary": false }.
  // waitForResponse resolves AFTER the route handler runs (store mutated),
  // avoiding a race where the store assertion runs before the mutation.
  const postPromise = page.waitForResponse(
    (r) => r.url().includes('/api/preferences') && r.request().method() === 'POST',
  );
  await summarySwitch.click();
  const postResponse = await postPromise;
  expect(JSON.stringify(postResponse.request().postDataJSON())).toBe(
    JSON.stringify({ 'ui.ai.features.summary': false }),
  );

  // Switch is now off.
  await expect(summarySwitch).not.toBeChecked();

  // Persisted store reflects the toggled value so a reload would re-serve false.
  expect(store.ui.features?.summary).toBe(false);
});

test('ai-tab: Preview — steppers absent + AI features button is aria-disabled', async ({
  page,
}) => {
  test.setTimeout(60_000);

  // Build a preview-mode preferences store (same shape as makeAiPreferences but aiMode=preview).
  const basePrefs = makeDefaultPreferences();
  const previewPrefs = {
    ...basePrefs,
    ui: {
      ...basePrefs.ui,
      aiMode: 'preview' as const,
      providerTimeoutSeconds: 240,
      hunkAnnotationCap: 10,
      summaryMaxChars: 1000,
    },
  };

  await page.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );
  await page.route('**/api/capabilities', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(allOnCapabilities),
    }),
  );
  await page.route('**/api/events', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ':heartbeat\n\n' }),
  );
  await page.route('**/api/preferences', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(previewPrefs),
    }),
  );

  await page.goto('/settings/ai');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'AI', level: 2 })).toBeVisible();

  // Steppers are Live-only — must not be present in Preview mode (absent from DOM).
  await expect(page.getByRole('spinbutton', { name: 'Provider timeout' })).not.toBeAttached();
  await expect(page.getByRole('spinbutton', { name: 'Annotation cap' })).not.toBeAttached();
  await expect(page.getByRole('spinbutton', { name: 'Summary length' })).not.toBeAttached();

  // The disabled "AI features" button is shown in Preview with aria-disabled="true".
  const disabledFeaturesBtn = dialog.getByRole('button', { name: /AI features/i });
  await expect(disabledFeaturesBtn).toBeVisible({ timeout: 10_000 });
  await expect(disabledFeaturesBtn).toHaveAttribute('aria-disabled', 'true');
});

test('ai-tab: real-wire gate — features.summary=false masks summary capability, card absent on PR', async ({
  page,
}) => {
  // HARNESS LIMITATION: This spec uses mocked page.route() handlers — there is
  // no real backend preferences store. This test proves the full FE pipeline:
  // (1) POST ui.ai.features.summary=false mutates the in-memory store,
  // (2) the mutable GET re-serves features.summary=false,
  // (3) deriveCapabilities masks capabilities.summary to false,
  // (4) useAiGate('summary') returns false,
  // (5) the AI summary card is not rendered on the PR overview.
  // A truly "real-serialized-response" gate is deferred to the `real/` suite
  // which runs against a live backend.
  test.setTimeout(60_000);

  // Shared mutable store seeded from makeAiPreferences (Live, all features on).
  // makeDefaultPreferences always populates ui.features (all nine, all on), so the
  // store is ready to mutate below — no defensive backfill needed.
  const store = makeAiPreferences();

  // Wire all routes from a single preferences store so the POST mutation is
  // visible to the subsequent PR-view navigation (same page, no reload needed).
  await page.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );

  await page.route('**/api/capabilities', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(allOnCapabilities),
    }),
  );

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

  await page.route('**/api/preferences', async (route: Route) => {
    if (route.request().method() === 'POST') {
      const body = (await route.request().postDataJSON()) as Record<string, unknown>;
      for (const [key, value] of Object.entries(body)) {
        if (key.startsWith('ui.ai.features.') && typeof value === 'boolean') {
          const seam = key.slice('ui.ai.features.'.length) as keyof typeof store.ui.features;
          if (store.ui.features) store.ui.features[seam] = value;
        }
      }
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(store),
    });
  });

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

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}`, (route: Route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makePrDetail(PR1)),
    });
  });

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}/draft`, (route: Route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(emptyDraftSession),
    });
  });

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}/mark-viewed`, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );

  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}/diff**`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sampleDiff),
    }),
  );

  // AI endpoints — registered but the summary gate is off after the toggle,
  // so /ai/summary is never fetched. Other seams are not asserted here.
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}/ai/summary`, (route: Route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}/ai/hunk-annotations`, (route: Route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}/ai/file-focus`, (route: Route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}/ai/draft-suggestions`, (route: Route) =>
    route.fulfill({ status: 204 }),
  );

  // Step 1: Open /settings/ai, expand AI features, toggle Summary off.
  await page.goto('/settings/ai');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'AI', level: 2 })).toBeVisible();

  const featuresBtn = dialog.getByRole('button', { name: /AI features/i });
  await expect(featuresBtn).toBeVisible({ timeout: 10_000 });
  await featuresBtn.click();

  const featuresGroup = dialog.getByRole('group', { name: 'AI features' });
  await expect(featuresGroup).toBeVisible();

  const summarySwitch = featuresGroup.getByRole('switch', { name: /summary/i });
  // Switch is an <input type="checkbox" role="switch">; read via .isChecked().
  await expect(summarySwitch).toBeChecked();

  // Toggle summary off and wait for the POST to land.
  const postPromise = page.waitForResponse(
    (r) => r.url().includes('/api/preferences') && r.request().method() === 'POST',
  );
  await summarySwitch.click();
  await postPromise;

  // Verify the in-memory store now carries summary=false (mock-level assertion).
  expect(store.ui.features?.summary).toBe(false);

  // Step 2: Navigate to the PR. The preferences GET re-serves features.summary=false,
  // so deriveCapabilities masks capabilities.summary=false → useAiGate('summary')=false
  // → useAiSummary runs with enabled=false → AiSummaryCard renders null.
  await page.goto(`/pr/${OWNER}/${REPO}/${PR1}`);
  await page.locator('[data-testid="pr-header"]').waitFor({ timeout: 30_000 });

  // The overview tab is default; wait for it to mount.
  const overviewTab = page.locator('[data-testid="overview-tab"]');
  await expect(overviewTab).toBeVisible({ timeout: 20_000 });

  // The AI summary card MUST NOT be present — the gate is off.
  await expect(page.locator('[data-testid="ai-summary-card"]')).not.toBeAttached();
});
