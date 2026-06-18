// frontend/e2e/inbox-enrichment.spec.ts
//
// #410 inbox-enricher e2e: verifies that the inbox renders an AI category chip
// for an enriched PR, a "Draft" chip for a draft PR, and no chip for a PR whose
// enrichment has categoryChip: null.
//
// Mock-only (no real backend). The spec wires:
//   - Live mode + inboxEnrichment capability (via aiMode: 'live' in preferences;
//     capabilities are derived locally so allOffCapabilities from setupBaseRoutes
//     is irrelevant here — useCapabilities returns LIVE_CAPABILITIES when aiMode='live')
//   - /api/inbox with three items and an enrichments map
//
// Text assertions only — no visual snapshots/baselines introduced.

import { test, expect, type Route } from '@playwright/test';
import { setupBaseRoutes } from './helpers/base-mocks';
import { makeDefaultPreferences } from './fixtures/preferences';

test.use({ viewport: { width: 1280, height: 800 } });

test('inbox shows AI category chip, Draft chip, and no chip for null category', async ({
  page,
}) => {
  await setupBaseRoutes(page);

  // Preferences: Live mode — useCapabilities() returns LIVE_CAPABILITIES which has
  // inboxEnrichment:true, so useAiGate('inboxEnrichment') = true.
  const basePrefs = makeDefaultPreferences();
  await page.route('**/api/preferences', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...basePrefs,
        ui: { ...basePrefs.ui, aiMode: 'live' },
        // groupByRepo: false so items render as flat rows without accordion nesting
        inbox: { ...basePrefs.inbox, groupByRepo: false },
      }),
    }),
  );

  // Three-item inbox:
  //   #1 non-draft, enriched → "Feature" category chip
  //   #2 draft (isDraft: true), no enrichment → "Draft" chip
  //   #3 non-draft, enrichment with categoryChip: null → no chip
  await page.route('**/api/inbox', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sections: [
          {
            id: 'review-requested',
            label: 'Review requested',
            items: [
              {
                reference: { owner: 'octo', repo: 'repo', number: 1 },
                title: 'Add feature widget',
                author: 'alice',
                avatarUrl: null,
                repo: 'octo/repo',
                updatedAt: new Date().toISOString(),
                pushedAt: new Date().toISOString(),
                iterationNumber: 1,
                commentCount: 0,
                additions: 10,
                deletions: 2,
                headSha: 'aaa1',
                ci: 'none',
                lastViewedHeadSha: null,
                lastSeenCommentId: null,
                mergedAt: null,
                closedAt: null,
                isDraft: false,
              },
              {
                reference: { owner: 'octo', repo: 'repo', number: 2 },
                title: 'Work in progress',
                author: 'bob',
                avatarUrl: null,
                repo: 'octo/repo',
                updatedAt: new Date().toISOString(),
                pushedAt: new Date().toISOString(),
                iterationNumber: 1,
                commentCount: 0,
                additions: 3,
                deletions: 1,
                headSha: 'bbb2',
                ci: 'none',
                lastViewedHeadSha: null,
                lastSeenCommentId: null,
                mergedAt: null,
                closedAt: null,
                isDraft: true,
              },
              {
                reference: { owner: 'octo', repo: 'repo', number: 3 },
                title: 'Misc cleanup',
                author: 'carol',
                avatarUrl: null,
                repo: 'octo/repo',
                updatedAt: new Date().toISOString(),
                pushedAt: new Date().toISOString(),
                iterationNumber: 2,
                commentCount: 1,
                additions: 5,
                deletions: 5,
                headSha: 'ccc3',
                ci: 'none',
                lastViewedHeadSha: null,
                lastSeenCommentId: null,
                mergedAt: null,
                closedAt: null,
                isDraft: false,
              },
            ],
          },
        ],
        // Enrichments map: key = "owner/repo#number" (prId() in groupByRepo.ts)
        enrichments: {
          'octo/repo#1': { prId: 'octo/repo#1', categoryChip: 'Feature', hoverSummary: null },
          'octo/repo#3': { prId: 'octo/repo#3', categoryChip: null, hoverSummary: null },
        },
        lastRefreshedAt: new Date(0).toISOString(),
        tokenScopeFooterEnabled: false,
        ciProbeComplete: true,
      }),
    }),
  );

  await page.goto('/');

  // Wait for inbox to load (section heading confirms the rows are rendered)
  await expect(page.getByText('Review requested')).toBeVisible({ timeout: 30_000 });

  // #1: AI category chip for the enriched PR.
  // InboxRow renders: <span class="chipWrap"><span class="chip"><span class="chipMarker">AI</span>Feature</span>·</span>
  // Use chipWrap as the scope anchor (present only when a chip renders), then check it
  // contains the category text "Feature".
  const featureRow = page.getByRole('button', { name: /Add feature widget/ });
  await expect(featureRow).toBeVisible();
  const featureChipWrap = featureRow.locator('[class*="chipWrap"]');
  await expect(featureChipWrap).toBeVisible();
  await expect(featureChipWrap).toContainText('Feature');

  // #2: Draft chip for the draft PR — the draftChip span contains exactly "Draft"
  const draftRow = page.getByRole('button', { name: /Work in progress/ });
  await expect(draftRow).toBeVisible();
  await expect(draftRow.locator('[class*="draftChip"]')).toBeVisible();
  await expect(draftRow.locator('[class*="draftChip"]')).toContainText('Draft');

  // #3: null category → no chip. Assert the row rendered but has no chip wrapper.
  const miscRow = page.getByRole('button', { name: /Misc cleanup/ });
  await expect(miscRow).toBeVisible();
  // chipWrap is only rendered when a draft or category chip is present
  await expect(miscRow.locator('[class*="chipWrap"]')).toHaveCount(0);
});
