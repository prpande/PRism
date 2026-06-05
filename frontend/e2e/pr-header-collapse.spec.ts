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

    // #203 point-toward-action convention: the glyph is authored pointing UP and
    // carries NO rotation while expanded (clicking folds content up). The CSS
    // rotation lives only in the stylesheet, so this is asserted in a real
    // browser (jsdom can't compute it). Guards against a future "fix" that
    // flips the convention back — see #203.
    const chevron = toggle.locator('svg');
    await expect(chevron.locator('path').first()).toHaveAttribute('d', 'M4 7l4-4 4 4');
    const expandedTransform = await chevron.evaluate((el) => getComputedStyle(el).transform);
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(expandedTransform);

    const expandedH = await body.evaluate((el) => el.clientHeight);

    // Collapse.
    await toggle.click();
    await expect(header).toHaveAttribute('data-collapsed', 'true');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Collapsed: the same up-glyph is rotated 180° to point DOWN (clicking drops
    // content down). matrix(-1, 0, 0, -1, 0, 0) === rotate(180deg).
    await expect
      .poll(() => chevron.evaluate((el) => getComputedStyle(el).transform))
      .toBe('matrix(-1, 0, 0, -1, 0, 0)');

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
    // Scope the audit to the PR header region. #128's only new a11y surface is the
    // collapse chevron + the reflowed header, so we test exactly that. Two
    // pre-existing, separately-tracked issues live OUTSIDE this region and would
    // otherwise add noise: the top-level pr-tabstrip aria-required-children
    // violation (#174, outside pr-header) and the diff-hunk-header color-contrast
    // violation (#177, in the diff body). The full-page Files surface is already
    // axe-audited in a11y-audit.spec.ts; here we guarantee collapsing the header
    // introduces nothing serious/critical of its own.
    const analyze = async () => {
      const results = await new AxeBuilder({ page }).include('[data-testid="pr-header"]').analyze();
      return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
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

    // The old individual button toggles are gone; the toolbar now renders an
    // inline DiffViewToggle (segmented radio control) and a DiffSettingsMenu
    // gear that houses line-wrap + show-full-file. Assert both are present so
    // the test still verifies "all controls are in the trimmed toolbar".
    await expect(page.locator('[data-testid="diff-view-split"]')).toBeVisible();
    await expect(page.locator('[data-testid="diff-settings-trigger"]')).toBeVisible();
  });
});
