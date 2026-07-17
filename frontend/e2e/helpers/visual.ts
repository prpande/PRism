import {
  expect,
  test,
  type Locator,
  type Page,
  type PageAssertionsToHaveScreenshotOptions,
} from '@playwright/test';

// #751 — the single wrapper every visual assertion goes through. Canonical baselines
// live ONLY under e2e/__screenshots__/linux/: CI runs Playwright in the Linux container
// (.github/workflows/ci.yml), and no automation can ever verify a baseline rendered on
// another platform (or on a non-container Linux host, whose subpixel rendering differs
// from the runner's). Outside CI this skips JUST the screenshot assertion — annotated
// on the test so the skip is visible in the report — which removes any need for
// non-Linux baselines (#751 deletes the legacy win32/ set): a local run gets neither
// missing-snapshot failures nor silently written new PNGs, while every functional
// assertion in the same test keeps running. A CI run on a non-Linux platform is a pipeline misconfiguration, not a dev
// machine: it throws instead of skipping, so the visual suite can never go green while
// silently verifying nothing. Specs may keep their own coarser gates (test.skip(!CI)
// around whole visual describes); this guard is the floor, not a replacement for those.
export async function expectVisual(
  target: Page | Locator,
  name: string,
  options?: PageAssertionsToHaveScreenshotOptions,
): Promise<void> {
  if (!process.env.CI) {
    test.info().annotations.push({
      type: 'visual-skipped',
      description: `${name}: visual baselines are verified on CI (Linux) only (#751)`,
    });
    return;
  }
  if (process.platform !== 'linux') {
    throw new Error(
      `expectVisual(${name}): CI is running the visual suite on '${process.platform}', ` +
        'but canonical baselines are Linux-only (e2e/__screenshots__/linux/, #751). ' +
        'Fix the CI platform; do not add per-platform baselines.',
    );
  }
  await expect(target).toHaveScreenshot(name, options);
}
