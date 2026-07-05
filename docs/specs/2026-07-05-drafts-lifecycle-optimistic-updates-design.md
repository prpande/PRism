---
title: Drafts lifecycle — optimistic create/discard across composer surfaces
issue: 744
type: bug/ux + test
status: design
origin: none
---

# Drafts lifecycle: instant create / discard across composer surfaces + Drafts tab (#744)

## Problem

Draft state transitions made through the composers do not reflect **instantly** in the
Drafts tab. Two observed gaps, both rooted in the fact that the shared draft session
(`frontend/src/hooks/useDraftSession.ts`) is only ever mutated by a server round-trip:

1. **Discard lingers.** `DraftListItem.runDelete` (and `DiscardAllStaleButton`) await
   `sendPatch(DELETE)`, then call `onMutated()` → `draftSession.refetch()` — a *second*
   round-trip (`getDraft` GET) whose `mergeSession` drops the now-absent id. The row stays
   in the DOM for that extra GET. Server-authoritative, so it always eventually clears —
   this is a latency/UX gap, not a stale-forever bug.

2. **Create is not instant.** A new draft typed in the Overview composer (PR-root) or a
   Files-tab inline composer is gated by the intentional `COMPOSER_CREATE_THRESHOLD`
   (3 chars) and `COMPOSER_DEBOUNCE_MS` (250 ms), then a create PUT, then `onSaved()` →
   `refetch()` (a further GET) before the Drafts tab shows it. The threshold and debounce
   are **intended** churn-guards and stay; the removable lag is the trailing refetch GET.

Both paths already work correctly — the fix is to make the local session reflect the
transition **immediately on server confirmation**, keeping the existing refetch purely for
reconciliation.

**Benefit scope (honest framing).** The optimistic *removal* (Case 1) is the clear win —
the lingering row after a confirmed discard is the visible complaint. The optimistic
*insert* (Case 2) removes only the **trailing refetch GET**; the dominant *perceived* create
lag (threshold + debounce) is intentional and stays, so Case 2's win is bounded (one
round-trip, most perceptible on a slow network). The issue owner explicitly opted into
building Case 2's optimistic insert now (rather than deferring it with the threshold/debounce
question) — recorded here so a reader knows the proportionality was weighed, not missed.

## Scope

**In scope:**
- Optimistic **removal** on discard: `DraftListItem` and `DiscardAllStaleButton`.
- Optimistic **insert** on create, across **all three** composer surfaces — Files-tab inline
  (`InlineCommentComposer`), Overview PR-root (`PrRootBodyEditor`), and reply
  (`ReplyComposer`). These do **not** share a single wrapper hook — `PrRootBodyEditor` calls
  `useComposerAutoSave` **directly**, while inline/reply go through `useDraftComposer` — so
  the insert seam lives at their one convergence point, `useComposerAutoSave` (see § Seam).
- New seams on `useDraftSession`: `removeDraftLocally(id)` and `insertDraftLocally(draft)`.
- A full-lifecycle Playwright E2E (`test` label — the required deliverable).

**Deliberately out of scope (documented, not silently dropped):**
- Tuning `COMPOSER_CREATE_THRESHOLD` / `COMPOSER_DEBOUNCE_MS`. Intentional churn-guards and
  the dominant *perceived* create lag, but changing them is a separate product call
  (`[Skip]` — see § Rejected alternatives).
- **The `Reconciliation/StaleDraftRow` + `UnresolvedPanel` discard path — `[Defer]`
  unconditionally.** It shares the `onMutated → refetch` shape, but unlike the Drafts-tab
  components it deliberately does **not** consume `draftSession` from context (it renders as
  always-visible chrome that can mount *before* the context provider exists — reading context
  there tore the app to the ErrorBoundary). Reaching `removeDraftLocally` there requires
  threading a new prop through `PrDetailView → UnresolvedPanel → StaleDraftRow` (3 files), not
  the "~2 lines" first assumed. Out of scope; follow-up issue if wanted.
