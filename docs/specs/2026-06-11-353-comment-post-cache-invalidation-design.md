---
title: "#353 — Posted root comment doesn't appear until the poller catches up (stale PR-detail snapshot cache)"
type: fix
origin: none
issue: 353
tier: T2
risk: backend-only (no UI-visual change)
date: 2026-06-11
---

# #353 — Root-comment post doesn't appear without a manual reload

## Symptom (as reported)

Post a comment on the **Overview tab** (PR-root conversation). It ships to GitHub
and the composer closes, but the new comment does **not** appear in the
conversation. It only shows up "after a manual PR reload." Expected: it appears on
its own, without changing the current sub-tab, scroll, or view state.

## Root cause (confirmed by code, not a timing guess)

The SSE→reload chain the issue describes is **fully intact and wired** — every link
checks out statically:

- Backend publishes `RootCommentPostedBusEvent` on success
  (`PrRootCommentEndpoints.cs:180`).
- `SseChannel` subscribes to it (`SseChannel.cs:74`) and `FanoutProjected` writes the
  `root-comment-posted` frame to **all** subscribers for that PR, including the
  posting tab (`SseChannel.cs:307-317` — no origin exclusion).
- The wire `PrRef` uses the same `e.PrRef.ToString()` every other (working) event
  uses (`SseEventProjection.cs:75`).
- The frontend registers the listener (`events.ts:71` — `'root-comment-posted'` is in
  `EVENT_TYPES`) and the subscriber compares `prRef` with the same
  `${owner}/${repo}/${number}` string every other working subscriber uses
  (`useRootCommentPostedSubscriber.ts:22-24`).
- `onPosted` is a stable `useCallback` wired to `usePrDetail.reload`
  (`PrDetailView.tsx:65`, `usePrDetail.ts:90`), which re-GETs `/api/pr/{ref}`.

So the issue's named suspects — "prRef string mismatch" and "fanout excludes the
origin" — are **red herrings**. The break is downstream of the reload, in the data
the GET returns:

`GET /api/pr/{ref}` → `PrDetailLoader.LoadAsync`, which serves a **snapshot cache
keyed by `(prRef, headSha, generation)`** (`PrDetailLoader.cs:107-108`). A posted
comment is a GitHub *issue comment*: it advances **neither `headSha` nor
`generation`**. So after the post, `reload()`'s GET hits the cache on the unchanged
key and returns the **stale pre-post snapshot**, whose `RootComments` does not
include the new comment.

The **only** trigger that invalidates the snapshot for a new comment is the
background `ActivePrPoller`: when it later polls and observes `CommentCountChanged`,
`OnActivePrUpdated` → `Invalidate` (`PrDetailLoader.cs:88-94`). That lags by up to a
poll interval. The in-app "Reload" button (`POST /reload`, `PrReloadEndpoints.cs`)
reconciles drafts and publishes `StateChanged` but **never touches the snapshot
cache** — so the comment "appearing after a manual reload" is really "appearing once
the poller has caught up, around the time the user reloaded." The author of the
loader anticipated exactly this: the constructor comment (`PrDetailLoader.cs:70-72`)
notes "**a new comment** does NOT change the head SHA, so a stale … snapshot would
survive every reload until the head advances," and relied on the poller to catch it.

## Fix

Make a **root-comment** post invalidate the PR-detail snapshot **promptly**, instead
of waiting for the poller — mirroring the loader's existing `OnActivePrUpdated` /
`OnConfigChanged` invalidation handlers.

`PrDetailLoader` subscribes (in its constructor) to `RootCommentPostedBusEvent` and
invalidates the affected PR's snapshot:

```csharp
// alongside the existing _activePrSubscription = eventBus.Subscribe<ActivePrUpdated>(...)
_rootCommentSubscription = eventBus.Subscribe<RootCommentPostedBusEvent>(OnRootCommentPosted);

// A posted root comment doesn't move headSha, so the (prRef, headSha, generation)
// cache key is unchanged — evict explicitly so the SSE-driven reload re-fetches fresh
// detail instead of waiting for the ActivePrPoller's CommentCountChanged
// (OnActivePrUpdated). Mirrors the _activePrSubscription invalidation pattern.
private void OnRootCommentPosted(RootCommentPostedBusEvent evt) => Invalidate(evt.PrRef);
```

