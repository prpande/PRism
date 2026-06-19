// frontend/e2e/ai-usage.spec.ts
//
// #517 — AI usage & spend tracker e2e.
//
// One functional scenario:
//   1. Open Settings on /settings/ai → the AI nav auto-expands its children
//      (Configuration + Usage). Click the Usage child link → the AiUsagePane
//      renders with the "AI Usage" heading (h2) and the sub-cent cost headline
//      ($0.0012, from the mocked /api/ai/usage response).
//
// Mock-only: all /api/* routes are page.route()-intercepted before navigation,
// following the per-spec pattern established by ai-settings-tab.spec.ts and
// settings-flow.spec.ts. Each spec defines its OWN local setupSettingsMocks —
// the two existing helpers are NOT interchangeable (different persisted prefs
// and capabilities bodies), so this spec follows the same convention: a fresh
// spec-local helper, not a shared module. The capabilities body here is copied
// verbatim from ai-settings-tab.spec.ts (allOnCapabilities) so the AiMarker
// renders identically.
//
// Visual baselines: this spec makes NO toHaveScreenshot calls — all assertions
// are DOM/functional. settings-modal-visual.spec.ts only screenshots
// /settings/appearance and the GitHub Connection pane — never /settings/ai* —
// so the new Usage nav child appears in no existing baseline, and no rebase is
// needed.

import { test, expect, type Route } from '@playwright/test';
import { authedAuthState, makeDefaultPreferences } from './fixtures/preferences';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Verbatim copy of ai-settings-tab.spec.ts's allOnCapabilities body, so the
// AiMarker in the nav renders the same way (aiMode 'live' + all features on).
const allOnCapabilities = {
  ai: {
    summary: true,
    fileFocus: true,
    hunkAnnotations: true,
    preSubmitValidators: true,
    composerAssist: true,
    draftSuggestions: true,
    draftReconciliation: true,
    inboxEnrichment: true,
    inboxRanking: true,
  },
};

function makeAiPreferences() {
  const prefs = makeDefaultPreferences();
  return {
    ...prefs,
    ui: {
      ...prefs.ui,
      aiMode: 'live' as const,
      providerTimeoutSeconds: 240,
      hunkAnnotationCap: 10,
      summaryMaxChars: 1000,
    },
  };
}

const USAGE = {
  window: '7d',
  generatedAt: '2026-06-19T12:00:00Z',
  totals: {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 5000,
    totalTokens: 6200,
    estimatedCostUsd: 0.0012,
    providerCalls: 3,
    cacheHits: 1,
  },
  byFeature: [
    {
      component: 'summary',
      displayName: 'PR Summary',
      totalTokens: 6200,
      estimatedCostUsd: 0.0012,
      providerCalls: 3,
    },
  ],
  byPr: [
    {
      prRef: 'batch',
      displayLabel: 'Inbox (batched)',
      totalTokens: 100,
      estimatedCostUsd: 0.0001,
      providerCalls: 1,
    },
  ],
  totalPrCount: 1,
  cache: { cacheHits: 1, providerCalls: 3, hitRate: 0.25 },
  trend: [
    {
      bucketStart: '2026-06-18T00:00:00Z',
      granularity: 'day',
      estimatedCostUsd: 0.0012,
      totalTokens: 6200,
    },
  ],
};

// ---------------------------------------------------------------------------
// Mock wiring — spec-local, mirroring ai-settings-tab.spec.ts's own local
// helper (repo pattern: each spec owns its mock setup).
// ---------------------------------------------------------------------------

async function setupSettingsMocks(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );

  await page.route('**/api/capabilities', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(allOnCapabilities),
    }),
  );

  await page.route('**/api/events', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ':heartbeat\n\n' }),
  );

  await page.route('**/api/preferences', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeAiPreferences()),
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.use({ viewport: { width: 1280, height: 800 } });

test('ai-usage: AI nav auto-expands and routes to the Usage pane', async ({ page }) => {
  test.setTimeout(60_000);
  await setupSettingsMocks(page);
  await page.route('**/api/ai/usage**', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(USAGE),
    }),
  );

  await page.goto('/settings/ai');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });

  // AI is active → children visible (task C4 auto-expand).
  await expect(dialog.getByRole('link', { name: 'Usage' })).toBeVisible();
  await dialog.getByRole('link', { name: 'Usage' }).click();

  // AiUsagePane heading (task C3).
  await expect(page.getByRole('heading', { name: 'AI Usage', level: 2 })).toBeVisible();
  // Sub-cent headline — formatCost(0.0012) → "$0.0012" (not "$0.00"). Scope to the
  // "Usage summary" region (role="region" aria-label="Usage summary") to avoid the
  // strict-mode violation from duplicate occurrences in the sr-only text and table cells.
  const summaryRegion = page.getByRole('region', { name: 'Usage summary' });
  await expect(summaryRegion).toBeVisible();
  await expect(summaryRegion.getByText('$0.0012')).toBeVisible();
});
