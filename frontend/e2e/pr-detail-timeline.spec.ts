import { test, expect, request } from '@playwright/test';

import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

// #620 — e2e-fidelity coverage for the unified Overview activity feed. Before this
// spec + FakePrTimelineFeedReader (PRism.Web/TestHooks/FakePrTimelineFeedReader.cs),
// the scenario backend had no fake IPrTimelineFeedReader registered, so under
// PRISM_E2E_FAKE_REVIEW=1 the real GitHubPrTimelineFeedReader resolved, 502'd (no
// GitHub token in e2e), and the feed always rendered `timeline-error` — every prior
// scenario spec that opened the Overview tab was hollow-green on the feed itself.
//
// This asserts the feed renders real content for the canonical scenario PR
// (acme/api/123): at least one comment card, the approval marker, the grouped
// commit run, and — the actual point of this spec — no error state.
test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await ctx.dispose();
});

test('#620 Overview activity feed renders comments, marker, and commit group — no error state', async ({
  page,
}) => {
  await setupAndOpenScenarioPr(page);
  await page.goto('/pr/acme/api/123');
  await page.locator('[data-testid="pr-header"]').waitFor();

  const feed = page.getByTestId('activity-feed');
  await expect(feed).toBeVisible();

  // The point of this spec: the feed must NOT be showing the degraded/error state.
  await expect(page.getByTestId('timeline-error')).toHaveCount(0);

  // At least one comment card (FakePrTimelineFeedReader seeds two body-bearing
  // Commented events).
  await expect(feed.getByTestId('timeline-comment').first()).toBeVisible();

  // The bodyless Approved event renders as a marker with the approval state band.
  await expect(feed.getByTestId('timeline-marker').first()).toBeVisible();

  // The three seeded Pushed events collapse into one commit-group accordion.
  await expect(feed.getByTestId('timeline-commit-group')).toBeVisible();

  // The lifted PR-root composer (PrRootConversationActions) stays reachable at the
  // top of the feed — the "Reply…" affordance renders inside composerSlot, ahead of
  // the timeline <ol>.
  await expect(feed.getByRole('button', { name: 'Reply to the PR conversation' })).toBeVisible();
});
