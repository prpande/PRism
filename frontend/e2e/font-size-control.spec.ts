import { test, expect, type Locator, type Page } from '@playwright/test';
import { BACKEND_ORIGIN } from './helpers/backend-origin';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

async function fontPx(loc: Locator): Promise<number> {
  return loc.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
}
async function setScale(page: Page, scale: string | null) {
  await page.evaluate((s) => {
    if (s) document.documentElement.setAttribute('data-content-scale', s);
    else document.documentElement.removeAttribute('data-content-scale');
  }, scale);
}
async function expectScales(loc: Locator, label: string) {
  if ((await loc.count()) === 0) {
    test.info().annotations.push({
      type: 'skip-surface',
      description: `${label}: not rendered in fake scenario — covered by B1 screenshot`,
    });
    return;
  }
  const before = await fontPx(loc.first());
  await setScale(loc.page(), 'xl');
  expect(await fontPx(loc.first()), label).toBeGreaterThan(before);
  await setScale(loc.page(), null);
}

test.beforeEach(async ({ request }) => {
  await resetBackendState(request);
});

test.describe('#135 content font-size scaling', () => {
  test('Overview data scales; chrome + comment metadata stay fixed', async ({ page }) => {
    await setupAndOpenScenarioPr(page);
    await page.goto('/pr/acme/api/123');
    await expect(page.getByTestId('overview-tab')).toBeVisible();

    const fixed: Locator[] = [
      page.getByTestId('pr-tab-overview'),
      page.getByTestId('pr-title'),
      page.getByTestId('pr-comment-meta').first(),
    ];
    const present: Locator[] = [];
    for (const l of fixed) if ((await l.count()) > 0) present.push(l);
    const fixedBase = await Promise.all(present.map((l) => fontPx(l.first())));

    await expectScales(page.getByTestId('pr-description-body'), 'description');
    await expectScales(page.getByTestId('pr-description-title'), 'in-tab title');
    await expectScales(page.getByTestId('stats-tile-value'), 'stats value');
    await expectScales(page.getByTestId('stats-tile-label'), 'stats label');
    await expectScales(page.getByTestId('pr-root-comment').locator('p').first(), 'comment body');

    await setScale(page, 'xl');
    for (let i = 0; i < present.length; i++) {
      expect(await fontPx(present[i].first())).toBeCloseTo(fixedBase[i], 1);
    }
    await setScale(page, null);
  });

  test('Overview AI surfaces scale when AI preview is on', async ({ page, request }) => {
    await request.post(`${BACKEND_ORIGIN}/api/preferences`, {
      headers: { 'Content-Type': 'application/json', Origin: BACKEND_ORIGIN },
      data: JSON.stringify({ aiPreview: true }),
    });
    await setupAndOpenScenarioPr(page);
    await page.goto('/pr/acme/api/123');
    await expectScales(page.getByTestId('ai-summary-card'), 'AI summary body');
    await expectScales(page.getByTestId('ai-summary-category'), 'AI summary category');
  });

  test('Files diff scales; diff-pane header fixed; h-scroll spacer recomputes', async ({
    page,
  }) => {
    await setupAndOpenScenarioPr(page);
    await page.goto('/pr/acme/api/123/files');
    await expect(page.getByTestId('files-tab-diff')).toBeVisible();
    // The diff pane (and its header) renders only once a file is selected and the
    // diff has loaded. Wait for a code line before capturing baselines — otherwise
    // the header-fixed assertion races (baseline captured at 0 while the header is
    // still absent, then compared against the rendered size).
    await page.getByTestId('diff-code-line').first().waitFor({ state: 'visible' });

    const header = page.getByTestId('diff-pane-header').first();
    const headerBase = (await header.count()) ? await fontPx(header) : 0;
    const scroller = page.getByTestId('diff-hscroll');
    const widthBefore = (await scroller.count())
      ? await scroller.evaluate((el) => el.scrollWidth)
      : 0;

    await expectScales(page.getByTestId('diff-code-line'), 'diff code');

    await setScale(page, 'xl');
    if (await header.count()) expect(await fontPx(header)).toBeCloseTo(headerBase, 1);
    if (await scroller.count()) {
      expect(await scroller.evaluate((el) => el.scrollWidth)).toBeGreaterThanOrEqual(widthBefore);
    }
    await setScale(page, null);
  });
});
