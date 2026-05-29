import type { Page } from '@playwright/test';
import { setupAndOpenScenarioPr } from './s4-setup';

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
