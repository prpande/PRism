import { test, expect } from '@playwright/test';
import { resetBackendState } from './helpers/s4-setup';

// S6 PR4 / spec § 3.1 — Replace link is aria-disabled while a submit is in flight.
// Exercises the real backend so /api/submit/in-flight reflects the actual
// SubmitLockRegistry held-set: /test/submit/hold acquires a slot synthetically;
// AuthSection's useSubmitInFlight hook fetches /api/submit/in-flight and renders
// the disabled state with the held PR ref in the tooltip; /test/submit/release-hold
// cleans up.
//
// Why not page.route mocking like the same-login / different-login specs: this is
// the one path where the wire between the frontend hook and the backend lock
// registry matters end-to-end. Mocking /api/submit/in-flight at the page level
// would assert the frontend wiring but say nothing about the backend integration.

const HELD_PR_REF = 'octocat/Hello-World/42';

async function holdSubmitLock(request: import('@playwright/test').APIRequestContext) {
  const resp = await request.post('http://localhost:5180/test/submit/hold', {
    headers: { Origin: 'http://localhost:5180', 'Content-Type': 'application/json' },
    data: { Owner: 'octocat', Repo: 'Hello-World', Number: 42 },
  });
  if (!resp.ok()) {
    throw new Error(`/test/submit/hold failed: ${resp.status()} ${await resp.text()}`);
  }
}

async function releaseSubmitLock(request: import('@playwright/test').APIRequestContext) {
  const resp = await request.post('http://localhost:5180/test/submit/release-hold', {
    headers: { Origin: 'http://localhost:5180' },
  });
  if (!resp.ok() && resp.status() !== 204) {
    throw new Error(`/test/submit/release-hold failed: ${resp.status()} ${await resp.text()}`);
  }
}

test.use({ viewport: { width: 1280, height: 800 } });

test.beforeEach(async ({ request }) => {
  // /test/reset disposes any leaked hold from a prior spec before resetting
  // the fake backing store. Defensive — release-hold below covers the happy path.
  await resetBackendState(request);
});

test.afterEach(async ({ request }) => {
  await releaseSubmitLock(request);
});

test('Replace token link is aria-disabled while a submit lock is held', async ({
  page,
  request,
}) => {
  // 1) Go through real Setup so the SPA is authenticated against the FakeReviewAuth.
  await page.goto('/setup');
  await page.getByLabel(/personal access token/i).fill('ghp_e2e_token');
  await page.getByRole('button', { name: /continue/i }).click();
  await page.waitForURL('/', { timeout: 30_000 });

  // 2) Acquire the SubmitLockRegistry slot synthetically (no real submit running).
  await holdSubmitLock(request);

  // 3) Navigate to Settings; AuthSection's useSubmitInFlight hook fetches
  //    /api/submit/in-flight on mount and renders the disabled state.
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: /^auth$/i, level: 2 })).toBeVisible({
    timeout: 30_000,
  });

  const link = page.getByRole('link', { name: /^replace token$/i });
  await expect(link).toHaveAttribute('aria-disabled', 'true', { timeout: 10_000 });
  await expect(link).toHaveAttribute('title', new RegExp(`Submit on ${HELD_PR_REF} in progress`));
});

test('Replace link re-enables after the submit lock is released (state-changed not required for fresh nav)', async ({
  page,
  request,
}) => {
  // Setup once.
  await page.goto('/setup');
  await page.getByLabel(/personal access token/i).fill('ghp_e2e_token');
  await page.getByRole('button', { name: /continue/i }).click();
  await page.waitForURL('/', { timeout: 30_000 });

  // Acquire → assert disabled → release → reload → assert enabled. The reload is
  // intentional: useSubmitInFlight refetches on prism-state-changed but the test
  // hook releases via HTTP (not via the SSE channel), so the page-level event
  // doesn't fire. A fresh navigation triggers the hook's mount-time fetch.
  await holdSubmitLock(request);
  await page.goto('/settings');
  await expect(page.getByRole('link', { name: /^replace token$/i })).toHaveAttribute(
    'aria-disabled',
    'true',
    { timeout: 10_000 },
  );

  await releaseSubmitLock(request);
  await page.reload();
  await expect(page.getByRole('link', { name: /^replace token$/i })).not.toHaveAttribute(
    'aria-disabled',
    'true',
    { timeout: 10_000 },
  );
});
