# PR-detail manual Refresh button — design (#344)

**Issue:** [#344](https://github.com/prpande/PRism/issues/344) — deferred PR-detail half of
[#311](https://github.com/prpande/PRism/issues/311) (inbox manual refresh, shipped as #341).
**Tier:** T3. **Risk:** gated **B1 (UI-visual)** — adds a user-visible header control; the
backend touches the `PrDetailLoader` snapshot cache + a new endpoint, which is *not* a B2
risk surface (no auth/PAT, reviewer-atomic submit, persisted schema, cross-tab stamp, or
desktop sidecar). Per the issue-resolution workflow, B1 pauses for the human at the visual
gate after green-and-ready.

## 1. Problem

PR-detail has three *reactive* reload paths but no *proactive* one:

| Path | Trigger | What it does |
|------|---------|--------------|
| `BannerRefresh` → `handleReload` | poller SSE detected head/comment/state change | `updates.clear()` + `reload()` + `reconcile.reload()` |
| `useActivationTransition` | user switches **back** to the tab | `reload()` + `updates.clear()` |
| auto-reload (`#116`) | background merge/close detected | `reload()` |

All three only fire when *something already told the UI to reload*. There is no "I don't
trust what's on screen — re-read this PR from GitHub now" control. The user must close and
reopen the PR (or wait for the 30 s poller) to force a fresh pull.

**Why a plain `reload()` is not enough.** `reload()` → `GET /api/pr/{ref}` →
`PrDetailLoader.LoadAsync`, whose snapshot cache is keyed by `(prRef, headSha, generation)`.
When nothing is flagged, the cache is still warm and the head SHA is unchanged, so `LoadAsync`
**re-serves the same stale snapshot** — no GitHub round-trip. The reactive paths only get
fresh data because the event that triggered them (`ActivePrUpdated` / `RootCommentPosted`)
*already evicted* the loader cache (`PrDetailLoader.OnActivePrUpdated` / `OnRootCommentPosted`).
A proactive refresh has no such prior eviction, so it must force the freshness itself — exactly
the role the inbox's `hardRefresh: true` plays for `/api/inbox/refresh`.

## 2. The mechanism: `PrDetailLoader`, not `ActivePrPoller`

The issue named `ActivePrPoller` as the seam to add an immediate-trigger to, by analogy to
`InboxRefreshOrchestrator.RefreshAsync`. That analogy breaks against the code:

- On the **inbox**, the poller and the displayed-data holder are the **same object**:
  `InboxRefreshOrchestrator` runs the cadence loop *and* owns `Current` (the `InboxSnapshot`
  that `GET /api/inbox` returns). "Refresh the inbox" = call its `RefreshAsync`.
- On **PR-detail** they are **split**:
  - `PrDetailLoader` is the **data holder** (`GET /api/pr/{ref}` → `LoadAsync`; the displayed
    `PrDetailDto` snapshot).
  - `ActivePrPoller` is a **lightweight change-watcher** — it cheap-probes head-SHA /
    comment-count on a shared cadence and emits `ActivePrUpdated` SSE events. It holds **no
    displayed snapshot**.

Therefore kicking `ActivePrPoller` would **not** refresh on-screen data: it re-probes and only
emits an event (which evicts the loader cache) *if it detects a change*. With no change, it
emits nothing, the loader cache stands, and a follow-up `GET` re-serves the stale snapshot.

**The correct analog of `InboxRefreshOrchestrator.RefreshAsync` is a new
`PrDetailLoader.RefreshAsync(prRef)`** — a forced-fresh fetch that bypasses the snapshot
cache and atomically replaces it. **No `ActivePrPoller` change at all.** Because the loader is
inherently per-`prRef`, the issue's "one-PR-vs-all targeting decision" simply does not arise.

## 3. Backend

### 3.1 `PrDetailLoader.RefreshAsync`

Add a public method that mirrors `LoadAsync`'s fetch+compose path but **skips the cache read
and the cheap `PollActivePrAsync` head-probe** (we are force-fetching detail anyway, and
`detail.Pr.HeadSha` is the real head), then **overwrites** the cached snapshot rather than
`GetOrAdd`-ing it (force-fresh must win over any concurrently-cached entry).

```csharp
/// <summary>
/// Force-refreshes the snapshot for <paramref name="prRef"/>, bypassing the snapshot cache
/// (#344 manual Refresh). Re-fetches PR detail + timeline, re-clusters, and atomically
/// REPLACES the cached snapshot (overwrite, not GetOrAdd) so a warm cache with an unchanged
/// head SHA still yields fresh data — the proactive analog of the inbox's hardRefresh.
/// Returns null when the PR no longer exists (GetPrDetail → null), mapped to 404 by the
/// endpoint. Diffs are content-addressed by SHA and never stale, so they are left in place.
/// </summary>
public async Task<PrDetailSnapshot?> RefreshAsync(PrReference prRef, CancellationToken ct)
{
    ArgumentNullException.ThrowIfNull(prRef);
    var generation = Volatile.Read(ref _generation);
    var detail = await _review.GetPrDetailAsync(prRef, ct).ConfigureAwait(false);
    if (detail is null) return null;

    var snapshot = await ComposeSnapshotAsync(prRef, detail, generation, ct).ConfigureAwait(false);

    // If InvalidateAll ran mid-flight (config hot-reload), our snapshot is keyed to a stale
    // generation — return it uncached so the caller still gets fresh data; the next LoadAsync
    // re-caches under the current generation. Mirrors LoadAsync's generation re-check.
    if (Volatile.Read(ref _generation) != generation) return snapshot;

    var realKey = CacheKey(prRef, detail.Pr.HeadSha, generation);
    _snapshots[realKey] = snapshot;          // overwrite — force-fresh wins
    _snapshotKeyByPrRef[prRef] = realKey;
    return snapshot;
}
```

`ComposeSnapshotAsync` is the timeline-fetch + clustering + compose block **extracted from the
existing `LoadAsync`** (current lines ~145–160) into a private helper used by both methods, so
the two cannot drift:

```csharp
private async Task<PrDetailSnapshot> ComposeSnapshotAsync(
    PrReference prRef, PrDetailDto detail, int generation, CancellationToken ct)
{
    var timeline = await _review.GetTimelineAsync(prRef, ct).ConfigureAwait(false);
    var commitDtos = timeline.Commits.Select(c =>
        new CommitDto(c.Sha, c.Message, c.CommittedDate, c.Additions, c.Deletions)).ToArray();
    var commitShaSet = new HashSet<string>(timeline.Commits.Select(c => c.Sha), StringComparer.Ordinal);
    var (quality, iterations) = DetermineQuality(timeline, commitShaSet);
    var finalDetail = detail with
    {
        ClusteringQuality = quality, Iterations = iterations, Commits = commitDtos,
    };
    return new PrDetailSnapshot(finalDetail, detail.Pr.HeadSha, generation);
}
```

`LoadAsync` is refactored to call `ComposeSnapshotAsync` then `GetOrAdd` (its existing
cold-load-race collapse semantics are preserved). **No behavior change to `LoadAsync`** — this
is a pure extraction, asserted by the existing loader tests staying green.

### 3.2 Endpoint: `POST /api/pr/{owner}/{repo}/{number}/refresh`

Mapped in a new `PrRefreshEndpoints.cs` (mirrors `InboxEndpoints` `/refresh`; kept out of
`PrDetailEndpoints` so the new write-style endpoint and the read GETs stay separated, matching
the existing `PrReloadEndpoints.cs` split).

```csharp
app.MapPost("/api/pr/{owner}/{repo}/{number:int}/refresh",
    async (string owner, string repo, int number, PrDetailLoader loader, CancellationToken ct) =>
{
    var prRef = new PrReference(owner, repo, number);
    var before = loader.TryGetCachedSnapshot(prRef);   // reference identity of committed snapshot
    try
    {
        var snap = await loader.RefreshAsync(prRef, ct).ConfigureAwait(false);
        return snap is null
            ? Results.Problem(type: "/pr/not-found", statusCode: 404)
            : Results.Ok();                            // fresh snapshot committed (incl. no-change)
    }
    catch (RateLimitExceededException)
    {
        // Honest-completion (semantic C, same as /api/inbox/refresh): we cannot cheaply prove
        // "*this* call committed", so the success test is "did the committed view ADVANCE past
        // where it was when the request arrived?". A concurrent poller/GET that advanced it →
        // the view is fresh → 200. If it did not advance, the manual pull was rate-limited and
        // nothing got fresher → 503.
        return ReferenceEquals(loader.TryGetCachedSnapshot(prRef), before)
            ? Results.Problem(title: "PR refresh rate-limited", statusCode: 503, type: "/pr/refresh-rate-limited")
            : Results.Ok();
    }
    catch (OperationCanceledException) { throw; }       // client aborted; not an error
    catch (Exception)
    {
        return Results.Problem(title: "PR refresh failed", statusCode: 503, type: "/pr/refresh-failed");
    }
});
```

Returns an empty `200` (not the body): the frontend reloads via the existing `usePrDetail.reload()`
→ `GET /api/pr/{ref}`, which now cache-hits the freshly-committed snapshot. This mirrors the
inbox's two-step (POST refresh → GET reload), reuses the canonical reload path, and keeps the
endpoint's single responsibility "make the backend fresh".

**Note for implementation:** confirm whether `IPrReader.GetPrDetailAsync` / `GetTimelineAsync`
surface a GitHub 429 as `RateLimitExceededException` (the inbox path does, from its CI probe).
If they do not, the typed `catch` is inert and the generic `catch` returns the same `503
/pr/refresh-failed` — the contract holds either way; the typed branch only buys the more
precise `rate-limited` `type`.

## 4. Frontend

### 4.1 `usePrDetailRefresh` hook (mirror of `useInboxRefresh`)

New `frontend/src/hooks/usePrDetailRefresh.ts`, structurally identical to `useInboxRefresh`
(re-entrancy guard, `MIN_INTERVAL_MS` success-only lockout, `TIMEOUT_MS` abort, `announce`
strings, `justRefreshed` morph window with `CONFIRM_MS ≥ MIN_INTERVAL_MS`):

```ts
export function usePrDetailRefresh({ prRef, reload, clearUpdates, onError }: Options): PrDetailRefreshState {
  // ...same shape as useInboxRefresh...
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    if (Date.now() - lastSuccessAt.current < MIN_INTERVAL_MS) return;
    inFlight.current = true; setIsRefreshing(true); setAnnounce('Refreshing PR…');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      await prDetailApi.refresh(prRef, controller.signal);
      await reload();          // usePrDetail re-GET — now hits the fresh snapshot
      clearUpdates();          // dismiss any latched "update available" banner
      lastSuccessAt.current = Date.now();
      setAnnounce('PR refreshed'); setJustRefreshed(true);
      // ...CONFIRM_MS reset of justRefreshed...
    } catch {
      setAnnounce(''); onError("Couldn't refresh this PR. Try again.");
    } finally { clearTimeout(timer); inFlight.current = false; setIsRefreshing(false); }
  }, [prRef, reload, clearUpdates, onError]);
  return { isRefreshing, justRefreshed, announce, refresh };
}
```

**Deliberately no `reconcile.reload()` leg.** Draft-vs-head reconciliation is the head-shift
draft-safety operation owned by `BannerRefresh` / `handleReload`; the proactive button's
contract is "re-pull the displayed detail". This matches `useActivationTransition` (line
119–125), which also does `reload() + updates.clear()` without reconcile. If a manual refresh
surfaces a head shift, the next poller tick raises `BannerRefresh` and the user reconciles
drafts on an explicit Reload — same as today's focus-refetch behavior.

API client: add `refresh(prRef, signal)` →
`apiClient.post(`/api/pr/${owner}/${repo}/${number}/refresh`, undefined, { signal })`
(mirrors `inboxApi.refresh`).

### 4.2 Shared `RefreshButton`

Generalize the existing `frontend/src/components/Inbox/RefreshButton.tsx` (currently hardcodes
"inbox" labels + `inbox-refresh-button` testid) to take `label`, `refreshingLabel`, and
`testId` props, and **relocate it to `frontend/src/components/controls/RefreshButton.tsx`**
(the design-system controls home). Inbox passes its existing strings; PR-detail passes
`"Refresh PR"` / `"Refreshing PR…"` / `pr-refresh-button`. The rendered markup
(`btn btn-icon`, spinner/checkmark/arrow morph) is **byte-identical for the inbox** when given
the same strings, so no inbox visual baseline changes — only the import path moves. This avoids
duplicating the SVG morph logic, consistent with the codebase's shared-core ethos (#326).

*(Fallback if the relocation churn is unwanted: a `PrDetailRefreshButton` sibling that imports
the same SVGs. Recommended path is the shared control.)*

### 4.3 Wiring in `PrDetailView` / `PrHeader`

- `PrDetailView` instantiates `usePrDetailRefresh({ prRef, reload, clearUpdates: updates.clear,
  onError: (m) => toast.show({ kind: 'error', message: m }) })` (reusing `useToast`, the same
  error surface as the inbox — a transient toast, not a modal; aligns with the
  snackbar-over-banner preference).
- Render an `sr-only` `role="status" aria-live="polite"` announcer for `announce` (mirrors
  `InboxPage` line 104–113).
- Extend the per-tab `LoadingBar` to `active={active && (isLoading || isRefreshing)}` so the
  bar reflects a background refresh (mirrors inbox `isLoading || isRefreshing`).
- Pass `onRefresh={refresh}`, `isRefreshing`, `justRefreshed` into `PrHeader`, which renders the
  shared `RefreshButton` inside its `prActions` cluster.

**Placement (the B1 visual decision).** `prActions` today renders
`<OpenInGitHubButton/> <ReviewActionButton/>`. Default: insert the icon-only `RefreshButton`
**before** `OpenInGitHubButton` (two low-weight icon utilities to the left of the emphasized
Review split-button). #291 decluttered this bar, so the exact slot/order is settled at the B1
gate with before/after light+dark screenshots rather than unilaterally.

## 5. Error handling & edge cases

- **Re-entrancy / spam-click:** synchronous `inFlight` ref guard + success-only
  `MIN_INTERVAL_MS` lockout (button also `disabled` while `isRefreshing`).
- **Timeout:** `AbortController` at `TIMEOUT_MS`; aborted fetch → `onError` toast.
- **404 (PR gone):** endpoint returns 404 → hook `catch` → toast "Couldn't refresh this PR."
  (The PR genuinely disappearing is already handled by the next `GET`'s 404 path / ErrorModal;
  the refresh just reports its own failure.)
- **503 (rate-limited / failed):** toast "Couldn't refresh this PR. Try again."
- **Read-only cross-tab presence:** the refresh path is a backend read + a GET reload; it does
  **not** mutate state, so (unlike `handleReload`'s reconcile leg) it is safe under
  `presence.readOnly` and needs no guard. The button stays enabled for a passive viewer.
- **Concurrent poller eviction:** if the poller evicts/advances the snapshot between `before`
  capture and the rate-limit catch, `ReferenceEquals` returns false → `200` (the view did
  advance) — the honest, correct outcome.

## 6. Testing

**Backend (xUnit):**
- `RefreshAsync` forces a fresh fetch on a **warm cache with unchanged head** (proves the
  bypass): seed a snapshot, stub `GetPrDetailAsync` to return a new instance, assert the cached
  snapshot is replaced (not the seeded one).
- `RefreshAsync` returns `null` when `GetPrDetailAsync` returns `null`.
- `RefreshAsync` returns the snapshot **uncached** when `_generation` is bumped mid-flight.
- `LoadAsync` behavior is unchanged after the `ComposeSnapshotAsync` extraction (existing
  loader tests stay green — the regression guard).
- Endpoint: `200` on success; `404` on not-found; `503 /pr/refresh-rate-limited` when
  `RateLimitExceededException` and the snapshot did **not** advance; `200` when it **did**
  advance (concurrent advance simulated); `OperationCanceledException` propagates (no 503).

**Frontend (vitest):** mirror `useInboxRefresh` tests — re-entrancy guard, min-interval lockout,
timeout abort, `announce` transitions, `justRefreshed` morph window, calls `reload` +
`clearUpdates` on success, `onError` on failure. `RefreshButton`: renders spinner/check/arrow
per state, correct `aria-label`/`testId`, `disabled` while refreshing (one shared test +
both label variants).

**e2e (Playwright, B1):** on a fixture PR, click Refresh → spinner → checkmark morph; capture
light + dark before/after screenshots of the header for the visual gate.

## 7. Scope & deferrals

**In scope:** `PrDetailLoader.RefreshAsync` + `ComposeSnapshotAsync` extraction;
`POST /api/pr/{ref}/refresh`; `usePrDetailRefresh`; shared `RefreshButton`; `PrHeader` /
`PrDetailView` wiring; announcer; toast error path; placement.

**Out of scope / deferred:**
- **No `ActivePrPoller` changes** (the issue's named seam — explicitly dropped, see §2).
- **No change to `POST /.../reload`** (the draft-reconcile-after-head-shift path) or to
  `BannerRefresh` / `handleReload`.
- **No reconcile leg on the proactive refresh** (§4.1 rationale).

## 8. Acceptance criteria

1. A manual Refresh control on the PR-detail header force-re-reads the PR from GitHub
   (bypassing the `(prRef, headSha, generation)` cache); an unchanged head SHA still yields
   fresh detail without reopening the PR.
2. Endpoint honest-completion: `200` once the fresh snapshot is committed (incl. no-change);
   `404` if the PR is gone; `503` for a rate-limit that did not advance the committed view.
3. Frontend mirrors the inbox refresh UX (timeout, success-only min-interval, `role="status"`
   announcer, icon-morph confirmation, decorative spinner, `aria-label`) and dismisses the
   "update available" banner on success.
4. No `ActivePrPoller` change; `LoadAsync` behavior unchanged (extraction-only).
5. Light + dark verified with before/after screenshots at the B1 gate.
