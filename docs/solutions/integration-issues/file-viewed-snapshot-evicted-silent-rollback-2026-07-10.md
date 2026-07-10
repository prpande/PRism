---
title: "File-tree reviewed tick silently un-ticks: POST /files/viewed 422s on a snapshot the comment-post path evicted"
date: 2026-07-10
category: integration-issues
module: PRism.Web,PRism.Core,frontend
problem_type: integration_issue
component: file_view_state
symptoms:
  - "Mark a file reviewed in the Files-tab tree → the tick paints, then reverts to unticked on its own a moment later"
  - "Intermittent: works normally, then every mark reverts for a stretch, then works again after switching PR tabs"
  - "Correlates with having posted inline review comments on the PR shortly before"
  - "No toast, no banner, no console error — the checkbox just flips back"
  - "Network → POST /api/pr/{ref}/files/viewed → 422 {\"type\":\"/viewed/snapshot-evicted\"}"
root_cause: cache_invalidation
resolution_type: code_fix
severity: medium
tags: [file-viewed, snapshot-cache, cache-invalidation, optimistic-update, silent-failure, error-surfacing, toast, active-pr-poller, sse]
related_solutions:
  - integration-issues/submit-review-silent-flash-mark-viewed-wireup-2026-05-15.md
---

# File-tree reviewed tick silently un-ticks itself after posting comments

## Problem

Marking a file reviewed in the Files-tab tree painted the tick optimistically, then reverted it
a second later. Intermittent — it worked most of the time, but after posting a couple of inline
review comments on the PR, *every* mark reverted until the user navigated away and back. Nothing
was shown to the user: no toast, no banner, no console warning.

## Root cause

`POST /api/pr/{ref}/files/viewed` refused to write unless a `PrDetailSnapshot` was currently
cached for the PR:

```csharp
var snapshot = loader.TryGetCachedSnapshot(prRef);
if (snapshot is null)
    return Results.Problem(type: "/viewed/snapshot-evicted", statusCode: 422);
```

The snapshot cache is keyed by `(prRef, headSha, generation)`. A comment moves no head SHA, so
`PrDetailLoader` subscribes to the bus and calls `Invalidate(prRef)` explicitly to keep the cache
from re-serving stale detail. Posting one inline comment therefore evicts the snapshot **twice**:

1. **Synchronously**, on `SingleCommentPostedBusEvent`. This one self-heals: the matching
   `single-comment-posted` SSE fires `usePrDetail.reload()`, whose `GET /api/pr/{ref}` re-populates
   the snapshot. The 422 window is the ~1–3 s of that round trip, and it is called out as accepted
   in `PrDetailLoader`'s constructor comment.
2. **Up to one poll cadence later** (`ActivePrPoller.ResolveCadence`, default 30 s), when the poller
   compares comment counts, sees `commentChanged == true` — *from the user's own comment* — and
   publishes `ActivePrUpdated`, which evicts again via `OnActivePrUpdated`.

Eviction 2 is the bug. Nothing reloads behind it: `useActivePrUpdates` only latches `hasUpdate: true`,
which paints the "PR updated" banner, and `PrDetailView` wires `reload()` to tab **re-activation**,
not to the banner. So while the user sat on the PR, the snapshot stayed evicted and every
`files/viewed` POST 422'd — until they clicked Reload or switched tabs away and back, which is
exactly what made the bug look random.

Because `CommentCount` counts inline review-thread comments only, this is specific to inline
comments. A root PR comment bumps `IssueCommentCount`, which does not trip `OnActivePrUpdated`'s
eviction gate, so root comments only produce the short self-healing window.

The failure was invisible because `useFileViewState.toggleViewed` treats **any** POST rejection as
"roll back the optimistic value", and the rollback toast promised by spec § 7.2 was deferred
(`docs/plans/2026-05-06-s3-pr-detail-read.md`). No frontend file referenced `/viewed/snapshot-evicted`
at all, even though `docs/specs/2026-05-06-s3-pr-detail-read-design.md` specified that on that code
the "frontend must refetch `/api/pr/{ref}` and retry".

## Resolution

Two changes, one per layer.

**Backend — re-hydrate instead of refusing.** `files/viewed` now mirrors what `/file` already did
under #510. The probe-then-load idiom (hand-copied at six sites) is extracted to
`PrDetailLoader.GetOrLoadSnapshotAsync`, which also encapsulates the non-obvious generation-race
rule: use `LoadAsync`'s return value, never re-probe the cache after it, because a generation flush
can return a non-null-but-uncached snapshot.

