import type { APIRequestContext, Page } from '@playwright/test';

// Per-test state reset. The backend process is long-running across the whole
// Playwright run; without this, FakeReviewService head-sha mutations and
// state.json drafts leak between specs. Spec `test.beforeEach`s call this so
// each spec sees the canonical 3-iteration scenario from scratch.
export async function resetBackendState(request: APIRequestContext): Promise<void> {
  const resp = await request.post('http://localhost:5180/test/reset', {
    headers: { Origin: 'http://localhost:5180' },
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
  await page.getByLabel(/personal access token/i).fill('ghp_e2e_token');
  await page.getByRole('button', { name: /continue/i }).click();
  // After connect, the SPA navigates to /. Wait for the inbox to render
  // (the fake exposes one section, "Review requested", with the canonical
  // scenario row). Click into the PR detail.
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
      Origin: 'http://localhost:5180',
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
    headers: { Origin: 'http://localhost:5180' },
  });
  if (!resp.ok()) {
    throw new Error(`/test/advance-head failed: ${resp.status()} ${await resp.text()}`);
  }
}
