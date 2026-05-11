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
