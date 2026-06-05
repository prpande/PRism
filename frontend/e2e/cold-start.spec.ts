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
  // Wait for hydration before filling (#148): the Continue button is rendered by
  // the same React form and starts DISABLED — a controlled, JS-driven state.
  // Asserting that state first proves the form's onChange handlers are attached,
  // so the fill below actually drives React state. Without it, .fill() can land
  // before hydration and the controlled input never updates → flake (previously
  // absorbed by retries:1).
  await expect(page.getByRole('button', { name: /continue/i })).toBeDisabled();
  await page.getByLabel(/personal access token/i).fill('ghp_test_token');
  await expect(page.getByRole('button', { name: /continue/i })).toBeEnabled();
});
