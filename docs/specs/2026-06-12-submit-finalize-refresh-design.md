# Submit-finalize PR-detail refresh — design (#392)

**Issue:** [#392](https://github.com/prpande/PRism/issues/392) — Submitting a review with
comments: posted comments don't appear (inline drafts stay in the edit box, Overview comment
missing even after Reload).

**Tier:** T2 (single coherent bug fix, ~6 files, mirrors the shipped #353 pattern).
**Risk:** B2 — review-submit flow. Does **not** touch the atomic GraphQL submit pipeline; alters
post-finalize refresh/invalidation wiring on the core review-submit path.

## Problem

After a successful review submit that contains an Overview (PR-root) comment and inline (Files)
comments:

1. Inline drafts re-appear in their **composers** instead of rendering as posted comments.
2. The Overview comment does **not** appear — not immediately, and **not even after clicking
   Reload** on the "PR updated" banner.

## Root cause (confirmed at code level)

The submit-finalize path is missing the wiring #353 added for root-comment-post. Three seams,
one family:

- **Seam 1 — frontend never refetches PR detail on submit.** `PrHeader.tsx:217-228` fires only
  `onSessionRefetch()` (draft session) on `submit.state.kind === 'success'`; it never calls
  `reload()` (the PR-detail refetch). There is no analog to
  `useRootCommentPostedSubscriber({ onPosted: reload })` (`PrDetailView.tsx:79-81`). So the posted
  threads/comments are never re-GET'd.

- **Seam 2 — loader never invalidates on submit.** `PrDetailLoader` subscribes only to
  `ActivePrUpdated` and `RootCommentPostedBusEvent` (`PrDetailLoader.cs:85,95`). A review submit
  moves **no head SHA**, so the `(prRef, headSha, generation)` snapshot cache re-serves the **stale
  pre-submit snapshot** on a reload — the #353 bug class, unfixed for submit. This is why clicking
  Reload does not surface the Overview comment.

- **Seam 3 — draft-clear races the success signal.** The frontend transitions to `success` on the
  `submit-progress` **Finalize/Succeeded** SSE (`useSubmit.ts:127`), which the pipeline reports at
  `SubmitPipeline.cs:213` — **before** `ClearSubmittedSession` persists (`SubmitPipeline.cs:154`)
  and before the endpoint publishes `DraftSubmitted` + `StateChanged`
  (`PrSubmitEndpoints.cs:225-226`). So `onSessionRefetch()` reads the **un-cleared** session and the
  draft pops back into the composer.

### The clean hook

`DraftSubmitted(prRef)` is **already published on full success** (`PrSubmitEndpoints.cs:225`),
*after* `ClearSubmittedSession` runs, and currently has **zero subscribers**
(`SseChannel.cs:49-51`). `SseEventProjection.cs:14-19` explicitly documents adding a
`draft-submitted` projection arm as the intended forward path. It is the correctly-timed signal.

## Approach (Approach A — mirror #353)

Wire `DraftSubmitted` end-to-end as the post-clear "review submitted" signal:

1. **Backend invalidation.** `PrDetailLoader` subscribes (in-process) to `DraftSubmitted` →
   `Invalidate(prRef)`. Mirrors the existing `RootCommentPostedBusEvent` subscription. Disposed in
   `Dispose()` alongside the other two subscriptions.

2. **SSE projection.** `SseChannel` subscribes to `DraftSubmitted` and fans it out; add the
   `DraftSubmitted -> ("draft-submitted", DraftSubmittedWire(prRef))` arm to
   `SseEventProjection.Project`. Payload is minimal — `prRef` only (no review id; consistent with
   the threat-model defense for the submit-* events). Remove the now-satisfied
   "intentionally NOT subscribed" note. **`SseChannel.Dispose()` must dispose the new
   subscription** (`_busDraftSubmitted.Dispose()`), in the same block as `_busRootCommentPosted`
   — an undisposed subscription extends the fanout path past channel teardown (shutdown-race
   `ObjectDisposedException`).

3. **Frontend subscriber.** Add `useDraftSubmittedSubscriber({ prRef, onSubmitted })` — a twin of
   `useRootCommentPostedSubscriber` — that listens for `draft-submitted`, filters by `prRef`
   (exact string equality, not prefix), and fires `onSubmitted`. Wire it in `PrDetailView` to call
   **both** `reload()` (PR-detail refetch, surfaces posted threads + Overview comment) and
   `draftSession.refetch()` (clears the composer from the now-empty server session).

   **`draft-submitted` must be registered in `frontend/src/api/events.ts` in all three places**
   (mirroring `root-comment-posted`), or the live SSE listener silently never fires:
   - a `DraftSubmittedEvent` interface (`{ prRef: string }`) in `frontend/src/api/types.ts`, plus
     its re-export passthrough in `events.ts`;
   - a `'draft-submitted': DraftSubmittedEvent` entry in the `EventPayloadByType` map;
   - a `'draft-submitted'` entry in the **`EVENT_TYPES` array** — `connect()` only calls
     `es.addEventListener` for names in this array, so omitting it makes `stream.on('draft-submitted', …)`
     register a callback the live `EventSource` never invokes (compiles, passes fake-stream unit
     tests, no-ops in production).

4. **Drop the premature refetch.** Remove the `onSessionRefetch()` call from the
   `submit.state.kind === 'success'` effect in `PrHeader.tsx` (the seam-3 racing read — it reads
   the session before `ClearSubmittedSession` persists). The `clearLastResume()` call in that
   effect stays — it is timing-independent. The authoritative, post-clear draft refetch now comes
   from `useDraftSubmittedSubscriber`.

   > **This removes no non-SSE fallback.** `submit.state.kind === 'success'` is itself set by the
   > `submit-progress` Finalize/Succeeded SSE event (`useSubmit.ts:127`), so the removed
   > `onSessionRefetch()` was *already* SSE-gated — the own tab never had a non-SSE path here.
   > Post-fix, the own tab's composer-clear is driven by two independent post-clear SSE frames
   > published back-to-back (`PrSubmitEndpoints.cs:225-226`): the new `draft-submitted` and the
   > existing `StateChanged(SourceTabId: null)` (whose own-tab filter does **not** swallow a null
   > source — confirmed at `useStateChangedSubscriber.ts:34`). Either frame alone clears the
   > composer. The ultimate non-SSE fallbacks remain the `ActivePrPoller`'s `CommentCountChanged`
   > eviction and the manual Refresh button (#344).
   >
   > **The redundant `draftSession.refetch()` is benign.** Both the `draft-submitted` and
   > `state-changed` frames drive a draft-session refetch; both resolve to the *same* post-clear
   > (empty) server session, so their resolution order is immaterial — there is no last-write-wins
   > hazard.

### Why the ordering is correct (no race)

`ReviewEventBus.Publish` invokes all subscribers **synchronously** on the caller's thread before
returning (`ReviewEventBus.cs:16`). So within `bus.Publish(new DraftSubmitted(prRef))`:

- The loader's `Invalidate(prRef)` runs synchronously (in-process).
- The `SseChannel` fanout enqueues the `draft-submitted` bytes to the client.

The client's `reload()` is a **network round-trip** that can only begin after it receives those
bytes — i.e. after `Publish` has already returned, i.e. after `Invalidate` ran. So the reload GET
always observes the invalidated (post-submit, post-clear) state. The relative registration order of
the two subscribers is irrelevant.

`DraftSubmitted` itself is published only at `PrSubmitEndpoints.cs:225`, which is reached only after
`ClearSubmittedSession` (`SubmitPipeline.cs:154`) on the `SubmitOutcome.Success` path — so the
server session is already empty when the signal fires.

**Residual window (accepted, same posture as #353).** `reload()` re-GETs via the cache-probing
`LoadAsync` (not the force-fresh `RefreshAsync`). It returns fresh data because the entry is now
absent — but a *separate* concurrent `LoadAsync` for the same PR whose `GetPrDetailAsync` round-trip
started **before** finalize, yet whose `_snapshots.GetOrAdd(realKey, …)` lands **after** `Invalidate`,
could re-cache a pre-submit-content snapshot under the same `(prRef, headSha, generation)` key
(submit moves no head SHA). The window is narrow on a single-user desktop app and self-heals on the
next reload/poll. This is the **identical** posture #353 shipped with for its `RootCommentPosted →
Invalidate` + `reload()` pairing, so we accept it for parity rather than re-plumbing the post-submit
refresh onto `RefreshAsync`.

**`/file` & `/viewed` 422 window (accepted, same posture as #353).** `Invalidate` drops the snapshot
those endpoints read, so a diff tab navigating the same PR during a submit could briefly get a
`snapshot-evicted` 422 between `Invalidate` and the next `LoadAsync`. This is the same window #353's
`RootCommentPosted` invalidation already opens; the post-submit `reload()` re-populates immediately,
so it is transient and self-healing. (We do **not** subscribe to `SingleCommentPostedBusEvent` —
which has no client reload trigger — for exactly the reason it would leave that 422 window open with
nothing to close it; `PrDetailLoader.cs:90-94`.)

## Acceptance criteria

1. After a successful review submit (inline + Overview comments), PR detail re-fetches and the
   posted inline comments render in their Files threads and the Overview/PR-root comment appears in
   the conversation — **no manual reload required**.
2. Submitted inline drafts clear from their composers (no draft "comes back up in the edit box").
3. `PrDetailLoader` invalidates the PR's snapshot on `DraftSubmitted` so the refetch returns fresh
   data, and the invalidate-before-reload ordering is guaranteed by the synchronous bus.

## Test plan (red-on-main first)

- **Backend (`PRism.Core.Tests`):** `PrDetailLoader` evicts the cached snapshot on a published
  `DraftSubmitted` for that `prRef` (and only that `prRef`). Red on main (no subscription) → green.
- **Backend (`PRism.Web.Tests`):** `SseEventProjection.Project(DraftSubmitted)` yields
  `("draft-submitted", { prRef })`; `SseChannel` fans out `draft-submitted` for a subscribed PR.
  Red on main (default-arm throws / not subscribed) → green. Add a `SseChannel.Dispose()`
  regression assertion so the new subscription's disposal can't silently regress.
- **Frontend (`vitest`):** `useDraftSubmittedSubscriber` fires `onSubmitted` on a matching
  `draft-submitted` event and ignores a non-matching `prRef`. `PrDetailView` wires it to `reload` +
  `draftSession.refetch`. A `PrHeader`/`PrDetailView` test asserting "submit success triggers a
  PR-detail reload" is red on main (only the draft session refetched) → green. Because a fake-stream
  unit test would pass even if `EVENT_TYPES` is missing the `draft-submitted` entry, also assert the
  registry wiring directly (e.g. `EVENT_TYPES` includes `'draft-submitted'`) so the silent-no-op
  failure mode is caught by a test, not just review.

## Out of scope / deferred

- **Non-success outcomes intentionally do not publish `DraftSubmitted`, and no comment strands.**
  `SubmitOutcome.Failed` / `StaleCommitOidRecreating` / `ForeignPendingReviewPromptRequired` do not
  reach the `DraftSubmitted` publish (`PrSubmitEndpoints.cs:225`). Any threads/replies those paths
  attached live on an **unsubmitted** pending review — invisible on GitHub until `Finalize` runs, so
  there is nothing to "surface as posted." Their existing `StateChanged(PendingReviewFields)` publish
  (`PrSubmitEndpoints.cs:237,249`) drives the in-flight-recovery surface. So skipping the PR-detail
  refresh on these paths is correct, not a gap.
- No change to the atomic submit GraphQL pipeline, the `submit-progress` events, or the
  pending-review recovery surface.
- No new payload fields on `draft-submitted` beyond `prRef` (deep-link by review id is a separate
  enhancement; the threat-model defense keeps the payload minimal).
- The `DraftSubmitted` forward-compat note in `SseEventProjection.cs` becomes live wiring; no other
  forward-compat stubs are touched.

## Related

- #353 — Overview comment-not-appearing after post-now (added `RootCommentPostedBusEvent →
  Invalidate` + `useRootCommentPostedSubscriber`); this is the same fix for the submit path.
- #344 — PR-detail manual Refresh / `PrDetailLoader.RefreshAsync` force-fresh bypass.
- #302 — decouple single-comment posting; #324 — PR-root draft predicate.
