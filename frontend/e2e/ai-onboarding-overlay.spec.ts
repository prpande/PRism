// frontend/e2e/ai-onboarding-overlay.spec.ts
//
// #485 AI onboarding overlay — functional e2e (prod project, real backend).
//
// Two tests:
//   1. fresh user: setupAndOpenScenarioPr yields onboardingSeen=false (backfill:
//      mode=Preview + no consent → false). Dialog appears over the inbox.
//      User clicks "Maybe later" → dialog closes → inbox visible → reload →
//      dialog gone (seen persisted). This test sets onboardingSeen=true on the
//      shared backend state, so test 2 finds onboardingSeen=true without an
//      explicit reset.
//   2. returning user: POST ui.ai.onboardingSeen=true before navigating.
//      No dialog appears on inbox load. Explicit POST is idempotent (safe whether
//      test 1 ran first or not in serial order).
//
// IMPORTANT — no resetBackendState in beforeEach:
//   resetBackendState patches onboardingSeen=true as one of its four preference
//   resets. Calling it in beforeEach for test 1 would suppress the dialog this
//   test is verifying. The two tests own their own state setup instead.
//
// Serial execution (workers=1 in playwright.config.ts) guarantees test 1 runs
// before test 2 within this file; the PAT from test 1 persists in the backend's
// TokenStore for test 2's direct page.goto('/') without re-running setup.

import { test, expect } from '@playwright/test';
import { BACKEND_ORIGIN } from './helpers/backend-origin';
import { setupAndOpenScenarioPr } from './helpers/s4-setup';

test.use({ viewport: { width: 1280, height: 800 } });

test('fresh user sees onboarding dialog over the inbox; "Maybe later" persists seen', async ({
  page,
}) => {
  test.setTimeout(90_000);

  // Authenticate via the /setup flow. The per-run fresh dataDir (playwright.config.ts
  // mkdtempSync) means onboardingSeen is absent from config.json on disk →
  // ConfigStore backfills it to false (mode=Preview, no consent → seen=false).
  // resetBackendState is deliberately NOT called here — it would patch
  // onboardingSeen=true and suppress the dialog this test is verifying.
  await setupAndOpenScenarioPr(page);

  // Force-navigate to '/' once more (mirrors parity-baselines.spec.ts inbox test):
  // setupAndOpenScenarioPr's waitForURL('/') can match transiently if the SPA
  // bounces back to /setup before the fake-mode swap fully settles.
  await page.goto('/');

  // The onboarding dialog must appear as soon as the inbox mounts.
  const dialog = page.getByRole('dialog', { name: 'Set up AI for your reviews' });
  await expect(dialog).toBeVisible({ timeout: 45_000 });

  // The SegmentedControl renders three options; Preview is the default (current mode).
  await expect(dialog.getByRole('radio', { name: 'Preview' })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Off' })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Live' })).toBeVisible();

  // "Maybe later" commits onboardingSeen=true without changing mode.
  await dialog.getByRole('button', { name: 'Maybe later' }).click();

  // Dialog closes; inbox-page renders.
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expect(page.getByTestId('inbox-page')).toBeVisible({ timeout: 15_000 });

  // Reload: preferences are re-fetched from the backend; seen=true → dialog must
  // NOT remount. This verifies the preference write persisted server-side.
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Set up AI for your reviews' })).toHaveCount(0);
  await expect(page.getByTestId('inbox-page')).toBeVisible({ timeout: 30_000 });
});

test('returning user (onboardingSeen=true) sees no overlay on the inbox', async ({ page }) => {
  test.setTimeout(60_000);

  // Mark onboardingSeen=true before loading the inbox. The PAT from test 1 in
  // this serial run persists in the backend's TokenStore, so page.goto('/') below
  // lands on the inbox (not /welcome or /setup). If this test somehow runs before
  // test 1 (e.g. standalone --grep), the request will 401 and the expect(resp.ok())
  // assertion below will surface the dependency clearly.
  const resp = await page.request.post(`${BACKEND_ORIGIN}/api/preferences`, {
    data: { 'ui.ai.onboardingSeen': true },
    headers: { 'Content-Type': 'application/json', Origin: BACKEND_ORIGIN },
  });
  // Non-200 → no auth session (test 1 must run first, or standalone re-auth needed).
  expect(resp.ok(), `POST onboardingSeen=true failed: ${resp.status()}`).toBe(true);

  await page.goto('/');
  await page.waitForURL('/');

  // Dialog must NOT appear.
  await expect(page.getByRole('dialog', { name: 'Set up AI for your reviews' })).toHaveCount(0);

  // Inbox must be visible and functional.
  await expect(page.getByTestId('inbox-page')).toBeVisible({ timeout: 30_000 });
});