- `SubmitDialog`'s pr-root composer also routes through `useComposerAutoSave`, so it *can*
  opt into the insert for free by passing the new callback; wiring it is not required by #744
  and is left to that surface's discretion.
- #739 (removing the composer's own discard-confirmation modal) — tracked separately.

## Approach

### Seam (on `useDraftSession`)

Two pure, id-keyed, **idempotent** local mutators added to `UseDraftSessionResult`:

```
removeDraftLocally(id: string): void
  // splice `id` from BOTH session.draftComments and session.draftReplies.
  // No-op if session is null or id absent. Idempotent.

insertDraftLocally(draft: DraftCommentDto | DraftReplyDto): void
  // if a draft with draft.id already exists in the target array, REPLACE it
  //   (dedup — never produce two rows with the same id);
  // else append. Discriminate reply-vs-comment by the presence of `parentThreadId`.
  // No-op if session is null.
```

Both operate on the current `session` via `setSession(prev => …)` and touch nothing else
(status/error/openComposers untouched).

### Wiring — discard (Case 1)

`removeDraftLocally` is threaded **as a prop**, matching the existing `refetch`/`onMutated`
flow in the Drafts-tab subtree (`DraftsTabRoute` consumes `draftSession` from context and
passes props down through `DraftsTab`). It is **not** pulled from context inside the leaf
components — `DraftListItem`/`DiscardAllStaleButton` are currently rendered in unit tests
without a `PrDetailContextProvider`, so adding a context read would break those tests; a prop
is a drop-in mock instead.

- `DraftListItem.runDelete`: after `result.ok`, call `removeDraftLocally(draft.data.id)`
  **then** `onMutated()`. Keyed on `sendPatch` **success**, so the trailing refetch cannot
  resurrect it (server GET no longer returns it); a **failed** delete leaves the row (the
  existing `!result.ok` early return is unchanged).
- `DiscardAllStaleButton`: call `removeDraftLocally(id)` for each id whose `sendPatch`
  succeeded, inside the existing loop; keep the `onMutated()` reconciliation call.

### Wiring — create (Case 2)

The create fires inside `useComposerAutoSave.doSave` (the `id === null` branch), which is the
**single convergence point** for all three surfaces. On create success — in the same spot
that already fires `onAssignedId` + `onSaved`, and behind the same live `propsRef.current.disabled`
re-check (so a cross-tab take-over inserts nothing) — build the DTO and fire a new optional
`onCreated?(draft)` prop:

- The DTO is built **once**, in `useComposerAutoSave`, from `(result.assignedId, currentBody,
  anchor)` via a new `makeCreatedDraftDto` sibling to the existing `makeCreatePatch`.
  `currentBody` is the exact body just sent in the create PUT (the freshest **persisted**
  value), so the optimistic row shows what the server stored — no "body never sent" flip, and
  the open-composer `isOpen` body-preservation rule keeps it stable across the reconciling
  refetch.
- `onCreated` is threaded to `draftSession.insertDraftLocally` by each surface's container,
  alongside where it already passes `onSaved`: `useDraftComposer` forwards it (inline + reply
  via `InlineCommentComposer`/`ReplyComposer`), and `PrRootBodyEditor` forwards it (pr-root
  via the Overview `PrRootReplyComposer`).

DTO fabrication (`anchor → DTO`); server-authoritative fields get brand-new-draft defaults,
reconciled by the trailing refetch:

| anchor.kind     | DTO                | id  | body           | status  | isOverriddenStale | other |
|-----------------|--------------------|-----|----------------|---------|-------------------|-------|
| `inline-comment`| `DraftCommentDto`  | ✓   | `currentBody`  | `draft` | `false`           | filePath/lineNumber/side/anchoredSha/anchoredLineContent from anchor; `postedCommentId: null` |
| `pr-root`       | `DraftCommentDto`  | ✓   | `currentBody`  | `draft` | `false`           | filePath/lineNumber/side/anchoredSha/anchoredLineContent = `null`; `postedCommentId: null` |
| `reply`         | `DraftReplyDto`    | ✓   | `currentBody`  | `draft` | `false`           | parentThreadId from anchor; `replyCommentId: null` |

