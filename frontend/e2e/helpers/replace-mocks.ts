import type { Page, Route } from '@playwright/test';
import { setupBaseRoutes } from './base-mocks';

// Shared mocks for the mocked-mode Replace-token e2e specs
// (replace-token-same-login.spec.ts + replace-token-different-login.spec.ts).
// Extracted per claude[bot] iter-5 F4 — both specs were copy-pasting the same
// authed/preferences/capabilities/events fixtures and a future schema change
// would have required dual updates.
//
// The third spec in the family (replace-token-submit-in-flight.spec.ts) uses
// the REAL backend via /test/submit/hold and doesn't share these mocks.

const defaultPreferences = {
  ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable' },
  inbox: {
    sections: {
      'review-requested': true,
      'awaiting-author': true,
      'authored-by-me': true,
      mentioned: true,
      'recently-closed': true,
    },
    defaultSort: 'updated',
  },
  github: {
    host: 'https://github.com',
    configPath: '/Users/x/AppData/Local/PRism/config.json',
    logsPath: '/Users/x/AppData/Local/PRism/logs',
  },
};

// Wires up the read-side endpoints the Settings + Setup pages depend on:
// setupBaseRoutes covers auth/state + capabilities + events; this adds the
// preferences snapshot + submit/in-flight. Callers add their own
// page.route('**/api/auth/replace', …) for the test-specific success/error.
export async function setupReplaceMocks(page: Page): Promise<void> {
  await setupBaseRoutes(page);
  await page.route('**/api/preferences', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(defaultPreferences),
    }),
  );
  await page.route('**/api/submit/in-flight', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ inFlight: false, prRef: null }),
    }),
  );
}
