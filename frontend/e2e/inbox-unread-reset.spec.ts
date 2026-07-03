import { test, expect } from '@playwright/test';
import { BACKEND_ORIGIN } from './helpers/backend-origin';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

// #285 — the inbox row's left "new changes" bar must clear after the user opens the PR
// and returns to the inbox, without a manual reload. Real backend: /test/seed-inbox puts
// the canonical scenario PR (acme/api/123 "Calc utilities") in "Review requested" unread.
test.describe('inbox unread bar resets on view (#285)', () => {
  test.beforeEach(async ({ request }) => {
    await resetBackendState(request);
  });

  test('opening the PR and returning clears the row unread bar', async ({ page, request }) => {
    // #704: raise this test's budget from Playwright's 30s default. The final assertion below
    // waits up to 15s to ride out the load that makes this flaky, and `row.waitFor` already
    // allows up to 30s for the seeded inbox to render under that same load — under a saturated
    // CI runner those could otherwise sum past 30s and convert a slow-but-correct clear into a
    // hard test-timeout. 60s leaves ample headroom without masking a genuinely stuck state.
    test.setTimeout(60_000);

    // #704 (local-repro unblock): on a reused local server (`reuseExistingServer`), the
    // best-effort `ui.ai.onboardingSeen=true` patch in resetBackendState doesn't always
    // take, so the #485 AI onboarding dialog's modal-backdrop intercepts the row click at
    // ":row.click". Auto-dismiss it via Escape whenever it appears (Modal has onClose={onEsc},
    // no disableEscDismiss, so Escape closes it mode-agnostically). No-op on CI where the
    // patch takes and the dialog never renders.
    await page.addLocatorHandler(
      page.getByRole('dialog', { name: 'Set up AI for your reviews' }),
      async () => {
        await page.keyboard.press('Escape');
      },
    );

    // Populate the real-backend inbox with the scenario PR (review-requested, unread).
    const seed = await request.post(`${BACKEND_ORIGIN}/test/seed-inbox`, {
      headers: { Origin: BACKEND_ORIGIN },
    });
    expect(seed.ok()).toBeTruthy();

    await setupAndOpenScenarioPr(page); // auths, lands on '/' (inbox now populated)

    const row = page.getByRole('button', { name: /Calc utilities/i });
    await row.waitFor({ timeout: 30_000 });
    await expect(row).toHaveAttribute('data-unread', 'true'); // never-viewed → unread

    // Open the PR. usePrDetail fires the real POST mark-viewed stamping the current head;
    // wait for it to persist before returning so the inbox refetch sees the stamp.
    const markViewed = page.waitForResponse(
      (r) =>
        /\/api\/pr\/acme\/api\/123\/mark-viewed$/.test(r.url()) && r.request().method() === 'POST',
    );
    await row.click();
    await page.waitForURL('**/pr/acme/api/123**');
    // #704: assert the stamp actually PERSISTED. mark-viewed is fire-and-forget; a non-204
    // (e.g. 422 snapshot-evicted, 409 stale-head-sha) leaves lastViewedHeadSha unwritten, so
    // the inbox overlay below would *correctly* keep the row unread forever — a hard failure
    // masquerading as a timing flake. Asserting 204 here converts that into an actionable
    // product-bug signal at the true root instead of a mysterious `:row-unread` timeout.
    expect((await markViewed).status()).toBe(204);

    // Return to the inbox via SPA history nav. The Inbox is keep-alive (InboxHost renders it
    // `hidden`, never unmounted), so there's no remount GET; instead useActivationTransition
    // fires useInbox.reload() on the active false→true edge (#285/#563), and the fresh
    // GET /api/inbox's read-time overlay re-projects the now-current stamp → row not unread.
    await page.goBack();
    await page.waitForURL((url) => url.pathname === '/');

    // #704: the original flake was a bare 5s toHaveAttribute poll losing a race under CI CPU
    // load — the activation reload + response + re-render can exceed 5s when the runner is
    // saturated (reproduced locally only while a sibling `dotnet test` suite pinned every core).
    // Gate on the OBSERVABLE with a generous timeout rather than a specific GET response:
    //   - it rides out load, and clears via ANY driver (activation reload, poller, auto-refresh);
    //   - it can't false-pass on stale client state — the row was asserted data-unread=true above,
    //     so 'false' can only come from fresh data carrying the stamp;
    //   - a stuck stamp is already ruled out fast by the 204 assertion, so this can't silently
    //     mask a mark-viewed failure (that fails earlier, at the true root).
    await expect(page.getByRole('button', { name: /Calc utilities/i })).toHaveAttribute(
      'data-unread',
      'false',
      { timeout: 15_000 },
    );
  });
});
