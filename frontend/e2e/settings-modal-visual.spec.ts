import { test, expect } from '@playwright/test';

const THEMES = [
  { theme: 'light', radio: 'Light' },
  { theme: 'dark', radio: 'Dark' },
] as const;

async function setTheme(page, radioName: string) {
  await page.goto('/settings/appearance');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.getByRole('radio', { name: radioName }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', radioName.toLowerCase());
}

for (const { theme, radio } of THEMES) {
  test(`settings modal — appearance (${theme})`, async ({ page }) => {
    await setTheme(page, radio);
    await expect(page).toHaveScreenshot(`settings-appearance-${theme}.png`);
  });

  test(`settings modal — github connection (${theme})`, async ({ page }) => {
    await setTheme(page, radio);
    await page.getByRole('link', { name: 'GitHub Connection' }).click();
    await expect(page.getByRole('heading', { name: 'GitHub Connection' })).toBeVisible();
    await expect(page).toHaveScreenshot(`settings-ghc-${theme}.png`);
  });
}

test('settings modal — narrow viewport collapses the nav', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await page.goto('/settings/appearance');
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  await expect(page).toHaveScreenshot('settings-narrow.png');
});
