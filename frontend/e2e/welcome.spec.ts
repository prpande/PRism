import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// #212: the first-run welcome/landing screen. The e2e backend starts with no
// token (fresh dataDir), so a no-token user is a genuine first run.

test('first run lands on /welcome', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole('heading', { level: 1, name: 'PRism' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('link', { name: /get started/i })).toBeVisible();
});

test('Get started advances to /setup and Back returns to /welcome', async ({ page }) => {
  await page.goto('/welcome');
  await page.getByRole('link', { name: /get started/i }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: /connect to github/i })).toBeVisible();
  // First-run-only Back returns to the landing.
  await page.getByRole('link', { name: /back/i }).click();
  await expect(page).toHaveURL(/\/welcome$/);
});

test('/welcome hides the top nav and keeps the logo (first run, #130)', async ({ page }) => {
  await page.goto('/welcome');
  await expect(page.getByRole('heading', { level: 1, name: 'PRism' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^inbox$/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^settings$/i })).toHaveCount(0);
  // The header logo (alt="PRism") is still present.
  await expect(page.getByAltText('PRism')).toBeVisible();
});

test('footer Help / Send feedback are non-interactive stubs', async ({ page }) => {
  await page.goto('/welcome');
  await expect(page.getByText('Help')).toBeVisible();
  await expect(page.getByText('Send feedback')).toBeVisible();
  await expect(page.getByRole('link', { name: /^help$/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /send feedback/i })).toHaveCount(0);
});

test('/welcome has no serious or critical a11y violations', async ({ page }) => {
  await page.goto('/welcome');
  await expect(page.getByRole('heading', { level: 1, name: 'PRism' })).toBeVisible({
    timeout: 30_000,
  });
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  // Stringify ALL violations as the failure message so a red run shows the
  // rule id / help URL / nodes, not just an empty-array mismatch (matches the
  // a11y-audit.spec.ts idiom).
  expect(blocking, JSON.stringify(results.violations, null, 2)).toEqual([]);
});
