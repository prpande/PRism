import { test, expect } from '@playwright/test';

test('cold start lands on Setup screen when no token', async ({ page }) => {
  await page.goto('/');

  // Either Setup screen renders, or we're routed to /setup.
  await expect(page.getByRole('heading', { name: /connect to github/i })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByLabel(/personal access token/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /continue/i })).toBeVisible();
});

test('Continue button is disabled with empty input', async ({ page }) => {
  await page.goto('/setup');
  await expect(page.getByRole('button', { name: /continue/i })).toBeDisabled();
});

test('typing in PAT enables Continue', async ({ page }) => {
  await page.goto('/setup');
  await page.getByLabel(/personal access token/i).fill('ghp_test_token');
  await expect(page.getByRole('button', { name: /continue/i })).toBeEnabled();
});
