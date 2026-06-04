import { test, expect, type Route } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr, advanceHead } from './helpers/s4-setup';

// ---------------------------------------------------------------------------
// Task 11 — Visual verification spec for diff-pane syntax highlighting.
//
// All four cases run against the fake Test-env backend (acme/api/123), which
// returns a single-file diff for "src/Calc.cs". advanceHead injects a fresh
// file body, so the fake GetDiffAsync renders the changed lines as SOLO `+`
// inserts (not paired delete/insert) — solo lines carry no `.wordDiffInsertBg`
// (that background only applies to paired lines via MergedPairedContent). The
// paired word-diff backgrounds are covered by the vitest component test
// (DiffPane.highlight.test.tsx asserts both wordDiffInsertBg + wordDiffDeleteBg)
// and by the real-app B1 screenshot pass. Here we assert the deterministic,
// backend-independent observables: that `.codeToken` spans render (highlighting
// active), that the dual-theme --shiki-light var resolves, that an unsupported
// extension yields no tokens, and that the large-file guard suppresses + shows
// the indicator.
//
// Theme is toggled by writing `document.documentElement.dataset.theme`
// directly via page.evaluate — the app reads this attribute to pick
// --shiki-light vs --shiki-dark CSS vars, and applyThemeToDocument() writes
// the same attribute. Driving the Settings-page UI control would add ~3 extra
// navigations per test that buy nothing for a visual-verification spec.
//
// Screenshots write to each test's Playwright output dir via
// test.info().outputPath(...) (already gitignored under test-results/).
//
// Edge cases 3 & 4 from the plan (block-comment-crossing-hunk-edge and
// unified-whole-file-delete-at-boundary) are deferred:
// TODO(visual): edge cases 3/4 from plan covered manually in the B1 screenshot pass
// ---------------------------------------------------------------------------

const VIEWPORT = { width: 1440, height: 900 };

// Unique SHAs so each advanceHead call is distinguishable from the canonical
// Sha1/Sha2/Sha3 fixture and from each other.
const DARK_SHA = 'aaaa0000000000000000000000000000000000aa';
const LIGHT_SHA = 'bbbb0000000000000000000000000000000000bb';
const LARGE_SHA = 'cccc0000000000000000000000000000000000cc';

// A short, valid TypeScript snippet. The fake backend wraps it in SOLO `+`
// insert lines, so this exercises the context/solo-insert highlight path only:
// each line gets colored `.codeToken` spans. It does NOT exercise paired
// word-diff backgrounds (`.wordDiffInsertBg` applies only to paired delete/
// insert lines via MergedPairedContent — see the header comment), so this spec
// asserts token presence + theme-var resolution, not the word-diff background.
const TS_CONTENT = [
  'const count = 1;',
  'const greeting = "hello";',
  'const done = true;',
  'export { count, greeting, done };',
].join('\n');

// 2001 lines of valid C# — trips the MAX_FILE_LINES = 2000 guard in
// useSyntaxTokens.mapHunks / tooLarge(). Using C# (matching the fake
// backend's src/Calc.cs path → csharp grammar) so pathToLang returns non-null,
// which is required for highlightSuppressed to become true (the guard reads:
// pathToLang(selectedPath) !== null AND syntax maps are empty).
const LARGE_CONTENT = Array.from(
  { length: 2001 },
  (_, i) => `// line ${String(i).padStart(4, '0')}`,
).join('\n');

