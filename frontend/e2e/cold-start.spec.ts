import { test, expect } from '@playwright/test';

// The first-run tests below depend on the no-token state. In the shared-backend CI
// suite a PAT from an earlier spec can survive /test/reset (it lives in the
// TokenStore cache), so clear it before each test rather than relying on this
// spec running before any token-seeding spec. See /test/clear-tokens (PR8 Task 13).
test.beforeEach(async ({ request, baseURL }) => {
  // Full URL + Origin header: the backend's host/origin CSRF guard rejects a
  // state-changing POST whose Origin doesn't match the bind host. baseURL is the
  // project's configured origin, so this stays correct under the #217 port param.
  const res = await request.post(`${baseURL}/test/clear-tokens`, {
    headers: { Origin: baseURL ?? '' },
  });
  expect(res.ok(), `clear-tokens failed: ${res.status()}`).toBeTruthy();
});

test('cold start lands on the /welcome landing when no token', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole('heading', { level: 1, name: 'PRism' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('link', { name: /get started/i })).toBeVisible();
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

test('first-run /setup also hides the top nav tabs (#212)', async ({ page }) => {
  // The Header gates nav rendering on isAuthed, and /setup on a true first run is
  // unauthed — so the nav must be absent there too, not just on /welcome. Without
  // this, a regression that rendered the nav on /setup first-run would slip past
  // the /welcome-only nav assertion.
  await page.goto('/setup');
  await expect(page.getByRole('heading', { level: 1, name: /connect to github/i })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^inbox$/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^settings$/i })).toHaveCount(0);
  // #215: on /setup the product name is shown as the visible header wordmark
  // (the logomark itself goes decorative, alt=""), filling the empty no-nav header.
  // Scoped to <header> so the assertion can't drift onto future page copy.
  await expect(page.locator('header').getByText('PRism', { exact: true })).toBeVisible();
});

test('cold start hides the top nav tabs on /welcome (#130)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'PRism' })).toBeVisible({
    timeout: 30_000,
  });
  // First-run: the nav tab strip is not rendered at all.
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^inbox$/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^settings$/i })).toHaveCount(0);
  // Logo still present.
  await expect(page.getByAltText('PRism')).toBeVisible();
  // #215: header wordmark SUPPRESSED on /welcome (hero owns the name).
  await expect(page.locator('header').getByText('PRism', { exact: true })).toHaveCount(0);
});
