// frontend/e2e/pr-header-collapse.spec.ts
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

const VIEWPORT = { width: 1440, height: 900 };

test.describe('#128 collapsible PR header + toolbar trim', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetBackendState(request);
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);
    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-diff"]').waitFor();
  });

  test('chevron collapses/expands the meta and grows the diff', async ({ page }) => {
    const header = page.locator('[data-testid="pr-header"]');
    const toggle = page.locator('[data-testid="pr-header-collapse-toggle"]');
    const body = page.locator('.diff-pane-body');

    // Default = expanded.
    await expect(header).not.toHaveAttribute('data-collapsed', /.*/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const expandedH = await body.evaluate((el) => el.clientHeight);

    // Collapse.
    await toggle.click();
    await expect(header).toHaveAttribute('data-collapsed', 'true');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Read-once meta hidden; title still present.
    await expect(page.locator('[data-testid="pr-header"] .pr-meta-repo')).toBeHidden();
    await expect(page.locator('[data-testid="pr-title"]')).toBeVisible();

    // Diff body grew (poll to avoid layout-timing flake).
    await expect.poll(() => body.evaluate((el) => el.clientHeight)).toBeGreaterThan(expandedH);

    // Expand again restores.
    await toggle.click();
    await expect(header).not.toHaveAttribute('data-collapsed', /.*/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  test('collapsed state survives a sub-tab round-trip (per-PR session state)', async ({ page }) => {
    const header = page.locator('[data-testid="pr-header"]');
    await page.locator('[data-testid="pr-header-collapse-toggle"]').click();
    await expect(header).toHaveAttribute('data-collapsed', 'true');

    await page.locator('[data-testid="pr-tab-overview"]').click();
    await page.locator('[data-testid="pr-tab-files"]').click();

    // Same PrDetailView instance (keep-alive) → still collapsed.
    await expect(header).toHaveAttribute('data-collapsed', 'true');
  });

  test('the collapse toggle is a sibling of the sub-tab tablist, not a child', async ({ page }) => {
    const insideTablist = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="pr-header-collapse-toggle"]');
      return !!btn?.closest('[role="tablist"]');
    });
    expect(insideTablist).toBe(false);
  });

  test('no serious/critical a11y violations in expanded or collapsed state', async ({ page }) => {
    const analyze = async () => {
      const results = await new AxeBuilder({ page }).analyze();
      // Allow ONLY the pre-existing pr-tabstrip close-button violation (D104/#174).
      return results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .filter(
          (v) =>
            !(
              v.id === 'aria-required-children' &&
              v.nodes.length > 0 &&
              v.nodes.every((n) => n.html.includes('data-testid="pr-tabstrip"'))
            ),
        );
    };

    expect(await analyze(), 'expanded').toEqual([]);
    await page.locator('[data-testid="pr-header-collapse-toggle"]').click();
    await expect(page.locator('[data-testid="pr-header"]')).toHaveAttribute(
      'data-collapsed',
      'true',
    );
    expect(await analyze(), 'collapsed').toEqual([]);
  });

  test('toolbar is trimmed but keeps all controls', async ({ page }) => {
    const toolbarH = await page
      .locator('.files-tab-toolbar')
      .evaluate((el) => el.getBoundingClientRect().height);
    // Was ~77px. <60 holds for the canonical 3-iteration acme/api/123 fixture at
    // 1440px (single row). The toolbar has flex-wrap:wrap, so a much larger
    // iteration set could wrap to 2 rows and break this — acceptable given the
    // fixed hermetic fixture.
    expect(toolbarH).toBeLessThan(60);

    await expect(page.locator('[data-testid="whole-file-toggle"]')).toBeVisible();
    await expect(page.locator('[data-testid="line-wrap-toggle"]')).toBeVisible();
  });
});
