# #611 — `/reload` head-shift guard is silently bypassed when the active-PR cache is cold

**Issue:** [#611](https://github.com/prpande/PRism/issues/611) · **Tier:** T2 · **Risk:** hands-off
**Status:** spec for one backend correctness fix surfaced by the epic #317 follow-on sweep. Single clear cause, prescribed remedy direction, checkable acceptance criteria. One design choice (cold-cache response shape) — resolved with the owner: backend-only `409`, no FE change.

## The bug

`PRism.Web/Endpoints/PrReloadEndpoints.cs` (Phase 2, inside `store.UpdateAsync`):

```csharp
var cached = activePrCache.GetCurrent(prRef);
if (cached is not null && cached.HeadSha != request.HeadSha)
{
    currentHeadShaForRetry = cached.HeadSha;   // → 409 reload-stale-head, FE auto-retries
    return state;
}
// …otherwise proceed to reconcile against request.HeadSha…
```

The head-shift guard (spec §5.4 / S4 Task 46) exists so that when the poller has
observed a newer head between Phase 1's read and the Phase 2 apply, the endpoint
returns `409` and the FE re-fetches instead of reconciling against a stale head.
But the comparison is gated on `cached is not null`. When `GetCurrent(prRef)`
returns **null** — the cache is cold: the PR's poller hasn't completed its first
tick, or the cache was cleared by `POST /api/auth/replace` (`IActivePrCache.Clear`)
— the entire head-shift check is skipped and the reconcile proceeds against the
**client-supplied, unverified** `request.HeadSha`. A well-formed but stale head
then drives reconciliation against the wrong head (draft-state corruption)
instead of the intended retry. A cold cache silently degrades the guard from
"fail-safe" to "trust the client."

## Two non-obvious facts that drove the design

1. **The cold-cache window is reachable but narrow** — a race, not the routine
   first-interaction window. The FE's reload `headSha` comes from
   `data?.pr.headSha` — the **PR-detail snapshot** (`PrDetailView.tsx:162`) — a
   *different* source than the poller-populated `activePrCache`, and the
   PR-detail load surfaces a head immediately while the `ActivePrPoller` first
   tick (30s cadence) can lag. That seems to make a fresh-PR reload routinely
   cold — but the **manual Reload affordance is itself poll-gated**: it is
   rendered only by `BannerRefresh` (gated on `updates.hasUpdate`) and
   `BannerTransition` (merged/closed), both driven by `pr-updated` SSE events,
   and the poller emits `pr-updated` in the *same* iteration as `_cache.Update`
   (`ActivePrPoller.cs:205` vs `:237`). So by the time the Reload button is
   visible, the cache is warm for that PR. (The `ErrorModal` Reload path has
   `data == null` → `headSha === null` → `reconcile.reload()` no-ops, so it
   can't reach a cold reconcile either.) The genuinely reachable cold paths are
   therefore the narrow ones the issue names: the post-auth-replace
   `IActivePrCache.Clear()` while a `pr-updated` banner from *before* the replace
   is still showing, and the subscriber-eviction race (`Retain()` drops a
   snapshot for a PR whose banner persists in a backgrounded tab). This matches
   the issue's own "Major/medium-confidence, narrower than steady-state"
   framing — not a routine failure.

2. **The existing happy-path endpoint tests pass today only *because* of this
   bug.** `Reload_happy_path_returns_full_session_dto`,
   `Reload_writes_tab_stamp_under_caller_tab_id`,
   `Reload_uppercase_sha_is_accepted_not_422`, and the concurrent-requests test
   run against the **default** `ActivePrCache`, which is cold in tests (no poller
   runs). They expect `200`. Tightening the guard turns those into the new `409`,
   so they must be reworked to register a *populated* fake cache — which is also
   acceptance criterion (3).

## Fix (Approach A — backend-only `409`)

Treat a null cache as "cannot verify head," not "head matches." Restructure the
guard so the cold-cache case returns a distinct retryable conflict **before** the
apply (before the tab-stamp write), and the diverged-head case keeps its existing
`reload-stale-head` shape:

```csharp
var cached = activePrCache.GetCurrent(prRef);
if (cached is null)
{
    // Cold cache: the poller hasn't observed a head for this PR yet (subscribe→poll
    // race, or a post-auth-replace Clear). We cannot verify request.HeadSha against a
    // known-good head, so we must NOT reconcile against an unverified head (#611).
    // Signal a retryable conflict; the FE retries once the first poll lands.
    headUnverified = true;
    return state;
}
if (cached.HeadSha != request.HeadSha)
{
    currentHeadShaForRetry = cached.HeadSha;
    return state;
}
```

After `UpdateAsync`, the cold-cache branch returns
`409 { error: "reload-head-unverified" }` (a distinct flag from
`currentHeadShaForRetry`, which stays the diverged-head signal):

```csharp
if (headUnverified)
    return Results.Json(new ReloadHeadUnverifiedResponse(), statusCode: StatusCodes.Status409Conflict);
if (currentHeadShaForRetry is not null)
    return Results.Json(new ReloadStaleHeadResponse(currentHeadShaForRetry), statusCode: StatusCodes.Status409Conflict);
```

The new response record mirrors `ReloadStaleHeadResponse`'s shape — an `error`
discriminator the FE switches on — but carries **no** `currentHeadSha` (the whole
point is that we do not know the current head):

```csharp
internal sealed record ReloadHeadUnverifiedResponse
{
    public string Error { get; } = "reload-head-unverified";
}
```

**No side effects on the cold path.** The cold-cache branch `return state`s from
the `UpdateAsync` transform *before* the tab-stamp write, leaving `updatedSession`
null — exactly like the existing diverged-head branch. Because `bus.Publish` is
gated on `updatedSession is not null`, the cold-cache 409 writes **no tab stamp**
and publishes **no `StateChanged`** event. This no-op contract is pinned as an
acceptance criterion and a test below, not just left implied by the return
ordering.

### Why these specific choices

- **Key on `GetCurrent() != null`, not `IsSubscribed`.** The issue floats an
  `IsSubscribed`/first-poll precondition. `IsSubscribed` is true after subscribe
  but *before* the first poll, so it would still admit the cold-cache window. A
  non-null snapshot is the true "first poll completed" signal — the stronger
  precondition. `IsSubscribed` is not used.
- **A new error code `reload-head-unverified`, not a re-used `reload-stale-head`.**
  Stale-head means "the head moved to *X*" and carries `currentHeadSha`; here we
  do not know the current head, so reusing that shape (with an empty/placeholder
  sha) would be a lie and would trip the existing test that pins a present
  `currentHeadSha`. A distinct code is honest and debuggable.
- **Status `409`, for consistency** with the endpoint's two other retryable
  conflicts (`reload-in-progress`, `reload-stale-head`).
- **No FE change.** `parseReloadConflictKind` (`api/draft.ts`) maps any
  unrecognized `409` error to the generic `'conflict'` kind, and `useReconcile`
  surfaces it as `BANNER_GENERIC` ("Couldn't reload — please try again."). The
  user retries, and **once the next successful poll lands** the cache is warm and
  the reload succeeds. This is honest only when the poll *does* eventually
  succeed; a persistently-failing poll (see Residual risks) keeps reload at 409
  — which is the intended fail-safe, since reconciling against an unverifiable
  head is the exact corruption this fixes. **Owned regression:** in the narrow
  reachable window (post-auth-replace clear, eviction race), a reload that
  previously *succeeded* (unsafely) now shows the generic error banner, which is
  visually indistinguishable from a true network/5xx failure. For a single-user
  local tool, trading a rare silent draft-corruption for a rare honest
  retry-banner is the right call; a bespoke FE banner / delayed auto-retry for
  `reload-head-unverified` is the clean follow-up (owner chose backend-only) and
  is out of scope here.

## Out of scope / non-goals

- **FE-side handling of `reload-head-unverified`** (tailored banner, delayed
  auto-retry). Deferred; the generic retry banner is the fail-safe degrade.
- **Blocking the endpoint to wait for the first poll.** Rejected: the endpoint
  must not block on a background service; fail-fast-retryable is simpler and
  matches the existing conflict pattern.
- **`HighestIssueCommentId` / markAllRead semantics** — unrelated deferred work
  on the same interface.

## Residual risks (acknowledged, not closed here)

- **Persistently-null cache → persistent 409.** The cache stays null not only
  during the first-poll lag but if the poll keeps failing for a PR: a whole-tick
  abort on rate-limit / transport / poison payload (`ActivePrPoller.cs:155-171`,
  retains last-known and publishes nothing) or a per-alias batch drop
  (`:176`, a subscribed PR the batch never returns). In those states reload
  returns `reload-head-unverified` on every attempt until the poll recovers. This
  is the **intended** fail-safe — refusing to reconcile against a head we cannot
  verify is the whole point — but it is a real behavior change from today's
  "always reconciles (unsafely)", so the spec does not claim auto-recovery is
  guaranteed.
- **Diverged-head branch trusts the cached head as authoritative.** The retained
  `cached.HeadSha != request.HeadSha` path returns the *cached* sha for the FE to
  retry with, assuming the cache is the newer head. If the PR-detail-sourced
  client head were newer than the last poll's cached head, that auto-retry would
  reconcile against a staler head. This is **pre-existing** behavior on the
  diverged-head path (untouched by this fix) and out of scope; flagged as a
  candidate follow-up, not closed here.

## Test plan (`tests/PRism.Web.Tests/Endpoints/PrReloadEndpointTests.cs`)

- **New (red on main):** cache null + stale request head ⇒ `409` with
  `"error":"reload-head-unverified"`. Register a fake `IActivePrCache` whose
  `GetCurrent` returns null (cold). On main this currently returns `200` (silent
  reconcile) — the red. AC (1) + (2).
- **New — no side effects on the cold path:** after the cold-cache `409`, the
  session's `TabStamps` does NOT contain the caller's tab id (no stamp written)
  and no `StateChanged` is observed. Pins AC (4). (Red on main: today's silent
  reconcile both stamps and publishes.)
- **Rework existing happy-path tests** to register a *populated* fake cache whose
  `GetCurrent` returns a snapshot with `HeadSha == request.HeadSha`, so they
  exercise the real production happy path (cache populated + matching head ⇒
  `200`). AC (3). The existing diverged-head test (`reload-stale-head`) is
  unchanged.
- **Test-factory pattern:** the reworked happy-path tests need a per-test
  `IActivePrCache` override, which the shared `IClassFixture` `_factory`
  (process-wide singleton) cannot take. Switch them to the
  `WithWebHostBuilder(b => b.ConfigureServices(s => { s.RemoveAll<IActivePrCache>();
  s.AddSingleton<IActivePrCache>(fake); }))` + `CreateAuthenticatedClient` pattern
  already used by `Reload_with_diverged_cached_head`. Extend the
  `FakeCacheWithSnapshot` helper (or add a cold-cache fake) to cover the null
  case.

## Acceptance criteria

1. Reload with a cold/null `activePrCache` does **not** reconcile against an
   unverified `request.HeadSha`.
2. Cache null + stale request head ⇒ retryable `409 reload-head-unverified`
   (not a silent reconcile).
3. Cache populated + matching head ⇒ reconcile proceeds, `200` (no regression).
4. The cold-cache `409` path has no side effects: no tab stamp, no `StateChanged`.

Full backend pre-push checklist (`.ai/docs/development-process.md`) before PR.
