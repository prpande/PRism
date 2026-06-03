import { test, expect, request, type Page, type Locator } from '@playwright/test';

import {
  resetBackendState,
  setupAndOpenScenarioPr,
  createInlineDraft,
  recordPrViewed,
  setBeginDelay,
} from './helpers/s5-submit';

// Task 28 (spec § 7.3) — the post-V7 SubmitDialog PR-root body preview + inline
// Edit toggle + the cross-surface / cross-tab edit locks. Five scenarios:
//
//   1. Negative — the legacy "pr-level summary" textarea is GONE. The dialog now
//      renders a preview block + an Edit toggle, never the old summary textarea.
//   2. Preview positive — with a PR-root draft body seeded, the dialog renders
//      the body through MarkdownRenderer in PREVIEW mode (no editable textarea).
//   3. Inline-edit toggle happy path — Edit → PrRootBodyEditor textarea appears →
//      type → autosave (composer-badge → 'saved') → Done → preview re-renders
//      with the new body → close + reopen → back in preview (editing resets).
//   4. Intra-tab cross-surface lock — open the Overview Reply composer (claims
//      the PR-root draft as 'reply-composer') → open the SubmitDialog → the Edit
//      toggle is DISABLED with the 'editing-in-overview-composer' tooltip ("Close
//      the Overview composer to edit here.").
//   5. Cross-tab read-only lock — two pages in ONE context (BroadcastChannel is
//      context-scoped, see s4-multi-tab-consistency) open the same PR; tab B
//      clicks "Take over here" → the claim flips tab A to readOnly → tab A's
//      SubmitDialog Edit toggle is DISABLED with the 'editing-in-other-tab'
//      tooltip ("Another tab is editing this PR.").
//
// IMPORTANT product constraint discovered while authoring (PrRootConversation.tsx
// line ~74): a persisted PR-root draft AUTO-OPENS the Overview-tab Reply composer
// on mount (`useState(!!existingPrRootDraft)`). There is no "closed composer +
// persisted draft" Overview state — the Overview composer has only Post (consumes
// the draft) or Discard (deletes it). So scenarios 2/3 seed the PR-root body
// through the SubmitDialog's OWN Edit flow (ownerKey 'submit-dialog', released on
// Done) rather than the Overview composer — that yields a persisted draft the
// dialog renders as a CLOSED preview with Edit enabled, and never visits the
// Overview tab. Scenario 4 deliberately uses the Overview composer to stage the
// cross-surface lock.
//
// No net-new /test/ endpoints. Playwright auto-wait throughout; no fixed
// sub-second sleeps.

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  // A small Begin delay keeps the submit SSE-vs-200 ordering deterministic for
  // any scenario that drives the pipeline (mirrors the s5 specs). None of the
  // five here run the pipeline to completion, but keep parity with the sibling
  // submit specs so the dialog behaves identically.
  await setBeginDelay(ctx, 120);
  await ctx.dispose();
});

// Opens the SubmitDialog from PrHeader's Submit button. Submit enables once
// there's reviewable content; callers seed an inline draft (and navigate to the
// PR detail page so the session refetch reflects it) before invoking this.
async function openSubmitDialog(page: Page): Promise<Locator> {
  const submitButton = page.getByRole('button', { name: /^submit review$/i });
  await expect(submitButton).toBeEnabled({ timeout: 10_000 });
  await submitButton.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /^submit review$/i })).toBeVisible();
  return dialog;
}

// Waits for the next PR-root draft autosave PUT (250ms-debounced) to land 200.
function waitForDraftSave(page: Page) {
  return page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/pr/acme/api/123/draft') &&
      r.request().method() === 'PUT' &&
      r.status() === 200,
    { timeout: 10_000 },
  );
}

// Standard arrange: connect, seed one inline draft (so Submit enables without a
// PR-root body), stamp the head sha, then land on the PR detail page so the
// session the Submit button reads includes the draft. Mirrors s5-submit-happy-
// path's ordering (createInlineDraft → recordPrViewed → goto detail).
async function arrangePrWithInlineDraft(page: Page): Promise<void> {
  await setupAndOpenScenarioPr(page);
  await createInlineDraft(page, 3, 'inline so Submit enables');
  await recordPrViewed(page);
  await page.goto('/pr/acme/api/123');
}

