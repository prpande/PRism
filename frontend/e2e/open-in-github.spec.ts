// frontend/e2e/open-in-github.spec.ts
import { test, expect } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

const VIEWPORT = { width: 1440, height: 900 };

test.describe('#131 Open in GitHub', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetBackendState(request);
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);
    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-diff"]').waitFor();
  });

  test('header shows an Open-in-GitHub link to the PR web page', async ({ page }) => {
    const link = page.locator('[data-testid="open-in-github-button"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveText(/Open in GitHub/);
    await expect(link).toHaveAttribute('href', /\/acme\/api\/pull\/123$/);
    await expect(link).toHaveAttribute('target', '_blank');
  });
});
