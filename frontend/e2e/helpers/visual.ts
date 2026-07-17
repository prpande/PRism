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
// from the runner's). Outside CI-on-Linux this skips JUST the screenshot assertion —
// annotated on the test so the skip is visible in the report — which is what lets the
// repo carry no win32/ baselines at all: a Windows run gets neither missing-snapshot
// failures nor silently written new PNGs, while every functional assertion in the same
// test keeps running. Specs may keep their own coarser gates (test.skip(!CI) around
// whole visual describes); this guard is the floor, not a replacement for those.
export async function expectVisual(
  target: Page | Locator,
  name: string,
  options?: PageAssertionsToHaveScreenshotOptions,
): Promise<void> {
  if (!process.env.CI || process.platform !== 'linux') {
    test.info().annotations.push({
      type: 'visual-skipped',
      description: `${name}: visual baselines are CI-on-Linux only (#751)`,
    });
    return;
  }
  await expect(target).toHaveScreenshot(name, options);
}