// Seeds a PR-root body THROUGH the SubmitDialog's own Edit flow: open dialog →
// Edit → type → autosave → Done → close → reload (Files tab) so the session
// refetches the new draft. The autosave CREATES the draft and updates only the
// dialog's local draftId; the own-tab state-changed SSE is filtered, so the
// SESSION the reopened dialog reads stays stale until a navigation forces a
// fresh fetch. We land on the Files tab (not Overview) on purpose: the Overview
// tab auto-opens its Reply composer when a PR-root draft exists (claiming
// 'reply-composer'), which would lock the dialog's Edit toggle. The Files tab
// has no PR-root composer, so it refetches the session without claiming the
// draft. Leaves a persisted, UN-held PR-root draft + a closed dialog.
async function seedBodyViaDialog(page: Page, body: string): Promise<void> {
  const dialog = await openSubmitDialog(page);
  await dialog.getByTestId('pr-root-edit-toggle').click();
  const editor = dialog.getByRole('textbox', { name: /pr-level body/i });
  await expect(editor).toBeVisible();
  const save = waitForDraftSave(page);
  await editor.fill(body);
  await save;
  await expect(dialog.getByTestId('composer-badge')).toHaveText('saved', { timeout: 10_000 });
  await dialog.getByTestId('pr-root-done-toggle').click();
  await dialog.getByRole('button', { name: /^cancel$/i }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Reload via the Files tab so the session refetch picks up the new PR-root
  // draft without auto-opening the Overview composer.
  await page.goto('/pr/acme/api/123/files');
  await expect(page.getByRole('button', { name: /^submit review$/i })).toBeEnabled({
    timeout: 10_000,
  });
}

test('S-dialog 1 — the legacy PR-level summary textarea no longer renders', async ({ page }) => {
  await arrangePrWithInlineDraft(page);

  const dialog = await openSubmitDialog(page);

  // The removed label: T22 dropped the summary textarea in favour of the
  // preview + Edit toggle. The old `getByLabel(/pr-level summary/i)` must match
  // NOTHING now.
  await expect(dialog.getByLabel(/pr-level summary/i)).toHaveCount(0);

  // The replacement surface IS present: the preview placeholder (no body yet)
  // and the Edit toggle (enabled — nothing else holds the PR-root draft).
  await expect(dialog.getByText(/no pr-level body — click edit to add one\./i)).toBeVisible();
  await expect(dialog.getByTestId('pr-root-edit-toggle')).toBeEnabled();
});

test('S-dialog 2 — the PR-root draft body renders as a preview in the dialog', async ({ page }) => {
  await arrangePrWithInlineDraft(page);
  const body = 'A seeded PR-root body for the preview.';
  await seedBodyViaDialog(page, body);

  const dialog = await openSubmitDialog(page);

  // The body renders through MarkdownRenderer (preview mode) — the text is
  // visible and there is NO editable PR-level-body textarea by default.
  await expect(dialog.getByText(body)).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: /pr-level body/i })).toHaveCount(0);
  // The Edit toggle is present + enabled (no cross-surface / cross-tab lock —
  // the seeding dialog released its claim on Done).
  await expect(dialog.getByTestId('pr-root-edit-toggle')).toBeEnabled();
});