The prior comment claimed re-hydration "would mask" a stale-head write. It does not: `LoadAsync`
re-reads the *live detail* head — the same head the frontend stamped from `GET /api/pr` — so a body
stamped at a superseded head still fails the equality check and 409s. A regression test
(`Post_files_viewed_returns_409_stale_head_after_rehydrate_when_head_advanced`) locks that.
`snapshot-evicted` is retained for the one genuine failure: `LoadAsync` returning null because the
PR no longer exists.

**Rejected: sourcing the head from `IActivePrCache` instead.** Tempting — the endpoint needs only a
head SHA, and the poller keeps one in memory, so it would avoid `LoadAsync`'s three REST + two GraphQL
round-trips on the toggle path. But the cache holds the *poller* head, while the frontend stamps the
*detail* head, and `PrDetailLoader.LoadAsync` documents that the poll head "can also persistently lag
the detail's head if the active-PR poller is stale." Gating the 409 on a lagging poller head would
reject valid marks against the very code the user is looking at. Comparing like with like is worth the
round-trip on a path that only runs once per eviction.

**Frontend — never roll back silently.** `useFileViewState` takes an optional `onRollback` callback
(read through a ref so `toggleViewed` stays referentially stable), invoked from the POST rejection
handler *after* the generation guard, so a superseded late failure raises no phantom toast.
`PrDetailView` maps it to an error toast via the pure `viewedRollbackMessage`, which gives a 409 its
own recovery-shaped copy ("The PR has new commits — reload to update reviewed files.").

## Lessons

- **A cache that some callers treat as required and others as optional is a latent 422 generator.**
  `Invalidate` is called from six bus subscriptions. Whether that is safe depends entirely on whether
  a client reload happens to follow — a property that lives in a *different tier*. `/file` learned
  this in #510; `files/viewed` inherited the same shape and the same bug.
- **"Accepted small window" comments age badly.** The constructor comment accepted the evict→reload
  gap because the comment-post path does reload. Nobody re-checked the assumption when the poller
  became a second, unreloaded evictor of the same snapshot.
- **A background poller observing the user's own writes is an eviction source with no reload behind it.**
  Self-actions round-trip through GitHub and come back as "someone changed this PR".
- **An optimistic UI that rolls back on any rejection must say why.** A tick that un-ticks itself reads
  as data loss, not as a rejected write — and it hides a server error that had a typed code the whole
  time. Same failure shape as the swallowed 4xx in
  [submit-review-silent-flash](submit-review-silent-flash-mark-viewed-wireup-2026-05-15.md).

## Still open

- **`POST /api/pr/{ref}/mark-viewed`** keeps the `TryGetCachedSnapshot` → 422 dead-end. It is far less
  exposed: `usePrDetail` fires it fire-and-forget from inside the `getPrDetail` `.then()` that just
  warmed the snapshot, so its eviction window is a narrow race, and a failure logs to `console.warn`
  and self-heals on the next reload's re-stamp. Its comment was corrected — the old "re-hydrating
  would mask staleness" rationale was false — but the behavior is unchanged.
- **Four remaining hand-copies of the idiom** (`PrReviewThreadEndpoints.cs`, and the summarizer /
  ranker / annotator wiring in `PRism.Web/Composition/ServiceCollectionExtensions.cs`) should collapse
  onto `GetOrLoadSnapshotAsync`. Left out of this PR to keep the review surface to the bug.
- **Three `PrDetailLoader` cache gaps that this fix makes reachable on a hot path — [#754].** None are
  introduced here, but routing a per-checkbox-click endpoint through `LoadAsync` moves all three from
  rare-path warts to things a user can hit while ticking through a file list:
  1. **No per-key single-flight gate.** Concurrent misses each pay a full fetch + cluster (3 REST +
     2 GraphQL + a paced per-commit fan-out) and only dedupe at the closing `GetOrAdd` — whose own
     comment defers the `Lazy` gate "if dogfooding shows it". Dogfooding has now shown it.
  2. **Superseded-head snapshots are never evicted, and the `pollKey` probe can resurrect them.**
     `Invalidate` removes only the key the sidecar points at; `RefreshAsync` overwrites the sidecar
     without removing the prior head's entry. `LoadAsync`'s first fast path probes on the *poll* head
     and returns that entry **without calling `GetPrDetail`**. So the guarantee "re-hydration re-reads
     the live detail head, therefore a stale stamp still conflicts" is not universal. The endpoint's
     comment was corrected to say so rather than assert it — the very failure mode this whole write-up
     is about.
  3. **`LoadAsync`'s early returns skip the `_snapshotKeyByPrRef` sidecar write.** Unreachable on the
     ordinary eviction path (a `_snapshots` hit implies a sidecar hit, so `TryGetCachedSnapshot`
     short-circuits first); reachable only via the orphan in (2), where it costs a `PollActivePrAsync`
     round-trip per click until the poll head converges.

[#754]: https://github.com/prpande/PRism/issues/754
