import { test, expect } from '@playwright/test';

// Regression guard for #205: the Setup / Connect-to-GitHub screen must not
// scroll the page. Its only content is a single centered card, but
// `SetupPage.module.css .screen { min-height: 100vh }` sat BELOW the ~48px
// header, so `header + 100vh` overflowed the viewport by exactly the header
// height → the document scrolled into ~48px of empty space. The fix makes
// `.screen` fill only the space under the header
// (`min-height: calc(100dvh - var(--header-h))`), so the page never scrolls.
//
// Unlike the #197 sr-only guard, this exercises the REAL screen: the Setup
// route renders `SetupPage` unconditionally, so it is hermetic (no backend
// data needed). The viewport is deliberately tall enough that the card itself
// fits, so any vertical overflow is the `100vh` artifact, not real content.

const VIEWPORT = { width: 1280, height: 900 };

test('the Setup screen does not scroll the page (#205)', async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto('/setup');
  // Wait for the card (rendered once authState resolves and the LoadingScreen
  // is gone), independent of connect-vs-replace mode.
  await page.locator('[data-testid="setup-card"]').waitFor({ timeout: 30_000 });

  const layout = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      pageOverflow: doc.scrollHeight - doc.clientHeight,
      scrollHeight: doc.scrollHeight,
      innerHeight: window.innerHeight,
    };
  });

  // The page must not have a vertical scroll on the Setup screen (the card fits
  // comfortably under the header at this viewport). With the bug, pageOverflow
  // ≈ the header height (~48px).
  expect(layout.pageOverflow).toBeLessThanOrEqual(1);
});