> **Fabricated status is best-effort.** `status: 'draft'` / `isOverriddenStale: false` are the
> brand-new-draft defaults. If head advances between the create PUT and the reconciling
> refetch, `getDraft` may return the draft as `'stale'`/`'moved'` — so the Drafts-tab chip can
> momentarily read "Draft" before the refetch corrects it. Transient, self-healing, cosmetic.

The create fires `onCreated` **once per successful create PUT** — including a
**recovery-recreate** (`useDraftComposer.handleRecoveryRecreate` → `flush()` after a 404
cleared `draftId`), which is a *fresh* create with a *new* id. That second `onCreated` is
correct (a real new draft); `insertDraftLocally`'s dedup-by-id keeps it safe either way.

### Reconciliation invariant (the real design nuance)

`mergeSession` iterates the **server** list: server-only ids are added, matched ids merge
(server wins except body when a composer `isOpen`), and **local-only ids are dropped**
(the "composer's next save 404s and recovers" rule). Crucially, `isOpen` is consulted **only
for server-present ids** — a local-only id is never visited, so an open composer does **not**
shield an optimistically-inserted (server-absent) row from a merge.

On the **normal, ordered** flow the E2E asserts, this is clean:

- **Insert → refetch:** the create PUT lands server-side *before* `onSaved → refetch`'s GET is
  issued, so the fresh GET includes the new id → `mergeComments` keeps the server row, and
  `insertDraftLocally`'s dedup guarantees no duplicate (replace-by-id, so even an insert that
  lands *after* a refetch already containing the row cannot double it). ✓
- **Remove → refetch:** the DELETE lands *before* the `onMutated → refetch` GET, so the GET
  omits the id → it stays removed. ✓

**New transient-drop window introduced by the insert (honest correction).** An earlier draft
of this spec claimed the seams "neither widen nor fix" the existing eventual-consistency
window. That was wrong for the insert: **before** this change nothing ever wrote a
server-absent id into `session` on the create happy path, so a concurrent refetch had no
local-only row to drop. `insertDraftLocally` makes a server-absent id a normal create-path
state, so a **different** refetch already in flight when the create lands (an SSE
`useStateChangedSubscriber` tick, or `onReloadComplete`, whose GET predates the create) will
resolve, iterate a server list lacking the new id, and **drop the optimistic row** — even with
its composer open — until the create's own trailing refetch re-adds it one round-trip later.
Net effect: a possible sub-second **appear → vanish → reappear** flicker on create, gated on a
concurrent cross-event refetch interleaving. The removal path has the mirror (a stale refetch
predating the DELETE can momentarily re-add a removed row), likewise self-healing.

