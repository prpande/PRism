// PR8 Task 11 — Ask AI drawer e2e (real backend, FakeReviewService scenario PR).
//
// Covers the user-journey contract from PR8 plan § Task 11:
//   * Open drawer from the PR-header "Ask AI" button (requires aiPreview = true).
//   * Send a message → user bubble renders, typing indicator appears, canned
//     "AI isn't available right now." reply lands.
//   * Close + reopen on the same PR — thread survives.
//   * Navigate away from PR Detail (SPA route back to Inbox) — DrawerEffects
//     auto-closes the drawer.
//   * Navigate back to the same PR — drawer stays closed (no auto-reopen),
//     but on reopen the thread is preserved.
//
// aiPreview is enabled by POSTing the flat back-compat shape `{ aiPreview: true }`
// to /api/preferences (mirrors the production toggle path; see inbox.spec.ts
// "AI preview toggle reveals activity rail" at lines 270-305 for the same shape).
// A page.reload() after the POST forces usePreferences to refetch so
// AskAiButton becomes visible on PR Detail.
//
// Canned-reply timing: AskAiDrawerProvider replies on a 600ms timer (sendMessage
// in frontend/src/contexts/AskAiDrawerContext.tsx). 5_000ms toBeVisible polling
// gives ample headroom on Windows CI runners without baking in a fixed delay
// (per the windows-fixed-delay flake memo).

import { test, expect } from '@playwright/test';
import { setupAndOpenScenarioPr } from './helpers/s4-setup';

async function enableAiPreview(page: import('@playwright/test').Page): Promise<void> {
  const resp = await page.request.post('http://localhost:5180/api/preferences', {
    data: { aiPreview: true },
    headers: { Origin: 'http://localhost:5180' },
  });
  expect(resp.ok()).toBe(true);
}

test.describe('Ask AI drawer', () => {
  test('open, send, canned reply lands, preserved across close+reopen', async ({ page }) => {
    await setupAndOpenScenarioPr(page);
    await enableAiPreview(page);

    // Navigate to PR Detail and reload so usePreferences refetches the new
    // aiPreview value and AskAiButton becomes visible in the header.
    await page.goto('/pr/acme/api/123');
    await page.waitForSelector('[data-testid="pr-header"]');
    await page.reload();
    await page.waitForSelector('[data-testid="pr-header"]');

    const askAi = page.getByRole('button', { name: 'Ask AI' });
    await expect(askAi).toBeVisible();
    await askAi.click();

    const drawer = page.getByTestId('ask-ai-drawer');
    await expect(drawer).toHaveAttribute('aria-hidden', 'false');
    await expect(drawer.getByText('Ask anything about this PR.')).toBeVisible();

    // Submit a message. The textarea is aria-label="Message" (AskAiDrawer.tsx:127).
    const composer = drawer.getByRole('textbox', { name: 'Message' });
    await composer.fill('Why this change?');
    await drawer.getByRole('button', { name: 'Send' }).click();

    // User bubble renders immediately; typing indicator appears while the
    // 600ms canned-reply timer runs; canned reply lands within ~1s.
    await expect(drawer.getByText('Why this change?')).toBeVisible();
    await expect(drawer.getByTestId('ai-typing-indicator')).toBeVisible();
    await expect(drawer.getByText(/AI isn't available right now\./)).toBeVisible({
      timeout: 5_000,
    });

    // Close + reopen — thread persists in the provider (keyed by prRef).
    await drawer.getByRole('button', { name: /close ask ai drawer/i }).click();
    await expect(drawer).toHaveAttribute('aria-hidden', 'true');
    await askAi.click();
    await expect(drawer).toHaveAttribute('aria-hidden', 'false');
    await expect(drawer.getByText('Why this change?')).toBeVisible();
    await expect(drawer.getByText(/AI isn't available right now\./)).toBeVisible();
  });

  test('nav away from PR Detail auto-closes drawer; thread preserved on return', async ({
    page,
  }) => {
    await setupAndOpenScenarioPr(page);
    await enableAiPreview(page);

    await page.goto('/pr/acme/api/123');
    await page.waitForSelector('[data-testid="pr-header"]');
    await page.reload();
    await page.waitForSelector('[data-testid="pr-header"]');

    await page.getByRole('button', { name: 'Ask AI' }).click();
    const drawer = page.getByTestId('ask-ai-drawer');
    await expect(drawer).toHaveAttribute('aria-hidden', 'false');

    await drawer.getByRole('textbox', { name: 'Message' }).fill('preserved?');
    await drawer.getByRole('button', { name: 'Send' }).click();
    await expect(drawer.getByText('preserved?')).toBeVisible();
    await expect(drawer.getByText(/AI isn't available right now\./)).toBeVisible({
      timeout: 5_000,
    });

    // SPA-route nav to Inbox via the Header <Link>Inbox</Link> (NOT page.goto,
    // which would trigger a hard reload and wipe the in-memory provider state).
    // DrawerEffects' pathname-based auto-close should fire as pathname leaves
    // /pr/:owner/:repo/:number.
    await page.getByRole('link', { name: 'Inbox' }).click();
    await page.waitForURL((u) => u.pathname === '/');
    await expect(drawer).toHaveAttribute('aria-hidden', 'true');

    // Nav back to the same PR via the PrTabStrip tab (SPA route — preserves
    // the AskAiDrawerProvider thread state, which is keyed by prRef and lives
    // in React provider memory). A `page.goto()` here would hard-reload and
    // wipe the thread, which is the wrong contract — the spec is about
    // SPA-route preservation. The tab is rendered by PrTabStrip with a
    // `data-prref` attribute (PrTabStrip.tsx:144) keyed on prRefKey.
    await page.locator('[data-testid="pr-tabstrip"] [data-prref="acme/api/123"]').click();
    await page.waitForURL((u) => u.pathname === '/pr/acme/api/123');
    await page.waitForSelector('[data-testid="pr-header"]');
    await expect(drawer).toHaveAttribute('aria-hidden', 'true'); // No auto-reopen.

    await page.getByRole('button', { name: 'Ask AI' }).click();
    await expect(drawer).toHaveAttribute('aria-hidden', 'false');
    await expect(drawer.getByText('preserved?')).toBeVisible();
    await expect(drawer.getByText(/AI isn't available right now\./)).toBeVisible();
  });
});
