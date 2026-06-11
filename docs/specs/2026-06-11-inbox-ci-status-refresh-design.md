# Inbox CI status never updates until the PR head moves — design

**Issue:** [#355](https://github.com/prpande/PRism/issues/355)
**Date:** 2026-06-11
**Tier / Risk:** T3 / hands-off (no architectural-invariant, auth, migration, cross-tab, sidecar, or security surface; no `design` label; CI-dot correctness is test-assertable, not eyeball).

## Problem

A PR's inbox CI dot gets stuck on `pending` and never advances to passing/failing as the run completes. Manual **Refresh** (#311) doesn't fix it. The only thing that ever updates the dot is a **new push** (head-SHA change).

### Root cause

`GitHubCiFailingDetector` caches every probed status in a process-lifetime dictionary keyed on `(PrReference, HeadSha)` with no expiry (`GitHubCiFailingDetector.cs:14,36,46`):

```csharp
var key = (c.Reference, c.HeadSha);
if (_cache.TryGetValue(key, out var cached)) return (Item: c, Ci: cached, Degraded: false);
var (ci, degraded) = await ProbeAsync(...);
if (!degraded) _cache[key] = ci;   // pinned for this SHA forever
```

The detector deliberately never caches a *degraded* read (transient 5xx / fine-grained 403 → re-probe next tick, `:40-46`). **But it does cache a fully-read `Pending`**: `ProbeAsync` returns `(Pending, false)` when both reads succeed (`:76`). So:

1. Push lands → checks start → probe reads `Pending` (non-degraded) → **cached** under that head SHA.
2. Checks finish → real state is `Passing`/`Failing` — but the cache still answers `Pending` for that SHA.
3. Every subsequent poll/refresh returns the cached `Pending`. The dot only moves when the head SHA changes (next push) and a fresh key misses the cache.

A check-run transitioning state does **not** bump the PR's `updated_at`, so nothing else in the pipeline observes a change either — which is why the head SHA is the *only* lever today.

### Why manual Refresh doesn't help

`/api/inbox/refresh` (#311) awaits the same `RefreshAsync` the poller runs (`InboxEndpoints.cs:78`), which calls `_ciDetector.DetectAsync` (`InboxRefreshOrchestrator.cs:160`) with no bypass path. A manual refresh re-enters the cache and gets the same pinned status. There is currently no way to make the inbox re-read CI for an unchanged head SHA.

### Out of scope — "and comments"

The original report also mentioned stale comment counts. `commentCount` is **not** head-SHA-gated: it is read fresh from the per-tick Search API result (`GitHubSectionQueryRunner.cs:145`), the section runner has no cache, and `ComputeDiff` already compares `CommentCount` (`InboxRefreshOrchestrator.cs:332`). So comment counts already refresh on the normal poll. If comments are *also* observed stale, the cause is separate (Search index lag / `updated_at` not bumping for some comment types) and needs its own repro — it is **not** folded into this fix.

## Decision

Two levers, scoped minimally:

### Lever 1 — stop pinning transient `Pending` (background correctness)

A `Pending` is inherently transient; it must not be cached the way a terminal result is. Treat it exactly like a degraded read: re-probe every sweep until it goes terminal, then cache the terminal value. This makes the background poll auto-advance CI with no user action.

*Rate-limit residual.* Re-probing `Pending` costs `2` HTTP calls per in-progress PR per poll tick (cadence default 60s, and the poller only ticks while the inbox has a subscriber) until the PR goes terminal — at which point it caches and stops. Against GitHub's 5,000/hr authenticated ceiling this is comfortable for typical authored-PR counts; the issue's "don't drop caching entirely" warning is honored because *terminal* statuses still cache without expiry. The relief valve for a pathological case (a user with dozens of simultaneously-in-progress PRs) is #322's bounding/TTL work, not this change.

### Lever 2 — manual Refresh forces a re-read (requested behavior)

The Refresh button forces a real re-read that bypasses the CI cache for all live PRs, then refreshes the stored value so the next background poll benefits. The background poll keeps its cheap cached path.

### Accepted limitation — same-SHA CI re-run

Lever 1 narrows the bug but does not eliminate every instance of it. A *terminal* status (`Passing`/`Failing`) is still cached forever under its head SHA. If a user clicks **"Re-run failed jobs"** (or re-runs a workflow) without pushing, the head SHA is unchanged, so the background poll keeps serving the stale terminal value (`GitHubCiFailingDetector.cs:37`) and never re-probes — only the manual Refresh button (Lever 2) or a process restart (empty cache) recovers it, and the user has no signal the dot is stale. We **accept this gap**: same-SHA re-runs are uncommon relative to push-driven transitions, and Lever 2 gives an on-demand fix.

The durable auto-recovery is a short TTL on terminal statuses (re-validate the same SHA after N minutes). It is **tracked in #361**, *not* tasked by #322: #322's cache acceptance criterion is "evict stale keys per tick (entries for PRs *absent* from the current snapshot are removed)" — eviction on absence, which never touches a still-present PR's same-SHA key. A re-validating TTL needs clock injection + per-entry timestamps that #322 does not introduce. #361 should land with or on top of #322's cache rework so the two don't fight. This is a *known, bounded* limitation — not the "buys nothing" framing an earlier draft used.

### Rejected alternatives (considered, cut)

- **TTL on cached terminal statuses, in *this* change.** Closes the accepted-limitation gap above, but needs a clock injected into the detector (it has none today) plus per-entry timestamps, and it overlaps #322's cache rework. Deferred to #322. Terminal statuses stay cached without expiry, as today, for rate-limit relief.
- **Busting the `GitHubPrEnricher` `(ref, UpdatedAt)` cache on hard refresh.** The issue flags this as "likely". Cut because it buys nothing for the reported bug: a check-run completing does not bump `updated_at`, so when the head SHA hasn't moved the enricher's cached head SHA is already correct — forcing CI to re-probe *that* SHA is sufficient. Busting it would add a second seam change (`IPrEnricher.EnrichAsync`) plus live-vs-historical scoping logic (the enricher, unlike the CI detector, *does* receive recently-closed PRs) for a "head moved but `updated_at` didn't" case that does not occur here. Deferred; revisit only if such a repro surfaces.

## Implementation

### Precondition — the CI cache is a shared singleton

Both `ICiFailingDetector` and `IInboxRefreshOrchestrator` are registered `AddSingleton` (`PRism.GitHub/ServiceCollectionExtensions.cs:87`, `PRism.Core/ServiceCollectionExtensions.cs:80`). The poller, cold-start, and `/api/inbox/refresh` therefore share **one** `GitHubCiFailingDetector` instance and its one `_cache`. This is what makes "a manual refresh writes the fresh value the next background poll reads" true. The fix must not change these lifetimes.

`RefreshAsync` serializes its entire body under `_writerLock` (`InboxRefreshOrchestrator.cs:85`), so a poll tick and a manual refresh can **never** run `DetectAsync` (or its cache writes) concurrently. The forced-reprobe write is therefore race-free against a concurrent normal sweep — no write-after-write hazard on a `_cache` key.

### `GitHubCiFailingDetector.DetectAsync` (`PRism.GitHub`)

Add `bool forceReprobe = false`. Change the read + write in the per-item body:

```csharp
// read: a forced reprobe skips the cache lookup entirely
if (!forceReprobe && _cache.TryGetValue(key, out var cached))
    return (Item: c, Ci: cached, Degraded: false);

var (ci, degraded) = await ProbeAsync(c.Reference, c.HeadSha, token, ct).ConfigureAwait(false);

// write: never pin a transient Pending (same "recovers next sweep" contract as a
// degraded read), regardless of how we arrived. A forced reprobe still WRITES, so a
// manual refresh's fresh terminal status updates the cache the background poll reads.
if (!degraded && ci != CiStatus.Pending) _cache[key] = ci;
```

Update the `:40-46` seam comment to record that `Pending` joins degraded reads as never-cached, and the `ProbeAsync` `:73-74` comment already noting Pending may hide a worse state stays accurate.

### `ICiFailingDetector` (`PRism.Core`)

```csharp
Task<CiDetectResult> DetectAsync(
    IReadOnlyList<RawPrInboxItem> items,
    CancellationToken ct,
    bool forceReprobe = false);
```

XML doc: note that `forceReprobe` skips the cache *read* (always probes) and refreshes the stored value, honoring the same never-cache rules for `Pending`/degraded. The "live-only" scoping is the caller's responsibility — but the only caller passes live PRs.

### `IInboxRefreshOrchestrator` / `InboxRefreshOrchestrator` (`PRism.Core`)

```csharp
Task RefreshAsync(CancellationToken ct, bool hardRefresh = false);
```

Forward to the detector:

```csharp
var probed = await _ciDetector.DetectAsync(liveForCi, ct, forceReprobe: hardRefresh)
    .ConfigureAwait(false);
```

`hardRefresh` affects **only** the CI probe; the section queries, enrichment, dedup, AI, and diff are unchanged. `TryColdStartRefresh`'s `RefreshAsync(CancellationToken.None)` and the poller's `RefreshAsync(stoppingToken)` bind to the `false` default — no edit.

### Implementers to update (compile-blocking — CS0535)

Adding an optional parameter to an **interface** method does not propagate as a default to implementers — every concrete implementer must add the parameter or the build fails with CS0535. Beyond the two production classes, three existing hand-written fakes implement these interfaces with the old signatures and must each gain the new param (their bodies can ignore it except where a test asserts on the flag):

- `PRism.Web/TestHooks/FakeCiFailingDetector.cs:9` — `DetectAsync` (production-shipped E2E fake, **not** a test project) → add `bool forceReprobe = false`.
- `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs:125` — inline `FakeCiDetector.DetectAsync` → add `bool forceReprobe = false`. This is also the seam for the "hardRefresh forwards forceReprobe" test (capture the flag here).
- `tests/PRism.Web.Tests/TestHelpers/FakeInboxRefreshOrchestrator.cs:25` — `RefreshAsync` → add `bool hardRefresh = false`.

`Mock<IInboxRefreshOrchestrator>` proxies (e.g. `InboxPollerTests`) do **not** break: Moq binds an optional param omitted from a `Setup`/`Verify` expression to its default, and the poller always passes `false`, so existing `RefreshAsync(It.IsAny<CancellationToken>())` setups keep matching — no edit.

### `/api/inbox/refresh` (`PRism.Web`)

```csharp
await orch.RefreshAsync(ct, hardRefresh: true).ConfigureAwait(false);
```

The existing rate-limit / `ReferenceEquals` "did the view advance" handling (`InboxEndpoints.cs:75-93`) is unchanged.

## Data flow

| Path | `hardRefresh` | CI cache behavior |
|------|---------------|-------------------|
| Background poll (`InboxPoller`) | `false` | cached terminal → instant; `Pending` re-probes each tick → auto-advances |
| Cold-start (`TryColdStartRefresh`) | `false` | same cheap cached path (on a true cold start the shared `_cache` is empty, so it probes regardless) |
| Manual button (`/api/inbox/refresh`) | `true` | every live PR re-reads CI ignoring the cache, then refreshes the shared `_cache` |

Recently-closed PRs never enter `DetectAsync`: the live set is materialized at `InboxRefreshOrchestrator.cs:151-155` (`liveForCi`, the only `DetectAsync` call site, `:160`), while recently-closed items are folded into enrichment only and materialized separately at `:223` without probing. Filtering happens *before* the `DetectAsync` call, so `hardRefresh: true` structurally cannot reach historical items — "hard refresh all live, leave historical untouched" needs no scoping code.

**Manual Refresh is a CI-scoped force, by design.** `hardRefresh: true` force-busts **only** the CI cache; section queries, the enricher `(ref, UpdatedAt)` cache, dedup, AI, and diff still follow their normal `updated_at`-gated refresh. This is deliberate, not an oversight: a check-run completing is the *only* field that can go stale without bumping `updated_at`, so it is the only one that needs a force-bust. A future reader debugging "Refresh didn't update field X" should expect non-CI fields to refresh on their normal cadence, not on the button.

**What Lever 2 adds over Lever 1.** With Lever 1, the background poll already auto-advances `Pending` on its next tick (cadence `Polling.InboxSeconds`, default 60s). Lever 2's marginal value is two-fold: (a) immediate user-visible re-read instead of waiting up to one cadence for the next tick — the originally requested #311 behavior; and (b) the *only* in-app path that re-reads a cached **terminal** status (the same-SHA re-run case above), which Lever 1 never re-probes.

## Error handling

Unchanged. `forceReprobe` gates only the cache *read*; it does not change what `ProbeAsync` returns, how degraded reads / 429 / `RateLimitExceededException` propagate, or the orchestrator's CI fault-isolation (`InboxRefreshOrchestrator.cs:170-180`).

- **Forced reprobe that degrades leaves the prior cached terminal intact — intentional.** The write path is `if (!degraded && ci != CiStatus.Pending) _cache[key] = ci;`, so a degraded forced reprobe writes nothing and does **not** evict the existing entry. If a manual Refresh hits a transient 5xx, the previously cached `Passing`/`Failing` stays and the next background poll still serves it. A transient 5xx is not evidence the cached terminal is wrong, so keeping last-known-good is correct — the alternative (evict-on-forced-degrade) would replace a good terminal with `None` on a blip. The parity is in the **write guard** (a degraded result is never written, so a degraded probe can only leave an entry untouched, never evict it), not a read-time contract: the non-forced path never *reaches* a degraded read for an already-cached terminal, because the cache hit short-circuits at `:37` before probing.
- **Manual-refresh burst.** A hard refresh issues `2 × (live-PR count)` probes with nothing served from cache (each `ProbeAsync` = `FetchChecksAsync` + `FetchCombinedStatusAsync`). If that bursts past the rate limit, the *published-view* outcome is identical to a normal-tick 429: `forceReprobe` does not alter `ProbeAsync`'s throw, so `RateLimitExceededException` surfaces, the orchestrator discards the partial CI result and commits a CI-less snapshot then re-throws (`:170-180`), the poller backs off on `Retry-After`, and `/api/inbox/refresh` returns 503 iff the committed view did not advance (`InboxEndpoints.cs:90-92`). One benign cache-side asymmetry: because `DetectAsync` writes each PR's fresh terminal to the shared `_cache` per-item (`:46`) before `Task.WhenAll` surfaces the fault, a burst that 429s partway leaves the cache *partially* refreshed — PRs probed before the throwing one have their entries overwritten with fresh, correct terminals; the rest keep their prior values. Nothing is evicted and every written value is one the next background poll would serve anyway, so this is harmless.

## Testing (TDD; red-on-main)

**Detector — Lever 1**
- `Pending_is_not_cached_and_advances_to_terminal_next_sweep`: same `(ref, headSha)`; sweep 1 returns an in-progress check-run (`Pending`), sweep 2 returns passing → assert sweep 2 = `Passing`. **Reds on main** (main pins `Pending`).
- `Pending_reprobes_http_each_sweep`: a `Pending` sweep followed by another sweep issues HTTP again (not served from cache).
- Existing `Cache_hit_skips_http` (terminal `Passing` stays cached) must stay green — proves we narrowed the cache, not dropped it.

**Detector — Lever 2**
- `forceReprobe_bypasses_cache_read_and_refreshes_value`: cache a `Passing` (normal call), then call with `forceReprobe: true` while the handler now returns `Failing` for the same SHA → assert `Failing`; a subsequent *normal* call returns `Failing` with no new HTTP (the forced value was written).
- `forceReprobe_does_not_cache_pending`: forced reprobe returning `Pending` is not pinned (next normal sweep re-probes).
- `forceReprobe_degraded_leaves_existing_cached_terminal`: prime the cache with `Passing` (normal call); next call degrades (5xx); call with `forceReprobe: true` → returns degraded `None` for that sweep; a subsequent *normal* call returns `Passing` from the untouched cache with no new HTTP — locks in the "forced-degrade does not evict" contract.

**Orchestrator — Lever 2 wiring**
- `RefreshAsync_hardRefresh_true_forwards_forceReprobe`: fake `ICiFailingDetector` capturing the flag → `RefreshAsync(ct, hardRefresh: true)` forwards `true`; `RefreshAsync(ct)` forwards `false`.

**Endpoint — Lever 2 wiring**
- `/api/inbox/refresh` triggers a forced reprobe (fake orchestrator/detector asserts `forceReprobe == true` reached the detector), via the existing inbox endpoint test harness.

## Coordination

- **#322** (unbounded singleton caches — Code Quality). This change narrows *what* the CI cache stores (no `Pending`) and adds a bypass; it does not bound the dictionary. Land coherently: #322's eviction/bounding work should build on the narrowed semantics here, not fight them.
- **#361** (same-SHA CI re-run, filed from this spec's review). The durable TTL that closes the accepted limitation above lives there, to land with or on top of #322's cache rework. This change intentionally does *not* implement it.
