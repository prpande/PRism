import { test, expect, type Route } from '@playwright/test';

// S6 PR4 / spec § 3.2.1 — Replace token UX (different-login / identity-change path).
// PAT-A is connected as `alice`; user pastes PAT-B which validates as `bob`.
// Backend returns identityChanged=true, frontend surfaces a 'success' toast
// naming the new login and explaining "drafts preserved; Node IDs cleared",
// then navigates to /.
//
// Backend draft-preservation correctness is covered by PR2's identity-change
// rule unit tests in PRism.Web.Tests (Drafts dict survives the Node-ID clear).
// This spec scopes to the frontend wiring: link → form → POST → toast → nav.

const authedAuthState = {
  hasToken: true,
  host: 'https://github.com',
  hostMismatch: null,
};

const defaultPreferences = {
  ui: { theme: 'system', accent: 'indigo', aiPreview: false },
  inbox: {
    sections: {
      'review-requested': true,
      'awaiting-author': true,
      'authored-by-me': true,
      mentioned: true,
      'ci-failing': true,
    },
  },
  github: {
    host: 'https://github.com',
    configPath: '/Users/x/AppData/Local/PRism/config.json',
    logsPath: '/Users/x/AppData/Local/PRism/logs',
  },
};

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

async function setupReplaceMocks(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );
  await page.route('**/api/preferences', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(defaultPreferences),
    }),
  );
  await page.route('**/api/capabilities', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(allOffCapabilities),
    }),
  );
  await page.route('**/api/submit/in-flight', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ inFlight: false, prRef: null }),
    }),
  );
  await page.route('**/api/events', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ':heartbeat\n\n' }),
  );
}

test.use({ viewport: { width: 1280, height: 800 } });

test('Replace token to a PAT with a DIFFERENT login surfaces an identity-changed success toast', async ({
  page,
}) => {
  await setupReplaceMocks(page);
  await page.route('**/api/auth/replace', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        login: 'bob',
        host: 'https://github.com',
        identityChanged: true,
      }),
    }),
  );

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: /^auth$/i, level: 2 })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole('link', { name: /^replace token$/i }).click();
  await page.waitForURL(/\/setup\?replace=1/, { timeout: 10_000 });

  await page.getByLabel(/personal access token/i).fill('ghp_different_login');
  await page.getByRole('button', { name: /continue/i }).click();

  // Toast appears with the new login and the drafts-preserved / Node-IDs-cleared
  // semantics. Spec § 3.2.1.
  const toast = page.getByRole('status').filter({ hasText: /Connected as bob/i });
  await expect(toast).toBeVisible({ timeout: 10_000 });
  await expect(toast).toContainText(/Drafts preserved/i);
  await expect(toast).toContainText(/pending review IDs cleared/i);
});