`Dispose` tears down `_rootCommentSubscription` alongside `_activePrSubscription`, and
its summary count updates from "two subscriptions" to "three" (the `_configStore.Changed`
handler + the two `Subscribe` disposables).

### Scope: root comment only — NOT SingleCommentPostedBusEvent

An earlier draft of this fix also invalidated on `SingleCommentPostedBusEvent` (diff
post-now, #302), on the theory that it would make diff optimistic placeholders
reconcile promptly. **That is wrong and is explicitly excluded**, for two reasons:

1. **It is inert.** Unlike root comments, the single-comment path has **no immediate
   client reload trigger**: there is no `single-comment-posted` SSE projection arm
   (`SseEventProjection.cs` has no case for it), `SseChannel` never subscribes to it,
   and no frontend subscriber calls `reload` on it. The only client reload for diff
   comments is poller-driven (`pr-updated`), and the `ActivePrPoller` path **already**
   invalidates the cache via `OnActivePrUpdated`'s `CommentCountChanged`. So evicting
   on `SingleCommentPostedBusEvent` duplicates an invalidation that already happens by
   the time any client reload fires — zero benefit.
2. **It risks a regression.** `PrDetailLoader`'s `OnActivePrUpdated` guard
   (`PrDetailLoader.cs:83-94`) exists specifically because evicting a *live* snapshot
   makes `/file` and `/viewed` return **422 snapshot-evicted** (Copilot PR #150).
   Those are **diff-tab** endpoints — exactly where a diff comment is posted. Evicting
   on every diff post-now would open a 422 window on the active diff tab for no
   reconciliation gain.

The diff surface is **not broken**: its comments render via an optimistic placeholder
and reconcile on the poller's cadence (a minor lag, not a missing comment). If that
lag is deemed worth removing, the correct fix is to wire a real client reload for the
diff surface (a `single-comment-posted` SSE projection arm + `SseChannel`
subscription + a frontend subscriber) — a larger change that belongs in its own issue,
not folded into #353. **Follow-up:** file an issue for "diff post-now placeholder
reconciles only on poller cadence" if the lag warrants it.

### Ordering correctness

The endpoint publishes the bus event, then the SSE frame is fanned out. The loader's
`Invalidate` runs **synchronously inside `bus.Publish`** — confirmed: `ReviewEventBus.Publish`
snapshots its subscriber list under a lock and invokes each handler inline via
`foreach` (`ReviewEventBus.cs:8-17`). The SSE fan-out write is **fire-and-forget
async** (`_ = WriteAndEvictOnFailureAsync(...)`, `SseChannel.cs:316`), so the actual
network write happens *after* `Publish` returns. Therefore the cache is invalidated
before the client can possibly receive the frame and issue its reload GET — regardless
of bus subscriber registration order.

**The guarantee specifically depends on the SSE write being fire-and-forget.** If a
future change ever `await`s the SSE write inside the bus handler (making fan-out block
`Publish`), re-validate this ordering — the invalidate-before-reload property would no
longer be automatic.

### Why not optimistic render

The reported defect is a stale **server cache**, not a missing client render. The
minimal correct fix is server-side cache invalidation. Optimistic render (the issue's
"direction 2") would add a placeholder + dedup-reconciliation surface mirroring
#302's complexity for no additional correctness here — explicitly out of scope (owner
decision (b)).

## Files

- Modify: `PRism.Core/PrDetail/PrDetailLoader.cs`
  - One new `IDisposable` field (`_rootCommentSubscription`).
  - One `eventBus.Subscribe<RootCommentPostedBusEvent>(OnRootCommentPosted)` line in
    the constructor.
  - One `OnRootCommentPosted` handler → `Invalidate(evt.PrRef)`.
  - Dispose `_rootCommentSubscription` in `Dispose()`; update the method's summary
    docstring count from "two subscriptions" to "three".
- Test: the existing `tests/PRism.Core.Tests/PrDetail/PrDetailLoaderTests.cs` —
  regression covering the cache-invalidation handler.

## Test plan

**Unit (primary), in `PrDetailLoaderTests.cs`:**

Use the **real** `ReviewEventBus`, **not** the directory-local `FakeReviewEventBus` —
that fake is record-only (`Subscribe` returns a no-op disposable and never invokes
handlers), so it cannot drive the loader's invalidation. Construct the bus locally and
inject it so the test holds a reference to `Publish` on (the proven pattern at
`PrDetailLoaderTests.cs:137-138` / `:173-174`); `MakeLoader`'s `bus ?? new
ReviewEventBus()` default builds an internal bus the test can't reach.

1. `var bus = new ReviewEventBus();` then `var loader = MakeLoader(review, bus: bus);`
   (real bus + fake `IPrReader`).
2. `LoadAsync(prRef)` once to populate the snapshot cache; assert
   `TryGetCachedSnapshot(prRef)` is non-null.
3. `bus.Publish(new RootCommentPostedBusEvent(prRef, 0L))` — dispatched synchronously.
4. Assert `TryGetCachedSnapshot(prRef)` is now **null** (invalidated).
5. Negative: publish `RootCommentPostedBusEvent` for a **different** prRef and assert
   this prRef's snapshot is **not** evicted.

**e2e note (not added in this slice):** the deterministic fake harness can't assert
"comment appears" end-to-end because `FakePrReader.GetPrDetailAsync` hardcodes
`RootComments: Array.Empty` and `FakeReviewSubmitter.CreateIssueCommentAsync` never
feeds the posted comment back into the read model. A faithful e2e would require
extending the fake reader to reflect posted root comments — a test-infra change
larger than this fix. The unit regression covers the cache-invalidation mechanism
(the link that breaks); live confirmation is the owner's B1 dogfood against the real
token store.

## Out of scope

- `SingleCommentPostedBusEvent` / diff post-now reconciliation (see Scope above —
  separate issue if the poller-cadence lag warrants it).
- Optimistic render on the Overview composer (owner decision (b)).
- #352 (Overview composer `.composer-frame` parity) and #354 (Drafts tab
  `CommentCard` alignment) — separate visual-parity slice (Slice 2).

## Risks

- **GitHub read-after-write / re-cache race.** Prompt invalidation removes the
  cache-*staleness* cause, but it does not guarantee the immediate re-fetch reflects
  GitHub's write. `CreateIssueCommentAsync` creates the comment on GitHub before the
  endpoint returns (`PrRootCommentEndpoints.cs:138`), but GitHub serves reads from
  replicas that can briefly lag a write; if the SSE-driven reload's re-fetch lands on
  a not-yet-propagated replica, `LoadAsync` re-caches a comment-less snapshot under the
  same unchanged `(prRef, headSha, generation)` key, and it stays stale until the
  poller's `CommentCountChanged` heals it. This reproduces the original symptom in a
  *much smaller* window. The poller remains the correctness backstop; **B1 dogfood
  against the real token store is what validates the read-after-write timing** (the
  deterministic fake cannot). Acceptable: strictly better than today, with the same
  backstop.
- **`/file` / `/viewed` eviction window (root-comment path).** Invalidating on
  root-comment post evicts the snapshot, so a `/file` or `/viewed` call landing before
  the reload GET re-populates it would 422 snapshot-evicted. Low risk here because root
  comments are posted from the Overview tab (the user is not driving diff `/file` /
  `/viewed`), and the SSE-driven reload re-populates within one round trip. This is the
  precise risk that excludes `SingleCommentPostedBusEvent` from scope (diff tab = high
  exposure). The residual exposure on the root-comment path is a *concurrent second
  window* holding the same PR's Files tab open while the first posts a root comment — a
  `/viewed` toggle there could land in the eviction window. It's narrow (requires a
  second active window mid-post) and bounded by the same one-round-trip re-population
  plus the poller backstop.