test('S-dialog 3 — Edit toggle: type → autosave → Done re-renders preview → reopen resets to preview', async ({
  page,
}) => {
  await arrangePrWithInlineDraft(page);
  await seedBodyViaDialog(page, 'Original PR-root body.');

  const dialog = await openSubmitDialog(page);

  // Preview shows the seeded body; click Edit → the editor mounts with it.
  await expect(dialog.getByText('Original PR-root body.')).toBeVisible();
  await dialog.getByTestId('pr-root-edit-toggle').click();
  const editor = dialog.getByRole('textbox', { name: /pr-level body/i });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue('Original PR-root body.');

  // Replace the body + wait for the 250ms autosave PUT to land (badge → saved).
  const updated = 'Updated PR-root body via the dialog Edit toggle.';
  const save = waitForDraftSave(page);
  await editor.fill(updated);
  await save;
  await expect(dialog.getByTestId('composer-badge')).toHaveText('saved', { timeout: 10_000 });

  // Done → the editor unmounts and the dialog returns to PREVIEW mode.
  await dialog.getByTestId('pr-root-done-toggle').click();
  await expect(dialog.getByRole('textbox', { name: /pr-level body/i })).toHaveCount(0);

  // The preview re-renders with the NEW body IN THE SAME dialog session (spec
  // § 10 step 6). The preview is bound to the live `editingBody` the editor
  // streams through onBodyChange, not the SESSION's PR-root draft — so the edit
  // shows immediately, without waiting for a session refetch (the own-tab
  // state-changed SSE is filtered, so no refetch happens here). The pre-edit
  // body is gone from the preview.
  await expect(dialog.getByText(updated)).toBeVisible();
  await expect(dialog.getByText('Original PR-root body.')).toHaveCount(0);

  // Close the dialog, then reload (Files tab) so the session refetches the
  // persisted 'Updated' body. The Files tab is used so the Overview composer
  // doesn't auto-open + claim the draft.
  await dialog.getByRole('button', { name: /^cancel$/i }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('/pr/acme/api/123/files');
  await expect(page.getByRole('button', { name: /^submit review$/i })).toBeEnabled({
    timeout: 10_000,
  });

  // The dialog always opens in PREVIEW mode (editing resets on the false→true
  // `open` transition, spec § 4.8) and now shows the persisted NEW body — the
  // edit was durable; the reload surfaced it.
  const reopened = await openSubmitDialog(page);
  await expect(reopened.getByRole('textbox', { name: /pr-level body/i })).toHaveCount(0);
  await expect(reopened.getByText(updated)).toBeVisible();
});

test('S-dialog 4 — intra-tab cross-surface lock disables Edit while the Overview composer holds the draft', async ({
  page,
}) => {
  await arrangePrWithInlineDraft(page);
  // Seed a PR-root body via the dialog so the preview has content; this leaves a
  // persisted draft + a closed dialog with no lingering registry claim.
  await seedBodyViaDialog(page, 'Body for the cross-surface lock scenario.');

  // Visit the Overview tab. The persisted PR-root draft AUTO-OPENS the Reply
  // composer (PrRootConversation `useState(!!existingPrRootDraft)`), whose
  // PrRootBodyEditor registers the draft under ownerKey 'reply-composer'.
  await page.goto('/pr/acme/api/123');
  await expect(page.getByRole('textbox', { name: /pr-level body/i })).toBeVisible({
    timeout: 10_000,
  });

  // Open the SubmitDialog (PrHeader's Submit button stays reachable above the
  // Overview body). The composer stays MOUNTED behind the modal, so the registry
  // still reports 'reply-composer' as the PR-root holder.
  const dialog = await openSubmitDialog(page);

  // The Edit toggle is disabled with the cross-surface tooltip; the body still
  // renders as a preview (the lock only blocks editing, not viewing).
  const editToggle = dialog.getByTestId('pr-root-edit-toggle');
  await expect(editToggle).toBeDisabled();
  await expect(editToggle).toHaveAttribute('title', 'Close the Overview composer to edit here.');
  await expect(dialog.getByText('Body for the cross-surface lock scenario.')).toBeVisible();
});

test('S-dialog 5 — cross-tab read-only lock disables Edit with the other-tab tooltip', async ({
  browser,
}) => {
  // Two pages in ONE context — BroadcastChannel is scoped to one browsing
  // context group, so the cross-tab presence claim only propagates within a
  // single context (mirrors s4-multi-tab-consistency).
  const context = await browser.newContext();
  try {
    const tabA = await context.newPage();
    await setupAndOpenScenarioPr(tabA);
    await createInlineDraft(tabA, 3, 'inline so Submit enables');
    await recordPrViewed(tabA);
    await tabA.goto('/pr/acme/api/123');

    const tabB = await context.newPage();
    await setupAndOpenScenarioPr(tabB);
    await tabB.goto('/pr/acme/api/123');

    // Both tabs surface the cross-tab presence banner.
    await expect(tabA.getByText(/this pr is open in another tab/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(tabB.getByText(/this pr is open in another tab/i)).toBeVisible({
      timeout: 10_000,
    });

    // Tab B claims ownership → the 'claim' BroadcastChannel message flips tab A
    // to readOnly (its banner switches to the read-only copy).
    await tabB.getByRole('button', { name: /take over here/i }).click();
    await expect(tabA.getByText(/another tab claimed this pr/i)).toBeVisible({ timeout: 10_000 });

    // Tab A: open the SubmitDialog. readOnly=true → useCantEditRootBodyReason
    // returns 'editing-in-other-tab' → the Edit toggle is disabled with the
    // other-tab tooltip.
    const dialog = await openSubmitDialog(tabA);
    const editToggle = dialog.getByTestId('pr-root-edit-toggle');
    await expect(editToggle).toBeDisabled();
    await expect(editToggle).toHaveAttribute('title', 'Another tab is editing this PR.');
  } finally {
    await context.close();
  }
});
