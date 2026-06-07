import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// #212: the first-run welcome/landing screen, which depends on the no-token
// (!hasToken) state. The CI `prod` project runs the FULL suite serially against
// ONE shared backend, and a PAT connected by an earlier spec survives /test/reset
// (it lives in the TokenStore cache, not state.json). Clear it before each test so
// the first-run state is deterministic regardless of spec ordering — exactly what
// /test/clear-tokens exists for (PR8 Task 13).
test.beforeEach(async ({ request, baseURL }) => {
  // Full URL + Origin header: the backend's host/origin CSRF guard rejects a
  // state-changing POST whose Origin doesn't match the bind host. baseURL is the
  // project's configured origin, so this stays correct under the #217 port param.
  const res = await request.post(`${baseURL}/test/clear-tokens`, {
    headers: { Origin: baseURL ?? '' },
  });
  expect(res.ok(), `clear-tokens failed: ${res.status()}`).toBeTruthy();
});

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
  // #215: the header wordmark is SUPPRESSED on /welcome (the hero <h1> already
  // names the product) — the header must not double-paint "PRism".
  await expect(page.locator('header').getByText('PRism', { exact: true })).toHaveCount(0);
});

test('footer Help links to /help; Send feedback links to /feedback', async ({ page }) => {
  // #210 wired Help; #211 wired Send feedback.
  await page.goto('/welcome');
  await expect(page.getByRole('link', { name: /^help$/i })).toHaveAttribute('href', '/help');
  await expect(page.getByRole('link', { name: /send feedback/i })).toHaveAttribute(
    'href',
    '/feedback',
  );
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
