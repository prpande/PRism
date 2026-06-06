import { test, expect, type Page } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

// Regression guard for the file-tree's synthetic horizontal scrollbar — #214. The tree
// overflows horizontally on long file PATHS (not file content), which the canonical
// single short path `src/Calc.cs` cannot produce. So this spec seeds extra long-path
// files via /test/seed-tree-files (FakePrReader.GetDiffAsync appends them as trivial
// FileChanges). /test/reset (each beforeEach) clears them, so no other spec is affected.
//
// What was broken before #214 and is guarded here:
//
//  - REACHABILITY. The native horizontal scrollbar sat at the bottom of the entire tree
//    CONTENT (the tree grows to full height; the outer pane owns vertical scroll), so it
//    fell below the fold whenever the tree was taller than the viewport. #214 replaces it
//    with a synthetic bar pinned (position: sticky) to the bottom of the visible pane.
//    Guard: the bar's bottom edge is within the viewport without scrolling the tree, and
//    the page itself does not scroll vertically.
//
//  - SYNC (no drift). The bar's scrollLeft drives `--file-tree-hscroll`, which
//    .fileTreeInner reads via `transform: translateX`. Guard: at a non-zero scroll the
//    inner carries a real negative translateX (DOMMatrix m41), while the static checkbox
//    column's x stays constant (the #187 invariant).

const VIEWPORT = { width: 1440, height: 900 };

// Long leaf names so each row far exceeds the ~240–320px tree column; many of them so the
// tree is also taller than the pane (forcing the below-the-fold native-scrollbar bug the
// synthetic bar fixes).
const WIDE_FILES = Array.from(
  { length: 40 },
  (_, i) =>
    `src/AReallyExtraordinarilyLongFileNameThatExceedsTheTreeColumnWidthForScrollTesting${String(i).padStart(2, '0')}.tsx`,
);

async function seedTreeFiles(page: Page, paths: string[]): Promise<void> {
  const resp = await page.request.post('/test/seed-tree-files', {
    data: { paths },
    headers: { Origin: 'http://localhost:5180' },
  });
  if (!resp.ok()) {
    throw new Error(`/test/seed-tree-files failed: ${resp.status()} ${await resp.text()}`);
  }
}

test.describe('file-tree horizontal scroll (#214)', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetBackendState(request);
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);
  });

  test('sticky scrollbar is reachable without scrolling the tree, and rows shift in sync', async ({
    page,
  }) => {
    await seedTreeFiles(page, WIDE_FILES);
    await page.goto('/pr/acme/api/123/files');

    const tree = page.locator('[data-testid="files-tab-tree"]');
    await tree.locator('[data-testid="files-tab-tree-row"]').first().waitFor();

    const bar = page.locator('[data-testid="file-tree-hscroll"]');
    // Shown only when the tree overflows horizontally (display toggled by the hook).
    await expect(bar).toBeVisible();

    // ---- REACHABILITY: bar on-screen without scrolling the tree, page doesn't scroll ----
    const layout = await page.evaluate(() => {
      const doc = document.documentElement;
      const treeEl = document.querySelector('[data-testid="files-tab-tree"]') as HTMLElement;
      const barEl = document.querySelector('[data-testid="file-tree-hscroll"]') as HTMLElement;
      return {
        docVerticalOverflow: doc.scrollHeight - doc.clientHeight,
        treeVerticalOverflow: treeEl.scrollHeight - treeEl.clientHeight,
        barBottom: barEl.getBoundingClientRect().bottom,
        innerHeight: window.innerHeight,
      };
    });
    // The tree pane genuinely overflows vertically (otherwise this spec proves nothing —
    // a short tree shows the bar trivially).
    expect(layout.treeVerticalOverflow).toBeGreaterThan(0);
    // The page itself must not scroll (that is what dropped the native scrollbar below the
    // fold before #214).
    expect(layout.docVerticalOverflow).toBeLessThanOrEqual(1);
    // The bar's bottom edge is on-screen — reachable without scrolling the tree to its end.
    expect(layout.barBottom).toBeLessThanOrEqual(layout.innerHeight + 1);

    // ---- SYNC: scroll the bar, assert translateX on the inner + constant checkbox x ----
    const checkXBefore = await page.evaluate(() => {
      const slot = document.querySelector('.file-tree-check-col')?.firstElementChild as HTMLElement;
      return slot.getBoundingClientRect().x;
    });

    const overflow = await bar.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeGreaterThan(50); // long names genuinely overflow the column
    const mid = Math.round(overflow / 2);
    await bar.evaluate((el, x) => {
      el.scrollLeft = x;
      el.dispatchEvent(new Event('scroll'));
    }, mid);

    // Poll (never a fixed delay — Windows CI is slow) until the rAF write propagates the
    // offset into the inner's transform.
    await expect
      .poll(
        () =>
          page.locator('.file-tree-inner').evaluate((el) => {
            const t = getComputedStyle(el).transform;
            return t === 'none' ? 0 : Math.round(new DOMMatrixReadOnly(t).m41);
          }),
        { timeout: 15000 },
      )
      .toBeLessThan(-10); // a real leftward shift, applied via transform

    // The static checkbox column never moves horizontally (the #187 invariant).
    const checkXAfter = await page.evaluate(() => {
      const slot = document.querySelector('.file-tree-check-col')?.firstElementChild as HTMLElement;
      return slot.getBoundingClientRect().x;
    });
    expect(Math.abs(checkXAfter - checkXBefore)).toBeLessThanOrEqual(1);
  });

  test('bar is hidden (nothing pinned at the pane bottom) when the tree fits horizontally', async ({
    page,
  }) => {
    // No seed: the canonical scenario has a single short path (src/Calc.cs) that never
    // overflows the tree column. Criterion 5 — the bar appears ONLY on overflow.
    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-tree-row"]').first().waitFor();

    const bar = page.locator('[data-testid="file-tree-hscroll"]');
    // The element is always in the DOM; the footer ROW is display:none when it fits, so
    // neither the bar nor its 1px top border is pinned at the pane bottom.
    await expect(bar).not.toBeVisible();
    const rowDisplay = await page
      .locator('.file-tree-hscroll-row')
      .evaluate((el) => getComputedStyle(el).display);
    expect(rowDisplay).toBe('none');
  });

  test('bar shows and stays on-screen for a horizontally-overflowing but vertically-short tree', async ({
    page,
  }) => {
    // Edge case (spec adversarial review A5): one very long path, few files — overflows
    // horizontally but not vertically.
    await seedTreeFiles(page, [WIDE_FILES[0]]);
    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-tree-row"]').first().waitFor();

    const bar = page.locator('[data-testid="file-tree-hscroll"]');
    await expect(bar).toBeVisible();

    const shape = await page.evaluate(() => {
      const treeEl = document.querySelector('[data-testid="files-tab-tree"]') as HTMLElement;
      const barEl = document.querySelector('[data-testid="file-tree-hscroll"]') as HTMLElement;
      return {
        treeVerticalOverflow: treeEl.scrollHeight - treeEl.clientHeight,
        barBottom: barEl.getBoundingClientRect().bottom,
        innerHeight: window.innerHeight,
      };
    });
    // Genuinely short (little/no vertical overflow), yet the bar is present and on-screen
    // (no dead gap below the fold).
    expect(shape.treeVerticalOverflow).toBeLessThanOrEqual(1);
    expect(shape.barBottom).toBeLessThanOrEqual(shape.innerHeight + 1);
  });
});
