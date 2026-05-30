import type { Page } from '@playwright/test';
import { setupAndOpenScenarioPr, advanceHead, reloadPr } from './s4-setup';

// Sets up the dev-mode Playwright context for parity comparison work and
// navigates to the PR Detail surface that side-by-side reviews use as the
// implementation side. Per the design-parity-recovery roadmap (PR1, spec
// §4.1.1), the spec's HandoffParityFixture was descoped to a cost-to-gate
// fallback (see the deferrals sidecar). This is a thin alias over the
// existing `setupAndOpenScenarioPr` helper. Reviewers compare this
// implementation surface against the locally-loaded handoff prototype
// (`design/handoff/PRism.html`); content differs (the scenario PR is "Calc
// utilities" vs the handoff's "Refactor LeaseRenewalProcessor"), so the
// comparison is structural, not content-matched.
//
// The alias exists so parity PRs (PR2-PR8) can spawn
// `setupAndOpenHandoffParityFixture(page)` and the call site reads as
// parity-workflow intent. The thin-alias shape lets a future slice swap to a
// real handoff-content fixture (lifting the deferral) without changing every
// call site.
//
// Contract: Callers must set the viewport BEFORE invoking this helper —
// `await page.setViewportSize({ width: 1440, height: 900 })` for the
// canonical parity viewport. The helper does not configure viewport so
// callers from non-1440x900 contexts can override.
export async function setupAndOpenHandoffParityFixture(page: Page): Promise<void> {
  await setupAndOpenScenarioPr(page);
  // The scenario fixture lands the user on / (Inbox). Navigate into the PR
  // Detail surface — the side-by-side comparison target — so callers don't
  // have to repeat this step.
  await page.goto('/pr/acme/api/123');
  // Wait for the PR header to mount so callers can immediately screenshot or
  // assert without a follow-up wait. `data-testid="pr-header"` exists at
  // PrHeader.tsx (added during the no-layout-shift-on-banner spec work).
  await page.locator('[data-testid="pr-header"]').waitFor();
}

/**
 * Loads the scenario PR (acme/api/123 per PR1 D1), saves a draft on Calc.cs
 * line 3 via the composer, then advances head to invalidate the anchor →
 * draft re-classifies Stale → UnresolvedPanel mounts with one row.
 *
 * Used by the pr-detail-reconciliation-panel + pr-detail-drafts parity
 * baselines (PR5).
 */
export async function setupAndOpenHandoffParityFixtureWithStaleDraft(page: Page): Promise<void> {
  await setupAndOpenScenarioPr(page);
  await page.goto('/pr/acme/api/123/files');
  await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();
  await page.getByRole('button', { name: /add comment on line 3/i }).click();

  const savePromise = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/pr/acme/api/123/draft') &&
      r.request().method() === 'PUT' &&
      r.status() === 200,
    { timeout: 10_000 },
  );
  await page.getByRole('textbox', { name: /comment body/i }).fill('parity baseline draft');
  await savePromise;

  const newHeadSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  await advanceHead(page, newHeadSha, [
    {
      path: 'src/Calc.cs',
      content:
        'namespace Acme;\npublic static class Calc {\n  public static int Sub(int a, int b) => a - b;\n}\n',
    },
  ]);
  await reloadPr(page, { owner: 'acme', repo: 'api', number: 123 }, newHeadSha);
  await page.reload();
}
