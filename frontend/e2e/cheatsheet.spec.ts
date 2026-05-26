import { test, expect, type Page } from '@playwright/test';

// The cheatsheet provider is mounted at App root, so we exercise its behavior
// on any page. /setup is the cheapest landing page (no auth or data mocks
// needed — cold-start.spec.ts uses the same pattern). For composer-context
// tests we inject a stub composer wrapper via page.evaluate: the spec under
// test is the hook's focus-routing rule (`data-composer="true"` ancestor
// detection + capture-phase Esc), not the composer's own state machine, so a
// real Composer mount would just add fixture overhead without changing what's
// asserted.

async function gotoBaseline(page: Page) {
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: /connect to github/i })).toBeVisible({
    timeout: 30_000,
  });
}

async function injectComposerStub(page: Page, opts?: { id?: string }) {
  const id = opts?.id ?? 'composer-stub';
  await page.evaluate((stubId) => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-composer', 'true');
    wrapper.style.position = 'fixed';
    wrapper.style.bottom = '24px';
    wrapper.style.left = '24px';
    wrapper.style.zIndex = '500';
    const ta = document.createElement('textarea');
    ta.id = stubId;
    ta.setAttribute('data-testid', stubId);
    ta.rows = 4;
    ta.cols = 40;
    wrapper.appendChild(ta);
    document.body.appendChild(wrapper);
  }, id);
  return page.locator(`[data-testid="${id}"]`);
}

test.describe('Cheatsheet', () => {
  test('pressing ? outside a text-editing context opens the overlay', async ({ page }) => {
    await gotoBaseline(page);

    // Move focus away from the PAT input (which is a text-editing context).
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    // Belt-and-braces: blur whatever may have grabbed focus from the click.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    await page.keyboard.press('?');

    await expect(page.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeVisible();
  });

  test('pressing ? inside a composer textarea types a literal ? and does NOT open the overlay', async ({
    page,
  }) => {
    await gotoBaseline(page);
    const textarea = await injectComposerStub(page);
    await textarea.focus();

    await page.keyboard.press('?');

    await expect(page.getByRole('dialog', { name: /keyboard shortcuts/i })).toHaveCount(0);
    await expect(textarea).toHaveValue('?');
  });

  test('Cmd/Ctrl+/ inside a composer textarea opens the overlay; composer text is preserved', async ({
    page,
  }) => {
    await gotoBaseline(page);
    const textarea = await injectComposerStub(page);
    await textarea.focus();
    await textarea.fill('hello world');

    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+/`);

    await expect(page.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeVisible();
    // The `/` keystroke must NOT have been delivered to the textarea — capture-
    // phase preventDefault() suppresses it before React's onChange would fire.
    await expect(textarea).toHaveValue('hello world');
  });

  test('Esc closes the overlay without prompting an open composer for discard', async ({
    page,
  }) => {
    await gotoBaseline(page);
    const textarea = await injectComposerStub(page);
    await textarea.focus();
    await textarea.fill('draft text');

    // Open the overlay via Cmd/Ctrl+/ from the composer (composer keeps text).
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+/`);
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Composer text untouched.
    await expect(textarea).toHaveValue('draft text');
  });

  test('clicking the × close button closes the overlay', async ({ page }) => {
    await gotoBaseline(page);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByRole('button', { name: /close cheatsheet/i }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('Cmd/Ctrl+R with the overlay open reloads the page and the overlay is closed afterwards', async ({
    page,
  }) => {
    await gotoBaseline(page);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog')).toBeVisible();

    // Cmd/Ctrl+R is intentionally NOT intercepted — the browser's reload runs.
    // We trigger a navigation reload directly (more reliable than synthesising
    // the keyboard shortcut, which Playwright cannot reliably hand off to the
    // browser's UA-level reload). The Cmd/Ctrl+R PASS-THROUGH contract is
    // unit-tested in useCheatsheetShortcut.test.tsx ('Cmd/Ctrl+R is NOT
    // intercepted').
    await page.reload();
    await expect(page.getByRole('heading', { name: /connect to github/i })).toBeVisible({
      timeout: 30_000,
    });

    // Overlay is React-state-only (`useState(false)`); a reload re-mounts the
    // tree, so the panel should not be visible. Document-level listener is
    // also re-bound from scratch — no leaked handler.
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
