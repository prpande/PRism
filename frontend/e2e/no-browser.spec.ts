import { test, expect, request } from '@playwright/test';

test('backend /api/health responds when started with --no-browser', async () => {
  // The backend was started by playwright's webServer with --no-browser.
  // Hit /api/health directly to confirm it's reachable.
  const ctx = await request.newContext();
  const resp = await ctx.get('http://localhost:5180/api/health');
  expect(resp.ok()).toBe(true);
  const body = await resp.json();
  expect(body).toHaveProperty('port');
  expect(body).toHaveProperty('version');
  expect(body).toHaveProperty('dataDir');
});
