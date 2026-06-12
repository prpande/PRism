import type { BrowserContext, Page, Route } from '@playwright/test';
import { authedAuthState, allOffCapabilities } from '../fixtures/preferences';

// Shared wiring for the three CONSTANT read-side routes every mocked-mode page
// load depends on (#332), pinned to the canonical fixtures in
// ../fixtures/preferences so a wire-shape change is a single-point edit.
//
// Deliberately a SUBSET of the specs' own `setupBaseMocks` helpers — it does
// NOT wire `**/api/preferences`. That route varies per spec (most use a mutable
// store so POST-then-reload persistence is observable), so it stays each spec's
// own: call setupBaseRoutes(target) first, then add the preferences route plus
// any data routes (`**/api/inbox`, `**/api/pr/...`).
//
// Accepts a Page or a BrowserContext (both expose the same `.route()`) so
// cross-tab specs can register at the context level (density-cross-tab.spec.ts).
export async function setupBaseRoutes(target: Page | BrowserContext): Promise<void> {
  await target.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );
  await target.route('**/api/capabilities', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(allOffCapabilities),
    }),
  );
  await target.route('**/api/events', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ':heartbeat\n\n' }),
  );
}
