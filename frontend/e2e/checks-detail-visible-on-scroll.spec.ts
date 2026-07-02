import { test, expect, request } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

// ---------------------------------------------------------------------------
// #690 — Checks tab: the selected check's detail must stay visible even when the
// check list is long enough to overflow.
// ---------------------------------------------------------------------------
//
// Before the fix, the Checks master-detail was a plain flex row inside the
// bounded [data-subtab='checks'] slot: neither pane scrolled independently, so a
// long list grew the whole slot. Scrolling down to click a check near the bottom
// pushed the (top-aligned, non-pinned) detail pane off the top of the viewport —
// the click selected the check but its detail was drawn far above where the user
// was looking.
//
// The fix (#690, Option B) makes the list pane and detail pane each scroll
// INTERNALLY inside the slot: the list scrolls on the left while the detail stays
// put on the right. This test encodes that contract without depending on fixture
// volume, mirroring pr-detail-header-pinned.spec.ts's filler technique — but it
// forces the LIST PANE (not the slot) to overflow and asserts the overflow lands
// in the pane, leaving the slot unscrolled and the detail in view.
//
// prod project only — the dev project cannot run scenario specs
// (reference_dev_playwright_project_cant_run_scenario_specs).

const VIEWPORT = { width: 1280, height: 700 };

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await ctx.dispose();
});

test('#690 a long check list scrolls the list pane internally, keeping the detail in view', async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORT);
  await setupAndOpenScenarioPr(page);

  await page.goto('/pr/acme/api/123');
  await page.locator('[data-testid="pr-header"]').waitFor();
  await expect(page.locator('[data-testid="pr-title"]')).toHaveText('Calc utilities');

  await page.getByTestId('pr-tab-checks').click();

  const slot = page.locator('[data-subtab="checks"]:not([hidden])');
  const listPane = page.getByRole('listbox', { name: 'Checks' });
  // The detail region auto-selects the first row (build, failing) — aria-label='build'.
  const detail = page.getByRole('region', { name: 'build' });
  await expect(listPane).toBeVisible();
  await expect(detail).toBeVisible();

  // Force the LIST to overflow (independent of how many fixture checks exist):
  // append a tall filler as the last child of the list pane.
  await listPane.evaluate((el) => {
    const filler = document.createElement('div');
    filler.style.height = '3000px';
    filler.style.flex = 'none';
    filler.setAttribute('data-test-filler', '');
    el.appendChild(filler);
  });

  // 1) The list pane itself is the scroller that absorbed the overflow. With the
  //    bug (no internal pane scroll) the filler would grow the slot instead.
  await expect
    .poll(() => listPane.evaluate((el) => el.scrollHeight > el.clientHeight + 1))
    .toBe(true);

  // 2) The slot did NOT scroll — the overflow stayed inside the list pane, so the
  //    detail pane (the slot's other column) is never pushed off-screen. This is
  //    the assertion that fails on the pre-#690 layout.
  await expect.poll(() => slot.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);

  // 3) The document must not scroll either (the header stays pinned — #640).
  const docOverflow = await page.evaluate(
    () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
  );
  expect(docOverflow).toBeLessThanOrEqual(1);

  // 4) Scroll the list pane to the bottom, then confirm the detail is still within
  //    the slot's viewport (top-visible) — the core #690 guarantee.
  await listPane.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const [slotBox, detailBox] = await Promise.all([slot.boundingBox(), detail.boundingBox()]);
  expect(slotBox).not.toBeNull();
  expect(detailBox).not.toBeNull();
  // The detail's top sits within the slot's visible band (not scrolled above it).
  expect(detailBox!.y).toBeGreaterThanOrEqual(slotBox!.y - 1);
  expect(detailBox!.y).toBeLessThanOrEqual(slotBox!.y + slotBox!.height);
});
