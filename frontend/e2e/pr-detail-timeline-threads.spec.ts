import { test, expect } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr, seedReviewThreads } from './helpers/s4-setup';

test.beforeEach(async ({ request }) => {
  await resetBackendState(request);
});

test('#774 review threads render as accordion rows under their review card', async ({ page }) => {
  await seedReviewThreads(page);
  await setupAndOpenScenarioPr(page); // lands on the inbox; navigate to the scenario PR
  await page.goto('/pr/acme/api/123');
  await page.getByTestId('overview-tab').waitFor();

  const rows = page.getByTestId('timeline-thread-row');
  await expect(rows).toHaveCount(2);

  // Anchored thread: path:line chip; outdated thread: Outdated badge.
  await expect(page.getByText('src/Calc.cs:5')).toBeVisible();
  await expect(page.getByText('Outdated')).toBeVisible();

  // Expanding the anchored row reveals its hunk + comment.
  await page
    .getByRole('button', { name: /thread on src\/Calc\.cs/i })
    .first()
    .click();
  await expect(page.getByTestId('timeline-thread-hunk').first()).toContainText('Div');
  // The collapsed row's own snippet chip also carries this text (ReviewThreadRow
  // always renders the first comment's body as a summary span), so scope to the
  // expanded CommentCard (an <article>) rather than a bare getByText.
  await expect(
    page.getByRole('article').filter({ hasText: 'Guard against divide-by-zero?' }),
  ).toBeVisible();
});
