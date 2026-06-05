import { test, expect } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

// The hermetic acme/api/123 fixture is single-file (src/Calc.cs). This spec
// proves the CHROME; the view-wide cross-file property is covered by the
// deriveWholeFileEnabled unit test + the Task 8 manual check on a real PR.
test.describe('Diff settings menu (#185)', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetBackendState(request);
    await page.setViewportSize({ width: 1440, height: 900 }); // >=900 so Split is enabled
    await setupAndOpenScenarioPr(page);
    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();
  });

  test('inline tiles switch Split/Unified; gear toggles wrap; Escape returns focus', async ({
    page,
  }) => {
    const diffPane = page.locator('[data-testid="diff-pane"]');

    // Default mode is side-by-side (split). Confirm the starting state.
    await expect(diffPane).toHaveClass(/diff-pane--split/);

    // Click the label wrapping the Unified radio — the radio input itself is
    // clip-hidden (sr-only style), so we target the enclosing <label> element.
    // This is more robust than getByText('Unified', { exact: true }) which could
    // match header/tooltip text, and it avoids the "hidden element" click guard.
    await page.locator('label:has([data-testid="diff-view-unified"])').click();
    await expect(diffPane).toHaveClass(/diff-pane--unified/);

    await page.locator('label:has([data-testid="diff-view-split"])').click();
    await expect(diffPane).toHaveClass(/diff-pane--split/);

    // Gear opens; toggle Wrap + Show full file; Escape closes and returns focus.
    await page.getByTestId('diff-settings-trigger').click();
    await expect(page.getByTestId('diff-settings-panel')).toBeVisible();

    await page.getByTestId('line-wrap-checkbox').check();
    // show-full-file-checkbox: the acme/api/123 fixture is a small single-hunk
    // diff, so deriveWholeFileEnabled returns true and the checkbox is enabled.
    await page.getByTestId('show-full-file-checkbox').check();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('diff-settings-panel')).toBeHidden();
    // Focus must return to the gear trigger (DiffSettingsMenu's close() schedules
    // triggerRef.current?.focus() via setTimeout, so toHaveFocused polls).
    await expect(page.getByTestId('diff-settings-trigger')).toBeFocused();

    // The gear's modified indicator reflects the non-default settings (lineWrap
    // is non-default; showFullFile counts only when not view-blocked, which it
    // isn't on this small fixture).
    await expect(page.getByTestId('diff-settings-trigger')).toHaveAttribute(
      'aria-label',
      /modified/i,
    );
  });
});
