# #601 — Composer post-now / flush / discard race fixes (design)

**Issue:** [#601](https://github.com/prpande/PRism/issues/601) — `priority:p1`, `tech-debt`,
`area:reliability`, `area:frontend`.
**Tier:** T2 (3 frontend files, related guard fixes, one verification finding that descoped one part).
**Risk:** hands-off. Not B1 (no `design` label; correctness is test-assertable, not eyeball).
Not B2 — the touched calls (`postComment`) are the **single-comment** post path (#302
decouple-commenting), **not** the reviewer-atomic submit pipeline (`addPullRequestReview` →
`submitPullRequestReview`); no token / persisted-schema / cross-tab-stamp / sidecar / security
surface is touched.

## Problem

#326 extracted `useDraftComposer` but left error-handling races around the post-now / flush /
discard interplay. All require a **concurrent server-side draft deletion** mid-flight (404
`draft-not-found`), so there is no data loss — the failure mode is a **doomed network mutation
plus conflicting / racing recovery UI**.

Verified against live code at intake; one part (B) was then **disproven by a feasibility probe**
(see "Defect B — descoped" below).

- **A — `useDraftComposer.handlePostNow`** (`useDraftComposer.ts`). `const id = (await flush()) ??
  draftId`. On a 404 during flush, `useComposerAutoSave` nulls its internal `draftIdRef` and fires
  `onDraftDeletedByServer`, so `flush()` returns `null` *and* `recoveryModalOpenRef.current` is set
  to `true`. But `null ?? draftId` falls back to the **stale, still-non-null** `draftId` prop (the
  `onDraftIdChange(null)` re-render hasn't landed), bypassing the `!id` guard and firing
  `postComment` against the deleted id → 404 → `setPostError`. Result: the recovery modal **and** an
  inline post error appear together, plus a doomed POST. `handleKeyDown`'s submit branch already
  guards this exact transition with `if (recoveryModalOpenRef.current) return;`; `handlePostNow`
  omits it. **The inline path is NOT readOnly-gated on `posting`** (`useDraftComposer.ts` passes
  `disabled: readOnly` to the autosave hook), so the 404 detection is live during a post-now and the
  bug reproduces in production.

- **C — inline Discard (and Save) clickable during an in-flight post** (`useDraftComposer.ts` +
  `ComposerActionsBar.tsx`). The shared `handleDiscardClick` has **no `posting` guard**, and the
  Discard button is `disabled={readOnly}` while post-now is `disabled={readOnly || posting}`. During
  a post-now the user can open the discard modal and confirm, firing `deleteDraftComment` (via
  `sendPatch`, a direct call **not** suppressed by any readOnly gate) for the same draft the post is
  shipping → delete races the post. The **Save** ("Add to review") button is the identical race:
  `disabled={readOnly}` only, and `handleSaveClick → flush()` fires an update PUT against the same
  draft mid-post. `PrRootReplyComposer` already gates **all** mutating affordances on
  `inFlight = postInFlight || discardInFlight`; the shared hook drifted from it for both Discard and
  Save. The issue frames this as "Discard/post are still inconsistently gated" — Save is part of that
  inconsistency.

## Defect B — descoped (does not reproduce)

The issue's Defect B claimed `PrRootReplyComposer.handlePost` posts against a lost draft **and**
opens the recovery modal, stacking two error surfaces. A feasibility review + an empirical probe on
the **real component** disproved the double-surface:

- `PrRootReplyComposer` renders its editor `readOnly={readOnly || postInFlight}`, so the moment
  `handlePost` sets `postInFlight`, the wrapped `PrRootBodyEditor` passes `disabled: true` into
  `useComposerAutoSave`. In `doSave`, the `if (propsRef.current.disabled) return;` checks (at entry
  and after the update PUT, `useComposerAutoSave.ts`) run **before** the 404 branch that fires
  `onDraftDeletedByServer`. Network latency ≫ React's re-render/effect flush, so by the time the
  update 404s, `disabled` is already true → `doSave` bails → `onDraftDeletedByServer` never fires →
  the recovery modal **never opens during post**.
- Probe result (real `PrRootReplyComposer`, delayed-404 update during post): `recoveryDialog =
  false`, `postRootComment` fired once. The only residual is a single doomed post that returns one
  error — **no conflicting UI**, i.e. not the double-surface the issue describes.
- The originally-drafted Fix B keyed on `onDraftDeletedByServer`, which is structurally suppressed
  during post by the intentional cross-tab readOnly gate. Making B's acceptance criterion satisfiable
  would require weakening that deliberate safety mechanism — a net-negative trade for a rare graceful
  error.

**Disposition (owner-approved):** descope B; fix A and C only; comment on #601 with this analysis.

## Fixes

### A — `useDraftComposer.handlePostNow`

Replace the stale-fallback line and add the recovery guard, mirroring `handleKeyDown`:

```ts
const id = await flush();
if (recoveryModalOpenRef.current) return; // 404-recovery opened mid-flush → modal only, no doomed POST
if (!id) {
  setPostError('Could not save the draft. Try again.');
  return;
}
```

`flush()`'s return is authoritative. `flush()` can return `null` on **three** paths:

1. **404-recovery** — the bug; now caught by the new `recoveryModalOpenRef` guard before `!id`.
2. **create-failure** (new draft, body ≥ threshold, create PUT fails) — `draftId` prop is also
   `null` here, so dropping `?? draftId` changes nothing; the `!id` error branch is correct.
3. **disabled / cross-tab take-over mid-flight** (`useComposerAutoSave.ts` flush short-circuits to
   `null` when `disabled` flips) — here the old `?? draftId` would have **posted from a now-read-only
   tab** (a §5.7a violation); the fix instead surfaces the inline "Could not save" error. This is a
   *correctness improvement*, not a regression, though the message is generic for that rare race. No
   dedicated test (narrow race; the fix already does the safe thing — see Out of scope).

### C — Discard and Save inert during an in-flight post

- `useDraftComposer.handleDiscardClick`: prepend `if (posting) return;`. This also covers the
  Escape keyboard path (`handleKeyDown → handleDiscardClick`), which a button `disabled` attribute
  alone cannot — belt-and-suspenders, each covering a distinct entry point.
- `useDraftComposer.handleSaveClick`: `if (saveDisabled || posting) return;`.
- `useDraftComposer.handleKeyDown` `submit` branch (Cmd/Ctrl+Enter): prepend `if (posting) return;`.
  This is the keyboard sibling of Save — it does `flush() + onClose()`, so during a post it would
  fire an update PUT racing the post **and** unmount the composer mid-post. The button `disabled`
  attribute cannot intercept this keyboard route (found in preflight review).
- Move the `posting` / `postError` `useState` up beside the other state so the Discard/Save handlers
  (declared above the post-now block) reference `posting` without a use-before-define.
- `ComposerActionsBar`: Discard `disabled={readOnly || posting}` /
  `aria-disabled={readOnly || posting || undefined}`; Save `disabled={readOnly || posting}` /
  `aria-disabled={saveDisabled || posting}`. (`posting` is already a prop.)

This covers all three composers per the issue's "all three composers" criterion: the shared-hook fix
lands on **both** the inline-comment and reply composers (same hook + `ComposerActionsBar`);
`PrRootReplyComposer` is already correct (`inFlight` gate).

## Acceptance criteria → tests (red-on-main first, in `…/Composer/` test files)

- [x] `handlePostNow` short-circuits on recovery, never posts the stale `draftId`, surfaces no inline
  error — `useDraftComposer.test.tsx` "post-now does NOT post … 404 recovery (#601 Defect A)".
- [x] Discard inert during an in-flight post: hook no-ops the modal
  (`useDraftComposer.test.tsx` "discard is inert …") and the button is disabled
  (`ComposerActionsBar.test.tsx` "disables Discard while a post is in flight").
- [x] Save inert during an in-flight post: hook fires no extra update PUT
  (`useDraftComposer.test.tsx` "save is inert …") and the button is disabled
  (`ComposerActionsBar.test.tsx` "disables Save while a post is in flight").
- [x] Cmd/Ctrl+Enter (submit) inert during an in-flight post: no update PUT, no mid-post unmount
  (`useDraftComposer.test.tsx` "Cmd+Enter (submit) is inert …").

All red-on-main, green-on-fix (6 tests). ~~Defect B short-circuit~~ — descoped (does not reproduce).

## Out of scope

- **Defect B** (root-composer double-surface) — does not reproduce; see above.
- **Inline textarea editable during post** (preflight finding) → filed as **#644**. A keystroke
  during the post window schedules a debounced autosave update PUT that races the post. The naive
  fix (gate the inline autosave `disabled` on `posting`) would re-suppress Fix A's 404 detection (the
  same mechanism that makes Defect B not reproduce), so it needs separate design care.
- The cross-tab-take-over-mid-post-now race (Fix A path 3): the fix already does the safe thing
  (errors instead of posting from a read-only tab); a dedicated regression test for that narrow
  timing window is deferred. A future symmetry refactor that gates the inline autosave on `posting`
  (mirroring `PrRootReplyComposer`) would re-suppress Fix A's 404 detection — noted as a dependency.
- Non-404 post-failure paths (network / 5xx / already-posted-mismatch) — existing behavior, unchanged.
- Any refactor folding `PrRootReplyComposer` into `useDraftComposer` (#326's deferred consolidation).