test.describe('Syntax highlighting — diff pane visual verification', () => {
  test.beforeEach(async ({ page, request: _req }) => {
    await resetBackendState(_req);
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);
  });

  // -------------------------------------------------------------------------
  // Case 1: Dark theme — verify .codeToken spans render with dark-theme color.
  // The injected lines render as solo inserts (no paired word-diff), so we
  // assert highlighting is active (.codeToken present) and that the dark
  // --shiki-dark var resolves. Word-diff backgrounds are covered elsewhere
  // (see header comment).
  // -------------------------------------------------------------------------
  test('dark theme: codeToken spans render with active --shiki-dark color', async ({ page }) => {
    await advanceHead(page, DARK_SHA, [{ path: 'src/Calc.cs', content: TS_CONTENT }]);

    // Ensure dark theme is active before navigating to the diff view.
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });

    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();

    // Wait up to 30s for Shiki to warm up and produce .codeToken spans.
    await expect(page.locator('.codeToken').first()).toBeVisible({ timeout: 30_000 });

    // The dual-theme --shiki-dark var should resolve to a non-empty value.
    const darkColor = await page
      .locator('.codeToken')
      .first()
      .evaluate((el) => window.getComputedStyle(el).getPropertyValue('--shiki-dark').trim());
    expect(darkColor).not.toBe('');

    await page.screenshot({ path: test.info().outputPath('syntax-dark.png'), fullPage: false });
  });

  // -------------------------------------------------------------------------
  // Case 2: Light theme — toggle after dark-theme navigation.
  // Assert .codeToken still renders and that the --shiki-light CSS variable is
  // active (getComputedStyle resolves a non-empty color).
  // -------------------------------------------------------------------------
  test('light theme: codeToken renders with active --shiki-light color', async ({ page }) => {
    await advanceHead(page, LIGHT_SHA, [{ path: 'src/Calc.cs', content: TS_CONTENT }]);

    // Start in dark, then switch to light so we verify the theme-switch path.
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });

    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();

    // Wait for at least one codeToken to exist before toggling theme.
    await expect(page.locator('.codeToken').first()).toBeVisible({ timeout: 30_000 });

    // Toggle to light theme.
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });

    // Token should still be visible after the theme flip.
    await expect(page.locator('.codeToken').first()).toBeVisible({ timeout: 10_000 });

    // The --shiki-light CSS variable should resolve to a non-empty value on the
    // first token. An empty string means the variable isn't being applied (the
    // light theme branch isn't active), which would be a regression.
    const lightColor = await page
      .locator('.codeToken')
      .first()
      .evaluate((el) => {
        return window.getComputedStyle(el).getPropertyValue('--shiki-light').trim();
      });
    expect(lightColor).not.toBe('');

    await page.screenshot({ path: test.info().outputPath('syntax-light.png'), fullPage: false });
  });

  // -------------------------------------------------------------------------
  // Case 3: Unknown-extension file — pathToLang returns null → plain fallback.
  // The fake backend always returns "src/Calc.cs"; override the diff endpoint
  // via page.route to inject a file with the .zzz extension instead.
  // Assert: no .codeToken spans are rendered (clean plain-text fallback).
  // -------------------------------------------------------------------------
  test('unknown extension: no codeToken spans (plain fallback)', async ({ page }) => {
    // Intercept the diff endpoint so the diff path is "notes.zzz" — an
    // extension not in EXT_TO_LANG, which makes pathToLang return null.
    const plainDiff = {
      range: 'abc..def',
      truncated: false,
      files: [
        {
          path: 'notes.zzz',
          status: 'modified',
          hunks: [
            {
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 3,
              body: '@@ -1,2 +1,3 @@\n some plain text here\n-old line to replace\n+new line added\n+another new line',
            },
          ],
        },
      ],
    };
    await page.route('**/api/pr/acme/api/123/diff**', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(plainDiff),
      }),
    );

    await page.goto('/pr/acme/api/123/files');
    // With a routed diff, the file tree renders the .zzz file — click its row.
    await page
      .locator('[data-testid="files-tab-tree-row"][data-path="notes.zzz"]')
      .click({ timeout: 15_000 });

    // Wait for the diff pane to settle (diff-pane container visible).
    await expect(page.locator('[data-testid="diff-pane"]')).toBeVisible({ timeout: 15_000 });

    // Give any async Shiki path a chance to fire (shouldn't, since lang=null).
    // Poll with a brief ceiling rather than a fixed sleep (Windows CI contention).
    await expect.poll(() => page.locator('.codeToken').count(), { timeout: 5_000 }).toBe(0);

    await page.screenshot({ path: test.info().outputPath('syntax-plain.png'), fullPage: false });
  });

  // -------------------------------------------------------------------------
  // Case 4: Large file — trips the MAX_FILE_LINES (2000) guard.
  // Assert: "Syntax highlighting off (large file)" header is visible and
  // .codeToken count is 0 (suppressed, not merely pending).
  // -------------------------------------------------------------------------
  test('large file: suppression indicator visible, no codeToken spans', async ({ page }) => {
    await advanceHead(page, LARGE_SHA, [{ path: 'src/Calc.cs', content: LARGE_CONTENT }]);

    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();

    // The suppression indicator appears after Shiki warms up (syntax.ready =
    // true) and the token maps are still empty. Wait generously.
    await expect(page.getByText(/Syntax highlighting off \(large file\)/)).toBeVisible({
      timeout: 30_000,
    });

    // No codeToken spans should exist — the highlight path was skipped entirely.
    expect(await page.locator('.codeToken').count()).toBe(0);

    await page.screenshot({ path: test.info().outputPath('syntax-large.png'), fullPage: false });
  });
});
