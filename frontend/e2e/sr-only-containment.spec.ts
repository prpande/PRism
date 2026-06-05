import { test, expect } from '@playwright/test';

// Regression guard for #197: the global `.sr-only` utility must not be able to
// extend the document when it lives deep inside a tall, internally-scrolled view
// with no positioned ancestor.
//
// The bug: `.sr-only` is `position: absolute` with `top: auto`, so it takes its
// STATIC-FLOW position. Inside a tall scroller whose ancestor chain up to <html>
// is entirely `position: static`, the box's containing block is the initial
// containing block (<html>), so its deep static-Y extends
// `documentElement.scrollHeight` past the viewport — the whole page scrolls into
// empty space. The fix pins `.sr-only` to `top: 0; left: 0`, so the box sits at
// the origin of its containing block and can no longer contribute trailing
// overflow.
//
// Why a synthetic probe rather than the real PR-detail Files screen: reproducing
// the leak needs a file tree TALLER than the viewport, but the hermetic fake
// backend hard-codes a single changed file (`FakeReviewBackingStore.ChangedFiles
// = ["src/Calc.cs"]`), so the fake tree is always one row and its `.sr-only`
// status word sits near the top — it can't drive the leak. This probe builds the
// exact leak SHAPE (an `.sr-only` at a deep static position inside a short
// overflow pane) in a real browser, which is what makes `documentElement` grow.
// Reverting the fix (back to `top: auto`) makes `grew` ≈ the spacer height → RED.

const VIEWPORT = { width: 1024, height: 768 };
const SPACER_PX = 5000; // >> viewport, so a static-positioned box lands deep
const PANE_PX = 200; // short pane: clips the spacer internally, contributes only this

test('a visually-hidden .sr-only inside a tall static scroller cannot extend the page (#197)', async ({
  page,
}) => {
  await page.goto('/');
  // Wait until the global `.sr-only` rule is actually applied (tokens.css
  // loaded), independent of which screen the app routed to. The test only needs
  // the stylesheet — NOT any particular app state — so we probe the computed
  // `position` of a throwaway `.sr-only` element rather than waiting on a
  // screen-specific element (the app may land on Setup, Inbox, or a PR
  // depending on the seeded session — coupling to one of those screens is what
  // made an earlier revision time out under CI's authenticated `prod` project).
  await page.waitForFunction(
    () => {
      const el = document.createElement('span');
      el.className = 'sr-only';
      document.body.appendChild(el);
      const applied = getComputedStyle(el).position === 'absolute';
      el.remove();
      return applied;
    },
    null,
    { timeout: 30_000 },
  );
  await page.setViewportSize(VIEWPORT);

  const probe = await page.evaluate(
    ({ spacerPx, panePx }) => {
      const before = document.documentElement.scrollHeight;

      // A short, internally-scrolled pane with NO positioned ancestor — the
      // structural shape of the Files-tab file tree.
      const pane = document.createElement('div');
      pane.style.cssText = `height:${panePx}px;overflow-y:auto;`;
      // A tall flow inside it, clipped by the pane (so the spacer itself does
      // not extend the document).
      const spacer = document.createElement('div');
      spacer.style.height = `${spacerPx}px`;
      // The visually-hidden word, placed AFTER the spacer so its static-flow
      // position is ~spacerPx down — exactly like the deepest file row's status
      // word in a tall tree.
      const sr = document.createElement('span');
      sr.className = 'sr-only';
      sr.textContent = 'Modified';

      pane.appendChild(spacer);
      pane.appendChild(sr);
      document.body.appendChild(pane);

      // Reading scrollHeight forces a synchronous layout, so this measurement
      // reflects the appended subtree.
      const after = document.documentElement.scrollHeight;
      const srRect = sr.getBoundingClientRect();
      const srStyle = getComputedStyle(sr);

      const result = {
        grew: after - before,
        srTop: srRect.top,
        position: srStyle.position,
      };
      pane.remove();
      return result;
    },
    { spacerPx: SPACER_PX, panePx: PANE_PX },
  );

  // Guard against a vacuous pass: the `.sr-only` rule must actually be applied
  // (tokens.css loaded), otherwise the probe proves nothing.
  expect(probe.position).toBe('absolute');

  // The hardened utility adds at most the pane's own height to the document —
  // NOT the deep static spacer depth. With the bug, `grew` ≈ SPACER_PX. The +20
  // is slack for the pane's own border/margin and sub-pixel rounding.
  expect(probe.grew).toBeLessThanOrEqual(PANE_PX + 20);

  // And the box itself is pinned near the origin, not ~SPACER_PX down the page.
  expect(Math.abs(probe.srTop)).toBeLessThanOrEqual(50);
});