**Decision: accept and document, do not change merge semantics.** The obvious mitigation —
have `mergeComments`/`mergeReplies` *retain* local-only ids whose composer `isOpen` — would
also change the **cross-tab-delete-of-an-open-draft** recovery behavior (today that draft is
correctly dropped from the session on refetch, letting the composer's next save 404-recover).
Trading a well-understood recovery path for a sub-second self-healing flicker is the wrong
call on a P2 polish. The trailing refetch is the reconciliation authority; the insert is pure
latency-hiding. (The full tombstone-set alternative is likewise rejected — see § Rejected
alternatives.) The E2E asserts steady state **once quiescent**, not the absence of this
transient window.

## Behaviour contract to preserve

- A **failed** discard (`!result.ok`) still leaves the row and re-enables the buttons —
  `removeDraftLocally` is called **only** after `result.ok`.
- The threshold + debounce create-gating is unchanged; a sub-3-char brand-new draft still
  never persists and never inserts (`onCreated` only fires on a successful create PUT).
- `onSaved`/`onMutated` → `refetch()` still fire on every path (reconciliation preserved);
  the seams are **additive**, never a replacement.
- The create-path insert is suppressed on a taken-over (read-only) tab — `onCreated` fires
  behind the same `propsRef.current.disabled` re-check that already guards `onSaved`.
- Open-composer body-preservation, out-of-band toast, posting-suppression, and cross-tab
  read-only gating in `useDraftSession`/`useComposerAutoSave` are otherwise untouched.
- No wire/DTO/endpoint change. `insertDraftLocally` constructs a client-side DTO that is a
  strict subset-shape of what `getDraft` returns for a fresh draft; it is transient until the
  next refetch overwrites it.

## Testing

**Unit (vitest):**
- `useDraftSession`: `removeDraftLocally` splices from comments and replies, is a no-op for
  absent id / null session, idempotent. `insertDraftLocally` appends, dedups by id (replace),
  routes reply vs comment by `parentThreadId`, no-op on null session.
- `DraftListItem`: on successful delete, the row is removed **before** a refetch resolves
  (assert via a deferred `refetch`/`removeDraftLocally` mock); on failed delete, the row
  remains and `removeDraftLocally` is **not** called.
- `DiscardAllStaleButton`: each successful id is removed locally; a partial failure removes
  only the succeeded ids.
- `useComposerAutoSave`: on create success, `onCreated` fires once with a correctly shaped
  DTO for each anchor kind (inline / pr-root / reply); **not** fired on update or delete; and
  fires **again** with the new id on a recovery-recreate (create → 404 → recreate).
- `onCreated` is suppressed when `disabled` flips true mid-create (parity with `onSaved`).

**E2E (Playwright, prod project — `pr-detail-drafts-lifecycle.spec.ts`):** drive the real
composer flow, **poll the observable** (no fixed delay), seed via existing `/test` hooks where
a deterministic starting state is needed:
1. Create (Files inline, ≥3 chars) → draft appears in Drafts tab promptly.
2. Create (Overview PR-root, ≥3 chars) → appears promptly. *(Explicitly covers the surface
   that bypasses `useDraftComposer`.)*
3. Edit an existing draft → Drafts-tab preview updates.
4. Discard from Drafts tab (confirm) → row removed instantly.
5. Discard-all-stale → bulk rows clear instantly.
6. After each, **once quiescent** the row count is stable — no resurrect, no duplicate. (This
   asserts steady state, not the absence of the documented sub-second concurrent-refetch
   flicker; the polling absorbs any transient.)

## Rejected alternatives

- **Tune threshold/debounce to make create feel instant.** `[Skip]`. They are the dominant
  *perceived* lag but are intentional churn-guards; lowering them trades UX feel for
  create/delete churn on abandoned 1–2-char starts — a product decision outside this bug.
- **Wire the insert at `useDraftComposer.handleAssignedId` (per-wrapper).** Rejected: the
  Overview PR-root surface (`PrRootBodyEditor`) does **not** go through `useDraftComposer` — it
  calls `useComposerAutoSave` directly — so a per-wrapper seam would silently skip pr-root
  creates and duplicate the anchor→DTO map across two wrappers. `useComposerAutoSave` is the
  one convergence point; the DTO is built there once. *(This reverses the earlier draft, which
  chose `useDraftComposer` before recognizing the pr-root bypass.)*
- **Retain local-only ids whose composer `isOpen` in `mergeSession`** (to close the new
  create-flicker cheaply). Rejected: it also changes cross-tab-delete-of-open-draft recovery,
  which today correctly drops the deleted draft and lets the composer 404-recover. Not worth
  it for a self-healing sub-second flicker.
- **Tombstone set of optimistically-removed ids** to defeat a stale in-flight refetch on the
  remove path. Adds persistent state + expiry to close a pre-existing, self-healing window on
  a P2 polish. Over-engineering; the trailing refetch reconciles.

## Deferred work

- `Reconciliation/StaleDraftRow` + `UnresolvedPanel` optimistic removal — `[Defer]` to a
  follow-up (requires prop-threading, not a context read; see § Scope).
- Threshold/debounce tuning — `[Skip]` (product call, recorded above).
