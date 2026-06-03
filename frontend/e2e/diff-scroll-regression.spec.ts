import { test, expect } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr, advanceHead } from './helpers/s4-setup';

// Regression guard for the side-by-side diff's horizontal scroll — #115 (the
// original locked-scroll feature), #149 (the first fix), and #155 (the real
// fix). The bug only manifests on a LARGE file (long lines + tall enough to
// overflow the viewport), which the canonical 8-line src/Calc.cs fixture
// cannot produce. So this spec INJECTS a wide+tall single-file diff at a fresh
// head via the existing /test/advance-head hook (FakePrReader.GetDiffAsync
// builds the diff straight from src/Calc.cs's content at the current head).
// Nothing in the canonical scenario or the parity baselines changes: every
// other spec's beforeEach calls /test/reset, which wipes this injected head.
//
// Two properties were broken before #155 and are guarded here:
//
//  B — STICKY SCROLLBAR. The viewport-height bounding that keeps the diff in
//      an internal scroll container (so the bottom-pinned synthetic h-scrollbar
//      stays on-screen) was gated to the Electron shell only. In the browser
//      the whole page grew to the file's height and the scrollbar fell far
//      below the fold. #155 scoped the same bounding to the PR-detail Files
//      view via `[data-app-shell]:has(.files-tab)`. Guard: the page does not
//      scroll vertically AND the scrollbar's bottom edge is within the viewport.
//
//  A — UNIFORM SHIFT. The locked-scroll offset used `text-indent`, which
//      rendered raggedly across variable-width `white-space: pre` lines in a
//      real browser (short lines barely moved, long lines slid). #155 replaced
//      it with `transform: translateX`, uniform by construction. The
//      real-browser raggedness did NOT reproduce in headless Chromium (a pure
//      geometry assertion could not distinguish the two mechanisms), so the
//      deterministic guard is the MECHANISM: at a non-zero scroll, every
//      content span carries the SAME translateX matrix and `text-indent: 0px`.
//      Reverting to text-indent makes transform `none` -> RED; breaking
//      lockstep makes the matrices diverge -> RED.

const VIEWPORT = { width: 1440, height: 900 };
const WIDE_SHA = '4444444444444444444444444444444444444444';

// A src/Calc.cs that overflows BOTH axes:
//  - LONG lines (~235 chars >> the ~680px split pane) so the synthetic
//    horizontal scrollbar appears (useLockedPaneScroll shows it only when
//    overflow > 0).
//  - MANY lines (>> the 900px viewport) so, absent the viewport bounding, the
//    page would grow tall and push the bottom-pinned scrollbar below the fold.
const LINE_COUNT = 120;
const WIDE_CONTENT =
  Array.from(
    { length: LINE_COUNT },
    (_, i) => `// line ${String(i).padStart(3, '0')} ${'verylongtoken_'.repeat(16)}end`,
  ).join('\n') + '\n';

test.describe('diff horizontal scroll regression (#115 / #149 / #155)', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetBackendState(request);
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);
    // Inject the wide+tall diff at a fresh head BEFORE the first PR-detail load,
    // so the Files tab fetches the diff at WIDE_SHA. advanceHead re-seeds the
    // active-PR cache to the new head, so the navigation below sees it
    // synchronously (no poller race).
    await advanceHead(page, WIDE_SHA, [{ path: 'src/Calc.cs', content: WIDE_CONTENT }]);
  });

  test('sticky scrollbar stays on-screen and all lines shift uniformly', async ({ page }) => {
    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();

    const diffPane = page.locator('[data-testid="diff-pane"]');
    await expect(diffPane).toHaveClass(/diff-pane--split/);

    const diff = page.locator('[data-testid="files-tab-diff"]');
    // All injected lines render as solo-insert rows (pure-insert vs empty base).
    // The last one settling signals the diff data is fully laid out.
    await diff
      .locator('tr.diff-line--insert')
      .nth(LINE_COUNT - 1)
      .waitFor();

    const bar = page.locator('[data-testid="diff-hscroll"]');
    // Shown only when the longest line overflows the pane (display toggled by
    // useLockedPaneScroll.measure()).
    await expect(bar).toBeVisible();

    // ---- B: sticky scrollbar is reachable without scrolling the file ----
    const layout = await page.evaluate(() => {
      const doc = document.documentElement;
      const scroller = document.querySelector('[data-app-scroll]') as HTMLElement | null;
      const barEl = document.querySelector('[data-testid="diff-hscroll"]') as HTMLElement;
      return {
        docVerticalOverflow: doc.scrollHeight - doc.clientHeight,
        appScrollVerticalOverflow: scroller ? scroller.scrollHeight - scroller.clientHeight : -1,
        barBottom: barEl.getBoundingClientRect().bottom,
        innerHeight: window.innerHeight,
      };
    });
    // The diff body scrolls INTERNALLY; the page itself must not scroll (that
    // is exactly what dropped the scrollbar below the fold before #155).
    expect(layout.docVerticalOverflow).toBeLessThanOrEqual(1);
    expect(layout.appScrollVerticalOverflow).toBeLessThanOrEqual(1);
    // Scrollbar's bottom edge is on-screen.
    expect(layout.barBottom).toBeLessThanOrEqual(layout.innerHeight + 1);

    // ---- A: scroll horizontally, then assert uniform transform-based shift ----
    const overflow = await bar.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeGreaterThan(50); // long lines genuinely overflow the pane
    const mid = Math.round(overflow / 2);
    await bar.evaluate((el, x) => {
      el.scrollLeft = x;
      el.dispatchEvent(new Event('scroll'));
    }, mid);

    // Wait (poll, never a fixed delay — Windows CI is slow) until the rAF write
    // has propagated the offset into the content spans' transform.
    await expect
      .poll(() =>
        diff
          .locator('td[data-side="new"] > span')
          .first()
          .evaluate((el) => {
            const m = getComputedStyle(el).transform.match(
              /matrix\(1, 0, 0, 1, (-?\d+(?:\.\d+)?), 0\)/,
            );
            return m ? Math.round(parseFloat(m[1])) : 0;
          }),
      )
      .toBeLessThan(-10); // a real leftward shift, applied via transform

    const spans = await diff.locator('td[data-side="new"]').evaluateAll((cells) =>
      cells
        .map((c) => c.firstElementChild as HTMLElement | null)
        .filter((el): el is HTMLElement => !!el && (el.textContent ?? '').length > 0)
        .map((el) => {
          const cs = getComputedStyle(el);
          const m = cs.transform.match(/matrix\(1, 0, 0, 1, (-?\d+(?:\.\d+)?), 0\)/);
          return { tx: m ? Math.round(parseFloat(m[1])) : null, textIndent: cs.textIndent };
        }),
    );

    expect(spans.length).toBeGreaterThan(20); // many visible lines measured

    // (A2 — mechanism) Every span shifts via transform, never via text-indent.
    for (const s of spans) {
      expect(s.tx).not.toBeNull();
      expect(s.textIndent).toBe('0px');
    }

    // (A1 — lockstep) Every line shifted by the SAME amount: short and long
    // lines move together (no raggedness).
    const distinctShifts = [...new Set(spans.map((s) => s.tx))];
    expect(distinctShifts).toHaveLength(1);
  });
});
