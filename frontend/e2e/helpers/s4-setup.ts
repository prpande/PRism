import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { BACKEND_ORIGIN } from './backend-origin';

// Per-test state reset. The backend process is long-running across the whole
// Playwright run; without this, FakeReviewService head-sha mutations and
// state.json drafts leak between specs. Spec `test.beforeEach`s call this so
// each spec sees the canonical 3-iteration scenario from scratch.
//
// Also resets ui.aiPreview to false via POST /api/preferences. The backend
// is reused across Playwright runs (reuseExistingServer: !isCI) and its
// config.json persists in the DataDir across runs — a prior run that enabled
// AI preview leaves AiPreviewState.IsOn = true in the reused server, which
// makes parity-baselines and other layout-sensitive specs render AI content
// they don't expect. /test/reset only resets state.json (sessions), not
// config, so we patch aiPreview explicitly. No auth required on the endpoint.
export async function resetBackendState(request: APIRequestContext): Promise<void> {
  const resp = await request.post(`${BACKEND_ORIGIN}/test/reset`, {
    headers: { Origin: BACKEND_ORIGIN },
  });
  if (!resp.ok()) {
    throw new Error(`/test/reset failed: ${resp.status()} ${await resp.text()}`);
  }
  const body = (await resp.json()) as {
    ok?: boolean;
    sessions?: number;
  };
  if (body.sessions !== 0) {
    throw new Error(`/test/reset did not clear state — sessions=${body.sessions} after reset`);
  }
  // Reset AI preview + content-scale preferences so parity-baselines and
  // layout-sensitive specs don't inherit a prior session's config.json. The
  // reused server (reuseExistingServer: !isCI) persists config across runs, so
  // a prior font-size spec that left contentScale='xl' would otherwise scale
  // content in every later spec's screenshots (and break #135's own baseline
  // capture). 'm' is the default and removes the data-content-scale attribute.
  //
  // POST /api/preferences enforces EXACTLY ONE field per patch
  // (PreferencesEndpoints.cs → "exactly one field per patch"), so these must be
  // two separate requests — a combined body 400s and resets neither. Best-effort:
  // a non-200 (e.g., config already default) is acceptable and silently ignored
  // rather than failing the beforeEach — the test will fail for its own reason.
  // showActivityRail: the product default flipped ON in #439, but parity/layout specs
  // pin it OFF here so the (deterministic, FakeActivityProvider-backed) rail doesn't
  // appear in baselines that aren't testing it — the same hygiene applied to aiPreview /
  // contentScale above. The rail's own visual baseline (`inbox-activity-rail`) re-enables
  // it explicitly per-test.
  for (const patch of [
    { aiPreview: false },
    { contentScale: 'm' },
    { 'inbox.showActivityRail': false },
    // #485 first-run onboarding overlay: patch onboardingSeen=true on every spec
    // reset so all real-backend specs represent a returning user (dialog hidden).
    // The onboarding e2e spec (ai-onboarding-overlay.spec.ts) deliberately skips
    // resetBackendState for the fresh-user test and handles its own state setup.
    { 'ui.ai.onboardingSeen': true },
  ]) {
    const resp = await request.post(`${BACKEND_ORIGIN}/api/preferences`, {
      headers: { 'Content-Type': 'application/json', Origin: BACKEND_ORIGIN },
      data: JSON.stringify(patch),
    });
    void resp;
  }
}

// Shared setup flow for S4 PR7 Playwright specs. Each spec runs against a
// fresh DataDir (per playwright.config.ts), so every test starts in the
// no-token state — go through Setup once, then navigate to the canonical
// scenario PR (acme/api/123, see PRism.Web/TestHooks/FakeReviewService.cs).
//
// FakeReviewService.ValidateCredentialsAsync always succeeds, so any
// non-empty PAT input value is accepted.
export async function setupAndOpenScenarioPr(page: Page): Promise<void> {
  await page.goto('/setup');
  // Wait for hydration before filling (#148/D5): Continue starts DISABLED (a
  // controlled React state), so asserting that first proves the form's onChange
  // handlers are attached and the fill below drives state — otherwise .fill()
  // can race hydration, the controlled input never updates, Continue stays
  // disabled, the click no-ops, and waitForURL('/') times out.
  await expect(page.getByRole('button', { name: /continue/i })).toBeDisabled();
  await page.getByLabel(/personal access token/i).fill('ghp_e2e_token');
  await page.getByRole('button', { name: /continue/i }).click();
  // After connect, the SPA navigates to / (inbox). Wait for that route — the
  // fake exposes the visible section headers with empty lists by default; the
  // canonical scenario row appears in "Review requested" only after a spec POSTs
  // /test/seed-inbox. This helper stops at the inbox; callers that need the PR
  // detail must navigate there separately (e.g. openScenarioPr / page.goto('/pr/...')).
  await page.waitForURL('/');
}

// Navigates to the scenario PR's Files tab. Used by drafts-survive-restart
// and reconciliation-fires specs, which exercise the diff-click composer.
export async function openScenarioFilesTab(page: Page): Promise<void> {
  await page.goto('/pr/acme/api/123/files');
}

// POST /api/pr/{ref}/reload with the page's tab id in the X-PRism-Tab-Id header — the
// cross-tab-stamp slice gates the reload endpoint on a valid per-tab id (allowlist
// [a-zA-Z0-9_-]{1,64}) and 422-rejects requests without it. Specs that drive the page via
// `page.request.post('/api/.../reload', ...)` directly (rather than through the page's
// apiClient) used to omit the header; this helper centralizes the read-from-page +
// header-stamp so each call site doesn't repeat the boilerplate. Returns the Playwright
// APIResponse so callers can assert status (.poll patterns + .status() checks).
export async function reloadPr(
  page: Page,
  pr: { owner: string; repo: string; number: number },
  headSha: string,
): Promise<import('@playwright/test').APIResponse> {
  const tabId = await page.evaluate(() => {
    if (typeof window.__prism_test_getTabId !== 'function') {
      throw new Error(
        'window.__prism_test_getTabId is not exposed — ensure frontend/src/api/tabId.ts ' +
          'has run before reloadPr is called (any page.goto + waitForURL is sufficient).',
      );
    }
    return window.__prism_test_getTabId();
  });
  return page.request.post(`/api/pr/${pr.owner}/${pr.repo}/${pr.number}/reload`, {
    data: { headSha },
    headers: {
      Origin: BACKEND_ORIGIN,
      'X-PRism-Tab-Id': tabId,
    },
  });
}

// POST /test/advance-head with the Origin header set — OriginCheckMiddleware
// rejects mutating verbs without one (spec § 6.2, S3 PR5 tightening). The
// page.request.post API doesn't auto-add Origin the way fetch from a page
// document does, so the helper supplies it explicitly.
export async function advanceHead(
  page: Page,
  newHeadSha: string,
  fileChanges: Array<{ path: string; content: string }>,
): Promise<void> {
  const resp = await page.request.post('/test/advance-head', {
    data: { newHeadSha, fileChanges },
    headers: { Origin: BACKEND_ORIGIN },
  });
  if (!resp.ok()) {
    throw new Error(`/test/advance-head failed: ${resp.status()} ${await resp.text()}`);
  }
}
