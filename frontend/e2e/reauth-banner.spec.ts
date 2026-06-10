import { test, expect, type Route } from '@playwright/test';
import {
  authedAuthState,
  allOffCapabilities,
  makeDefaultPreferences,
} from './fixtures/preferences';

// #312 Task 13 — visual e2e for the re-auth banner (GitHubAuthBanner).
//
// The banner (frontend/src/components/GitHubAuthBanner/GitHubAuthBanner.tsx)
// renders its VISIBLE danger bar — text "GitHub access token invalid —
// reconnect" + a "Reconnect" button — only when ALL of:
//   - authState.hasToken === true AND authState.githubCredentialInvalid === true
//   - the SSE stream is healthy (useStreamHealth)
//   - the route is NOT /setup (which IS the fix)
//
// We force that state hermetically the way the rest of the e2e suite does
// (inbox.spec.ts / settings-modal-visual.spec.ts / replace-mocks.ts): page.route
// interception of the read-side API surface, with the SHARED fixtures from
// ./fixtures/preferences for auth/preferences/capabilities so a future schema add
// is a single-point edit. The only delta vs. the authed baseline is the
// `githubCredentialInvalid: true` flag on /api/auth/state.
//
// `/api/events` is fulfilled with a heartbeat-only SSE body — that keeps
// useStreamHealth's `healthy` true (it defaults true and only flips on a real
// unhealthy signal), satisfying the banner's stream-health predicate without
// injecting events. The inbox is mocked EMPTY so the background is fully
// deterministic (EmptyAllSections, no timestamps / relative-time drift) — the
// banner is the subject under test, not the inbox rows.
//
// On first load at `/` the ReauthRouteGuard does NOT redirect to /setup: its
// one-way exit-gate only fires once the user has already entered /setup
// (enteredGate ref), so the banner is reachable on the home route.

// Explicit viewport (matches inbox.spec.ts) so the baseline is self-documenting
// and stable across the machine running the suite.
test.use({ viewport: { width: 1280, height: 800 } });

async function setupInvalidCredentialMocks(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      // hasToken: true + githubCredentialInvalid: true is the banner's trigger.
      body: JSON.stringify({ ...authedAuthState, githubCredentialInvalid: true }),
    }),
  );
  await page.route('**/api/preferences', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeDefaultPreferences()),
    }),
  );
  await page.route('**/api/capabilities', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(allOffCapabilities),
    }),
  );
  await page.route('**/api/inbox', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      // Empty inbox → deterministic EmptyAllSections background (no timestamps).
      body: JSON.stringify({
        sections: [],
        enrichments: {},
        lastRefreshedAt: '2025-01-01T00:00:00.000Z',
        tokenScopeFooterEnabled: false,
        ciProbeComplete: true,
      }),
    }),
  );
  await page.route('**/api/events', (route: Route) =>
    // Heartbeat-only SSE — keeps the stream "healthy" without injecting events.
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ':heartbeat\n\n' }),
  );
}

test('re-auth banner is shown on the inbox when the GitHub credential is invalid', async ({
  page,
}) => {
  await setupInvalidCredentialMocks(page);

  await page.goto('/');

  // Wait for the inbox shell to settle so the screenshot is taken against a
  // stable page (not mid-load skeleton).
  await expect(page.locator('[data-testid="inbox-page"]')).toBeVisible({ timeout: 30_000 });

  // The visible banner is proven by its Reconnect button, which is unique to the
  // visible bar. The message text "GitHub access token invalid — reconnect" also
  // lives in an always-mounted .sr-only live region (a11y, announce-once), so a bare
  // getByText would match twice and trip strict mode — assert the unique button
  // instead (the message itself is captured by the screenshot + the unit test).
  await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible();

  // Kill animations/transitions so the snapshot is byte-stable across runs
  // (mirrors no-layout-shift-on-banner.spec.ts).
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  });

  // Visual baseline. Gated to CI only: the canonical baseline is rendered in the
  // Linux Playwright container (.github/workflows/ci.yml) under
  // e2e/__screenshots__/linux/ (per-platform pathTemplate in
  // playwright.config.ts). Any local machine renders subpixels differently and
  // can never match it, so the screenshot is a CI-only regression gate; the
  // visibility assertions above run on every platform.
  if (process.env.CI) {
    await expect(page).toHaveScreenshot('reauth-banner.png');
  }
});
