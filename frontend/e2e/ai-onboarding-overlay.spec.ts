// frontend/e2e/ai-onboarding-overlay.spec.ts
//
// #485 AI onboarding overlay — functional e2e (prod project, real backend).
//
// Two tests:
//   1. fresh user: setupAndOpenScenarioPr yields onboardingSeen=false (backfill:
//      mode=Preview + no consent → false). Dialog appears over the inbox.
//      User clicks "Maybe later" → dialog closes → inbox visible → reload →
//      dialog gone (seen persisted).
//   2. returning user: POST ui.ai.onboardingSeen=true before navigating.
//      No dialog appears on inbox load.
//
// Both tests are self-contained and idempotent: each runs its own setup and owns
// its own preference state, so neither depends on the other's ordering or
// side-effects (test 2 POSTs seen=true explicitly rather than inheriting test 1's).
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
  // Confirm the SPA has finished loading (inbox rendered ⇒ preferences fetched ⇒
  // the dialog mount decision has been made) BEFORE asserting the dialog is absent.
  // toHaveCount(0) short-circuits the instant zero dialogs exist — including on the
  // blank post-reload DOM before the SPA remounts — so it must come second or it
  // can pass trivially without proving the persisted seen flag suppressed the dialog.
  await expect(page.getByTestId('inbox-page')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('dialog', { name: 'Set up AI for your reviews' })).toHaveCount(0);
});

test('returning user (onboardingSeen=true) sees no overlay on the inbox', async ({ page }) => {
  test.setTimeout(90_000);

  // Authenticate in THIS test's browser context. The session token is a
  // per-context cookie — page.request.post('/api/preferences') only carries it
  // once the SPA's /setup flow has run in this same context (page.request shares
  // the page's cookie jar). Running setup here makes this test self-contained
  // rather than relying on test 1's session leaking across tests.
  await setupAndOpenScenarioPr(page);

  // Mark onboardingSeen=true (returning user). With the session established above
  // this POST authenticates (no 401). The flat dotted-path single-field shape +
  // loopback Origin match the parity-baselines.spec.ts precedent.
  const resp = await page.request.post(`${BACKEND_ORIGIN}/api/preferences`, {
    data: { 'ui.ai.onboardingSeen': true },
    headers: { 'Content-Type': 'application/json', Origin: BACKEND_ORIGIN },
  });
  expect(resp.ok(), `POST onboardingSeen=true failed: ${resp.status()}`).toBe(true);

  // Re-mount the SPA so usePreferences refetches and picks up seen=true (it only
  // refetches on mount or window focus — a bare POST leaves React state stale).
  await page.goto('/');
  await page.waitForURL('/');

  // Confirm the inbox rendered (⇒ preferences fetched ⇒ mount decision made) BEFORE
  // asserting the dialog is absent. waitForURL only settles the URL, not the
  // preferences fetch; toHaveCount(0) would otherwise short-circuit on the still-
  // loading DOM and pass before the overlay has had its chance to (not) mount.
  await expect(page.getByTestId('inbox-page')).toBeVisible({ timeout: 30_000 });

  // Dialog must NOT appear.
  await expect(page.getByRole('dialog', { name: 'Set up AI for your reviews' })).toHaveCount(0);
});
