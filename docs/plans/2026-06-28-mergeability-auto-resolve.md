# Mergeability Auto-Resolve (Fast Poll-Until-Definitive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a PR's GitHub mergeability is transiently `UNKNOWN`, the PR-detail merge panel and the inbox readiness badge resolve to the definitive state automatically within a couple of seconds, with no manual refresh and no full-PR-detail re-fetch.

**Architecture:** Reuse the existing separate lightweight readiness query (`IActivePrBatchReader` for detail, `GitHubPrBatchReader` for inbox) but drive it on a short backoff burst (1→16s, ≈5 attempts) the moment derived `MergeReadiness == None` is observed for an open, non-draft, non-terminal PR; surface the resolved value over the SSE channels that already exist (`pr-updated`, `InboxUpdated`). No new poller — `ActivePrPoller` (30s) and `InboxPoller`/`InboxRefreshOrchestrator` (~60s) gain a fast tier.

**Tech Stack:** .NET 10 (`ActivePrPoller`/`InboxRefreshOrchestrator` BackgroundServices, xunit tests), GraphQL readiness batch readers, SSE fan-out, React/TS frontend (`useActivePrUpdates`, `prDetailContext`, vitest).

**Spec:** `docs/specs/2026-06-28-mergeability-auto-resolve-design.md` (3 ce-doc-review rounds). Read it before starting.

## Global Constraints

- **Gate on the DERIVED `MergeReadiness == None`, never the raw `mergeable` string.** `MergeReadinessRule.Derive` collapses `mergeable == UNKNOWN` *and* the `mergeStateStatus`-lag case (`mergeStateStatus` UNKNOWN/null while `mergeable` is definitive) into `None`. A raw-`mergeable` gate re-freezes the lag case.
- **Fast-poll only open, non-draft, non-terminal PRs.** Drafts are legitimately `None`; merged/closed are terminal.
- **The cap governs only the FAST tier.** A non-definitive `None` is never permanently cached as definitive; after the cap a stuck PR reverts to the normal cadence and still self-heals.
- **Separate query only.** Mergeability is fetched via the readiness batch query, never via `GetPrDetailAsync`. No PR-detail re-fetch from a mergeability change.
- **Anti-flicker:** only a change *to* a non-`None` readiness publishes; a transient `None` never blanks/churns a live badge (existing `ActivePrPoller.cs:195-196`).
- **Burst-budget key = `(ref, headSha)` on both surfaces** (a comment bumps `UpdatedAt` but not mergeability, so it must not re-arm a burst).
- **Use real binaries, not rtk:** `dotnet` at `/c/Program Files/dotnet/dotnet.exe`; frontend vitest via `frontend/node_modules/.bin/vitest` run from `frontend/`; one build/test at a time, foreground, timeout ≥300000ms. Do NOT run a detached PRism server during `dotnet test` (LockfileException).
- **Commit trailers:** end each commit message with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_012WKwgoJ6rZfgAnYxmestqZ`.

**Slice boundary:** Tasks 1–7 are the PR-detail slice (independently shippable); Tasks 8–10 are the inbox slice. They share no files. If the inbox slice stalls, the PR-detail slice can ship alone.

---

## File Structure

**PR-detail slice**
- `PRism.Core.Contracts/ActivePrPollSnapshot.cs` — add `IsDraft`.
- `PRism.Core.Contracts/IActivePrCache.cs` — add `MergeReadiness` to `ActivePrSnapshot`.
- `PRism.GitHub/ActivePr/GitHubActivePrBatchReader.cs` — populate `IsDraft`.
- `PRism.Core/PrDetail/ActivePrPollerState.cs` — add `FastRetryCount`.
- `PRism.Core/PrDetail/ActivePrPoller.cs` — fast-retry gate, conditional `NextRetryAt` reset, adaptive wake delay, `RequestImmediateRefresh` signal + min-interval, populate cache readiness (retain non-`None`).
- `PRism.Core/ServiceCollectionExtensions.cs` — dual-register `ActivePrPoller`.
- `PRism.Web/Sse/SseChannel.cs` — inject `IActivePrCache` + `ActivePrPoller`; re-emit readiness + wake on subscribe.
- `frontend/src/components/PrDetail/prDetailContext.tsx` — add `liveMergeReadiness`.
- `frontend/src/components/PrDetail/PrDetailView.tsx` — feed `updates.mergeReadiness` into the context.
- `frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.tsx` — read `live ?? snapshot`; announcement; focus recovery.

**Inbox slice**
- `PRism.GitHub/Inbox/GitHubPrBatchReader.cs` — stateless derived-`None` cache-skip.
- `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` — fast re-probe pass + lifecycle.

---

## Task 1: `IsDraft` on the active-PR poll snapshot

**Files:**
- Modify: `PRism.Core.Contracts/ActivePrPollSnapshot.cs:3-21`
- Modify: `PRism.GitHub/ActivePr/GitHubActivePrBatchReader.cs:96-108` (snapshot construction; `isDraft` already parsed at `:90`)
- Test: `tests/PRism.GitHub.Tests/ActivePr/GitHubActivePrBatchReaderTests.cs`

**Interfaces:**
- Produces: `ActivePrPollSnapshot.IsDraft` (`bool`, default `false`).

- [ ] **Step 1: Write the failing test** — assert the batch reader surfaces `IsDraft` from the GraphQL `isDraft`. Add to `GitHubActivePrBatchReaderTests` (follow the existing fixture that feeds a canned GraphQL JSON body):

```csharp
[Fact]
public async Task PollBatch_surfaces_isDraft_from_graphql()
{
    // Arrange: a fake GraphQL response node with isDraft:true (mirror an existing test's JSON shape).
    var reader = CreateReaderReturning(/* node */ DraftPrNodeJson(number: 7, isDraft: true));

    var result = await reader.PollBatchAsync(new[] { new PrReference("o", "r", 7) }, CancellationToken.None);

    Assert.True(result[new PrReference("o", "r", 7)].IsDraft);
}
```

- [ ] **Step 2: Run it — verify it fails to compile** (`IsDraft` does not exist).

Run: `/c/Program\ Files/dotnet/dotnet.exe test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "PollBatch_surfaces_isDraft_from_graphql"`
Expected: build error `'ActivePrPollSnapshot' does not contain a definition for 'IsDraft'`.

- [ ] **Step 3: Add the field.** In `ActivePrPollSnapshot.cs`, add a trailing optional param (keeps positional/named callers compiling):

```csharp
public sealed record ActivePrPollSnapshot(
    string HeadSha,
    string BaseSha,
    string Mergeability,
    PrState PrState,
    int CommentCount,
    int ReviewCount,
    MergeReadiness MergeReadiness = MergeReadiness.None,
    int? Approvals = null,
    int? ChangesRequested = null,
    IReadOnlyList<Reviewer>? Approvers = null,
    IReadOnlyList<Reviewer>? ChangesRequestedBy = null,
    IReadOnlyList<Reviewer>? AwaitingReviewers = null,
    bool IsDraft = false);
```

- [ ] **Step 4: Populate it** in `GitHubActivePrBatchReader.cs:96-108` — add `IsDraft: isDraft,` to the `new ActivePrPollSnapshot(...)` (the `isDraft` local already exists at `:90`).

- [ ] **Step 5: Run the test — verify it passes.**

Run: same filter as Step 2. Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add PRism.Core.Contracts/ActivePrPollSnapshot.cs PRism.GitHub/ActivePr/GitHubActivePrBatchReader.cs tests/PRism.GitHub.Tests/ActivePr/GitHubActivePrBatchReaderTests.cs
git commit -m "feat(#655): surface IsDraft on ActivePrPollSnapshot"
```

---

## Task 2: `MergeReadiness` on the active-PR cache (retain last non-`None`)

**Files:**
- Modify: `PRism.Core.Contracts/IActivePrCache.cs:42-46` (`ActivePrSnapshot`)
- Modify: `PRism.Core/PrDetail/ActivePrPoller.cs:237-241` (`_cache.Update` call)
- Test: `tests/PRism.Core.Tests/PrDetail/ActivePrPollerTests.cs`

**Interfaces:**
- Produces: `ActivePrSnapshot.MergeReadiness` (`MergeReadiness`, default `None`); the cache retains the last **non-`None`** readiness across ticks.

- [ ] **Step 1: Write the failing test** — after a `Ready` tick then a transient-`None` tick, the cache still reports `Ready`:

```csharp
[Fact]
public async Task Cache_retains_last_non_none_readiness()
{
    var (poller, cache, batch) = NewPoller();           // existing test harness factory
    Subscribe(poller, Pr(1));
    batch.Next(Pr(1), readiness: MergeReadiness.Ready);
    await poller.TickAsync(T0, CancellationToken.None);
    batch.Next(Pr(1), readiness: MergeReadiness.None);   // transient recompute blip
    await poller.TickAsync(T0.AddSeconds(30), CancellationToken.None);

    Assert.Equal(MergeReadiness.Ready, cache.GetCurrent(Pr(1))!.MergeReadiness);
}
```

- [ ] **Step 2: Run it — verify it fails** (`ActivePrSnapshot` has no `MergeReadiness`).

Run: `/c/Program\ Files/dotnet/dotnet.exe test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "Cache_retains_last_non_none_readiness"`
Expected: build/compile failure.

- [ ] **Step 3: Add the field** in `IActivePrCache.cs`:

```csharp
public sealed record ActivePrSnapshot(
    string HeadSha,
    long? HighestIssueCommentId,
    DateTimeOffset ObservedAt,
    string BaseSha = "",
    MergeReadiness MergeReadiness = MergeReadiness.None);
```

- [ ] **Step 4: Populate with retain-non-`None`** at `ActivePrPoller.cs:237`. The poller already retains `state.LastMergeReadiness` (non-`None`) at `:230-231`; feed that into the cache so a transient `None` tick keeps the last real value:

```csharp
_cache.Update(prRef, new ActivePrSnapshot(
    HeadSha: snapshot.HeadSha,
    HighestIssueCommentId: null,
    ObservedAt: now,
    BaseSha: snapshot.BaseSha,
    MergeReadiness: snapshot.MergeReadiness != MergeReadiness.None
        ? snapshot.MergeReadiness
        : (state.LastMergeReadiness ?? MergeReadiness.None)));
```

- [ ] **Step 5: Run the test — verify it passes.** Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add PRism.Core.Contracts/IActivePrCache.cs PRism.Core/PrDetail/ActivePrPoller.cs tests/PRism.Core.Tests/PrDetail/ActivePrPollerTests.cs
git commit -m "feat(#655): carry last-known readiness on the active-PR cache"
```

---

## Task 3: `ActivePrPoller` adaptive fast-retry (derived-`None` gate + conditional reset)

**Files:**
- Modify: `PRism.Core/PrDetail/ActivePrPollerState.cs:7-18` (add `FastRetryCount`)
- Modify: `PRism.Core/PrDetail/ActivePrPoller.cs` (`TickAsync` scheduling + `:233` conditional reset; `ExecuteAsync` adaptive delay)
- Test: `tests/PRism.Core.Tests/PrDetail/ActivePrPollerTests.cs`

**Interfaces:**
- Consumes: `ActivePrPollSnapshot.IsDraft` (Task 1), `snapshot.MergeReadiness`.
- Produces: a per-PR fast-retry schedule; `ActivePrPollerState.FastRetryCount`.

**Constants:** `FastRetryCap = 5`; `FastBackoff(n) = TimeSpan.FromSeconds(Math.Pow(2, n))` for `n = 0..4` → 1, 2, 4, 8, 16s.

- [ ] **Step 1: Write the failing tests:**

```csharp
[Fact]
public async Task UnknownReadiness_schedules_fast_retry_and_survives_success_reset()
{
    var (poller, _, batch) = NewPoller();
    Subscribe(poller, Pr(1));
    batch.Next(Pr(1), readiness: MergeReadiness.None, mergeable: "MERGEABLE", isDraft: false); // mergeStateStatus-lag None
    await poller.TickAsync(T0, CancellationToken.None);

    var state = poller.PeekState(Pr(1));                       // add an internal test accessor
    Assert.Equal(T0.AddSeconds(1), state.NextRetryAt);        // scheduled, NOT nulled by the :233 reset
    Assert.Equal(1, state.FastRetryCount);
}

[Theory]
[InlineData(MergeReadiness.Ready, false)]   // definitive -> no fast retry
[InlineData(MergeReadiness.None, true)]     // draft None -> no fast retry
public async Task FastRetry_skips_definitive_and_draft(MergeReadiness readiness, bool isDraft)
{
    var (poller, _, batch) = NewPoller();
    Subscribe(poller, Pr(1));
    batch.Next(Pr(1), readiness: readiness, isDraft: isDraft);
    await poller.TickAsync(T0, CancellationToken.None);
    Assert.Null(poller.PeekState(Pr(1)).NextRetryAt);
}

[Fact]
public async Task FastRetry_stops_after_cap_but_still_polls_normally()
{
    var (poller, _, batch) = NewPoller();
    Subscribe(poller, Pr(1));
    batch.Next(Pr(1), readiness: MergeReadiness.None, isDraft: false);
    var t = T0;
    for (var i = 0; i < 6; i++) { await poller.TickAsync(t, CancellationToken.None); t = t.AddSeconds(60); }
    var state = poller.PeekState(Pr(1));
    Assert.Equal(5, state.FastRetryCount);                    // capped
    Assert.Null(state.NextRetryAt);                            // no more fast schedule; reverts to cadence
}
```

- [ ] **Step 2: Run — verify failure** (`FastRetryCount`/`PeekState` undefined). Run the three by name with `--filter`.

- [ ] **Step 3: Add `FastRetryCount`** to `ActivePrPollerState`:

```csharp
public int FastRetryCount { get; set; }
```

Add an internal test accessor on `ActivePrPoller` (mirror `TrackedStateCount`):

```csharp
internal ActivePrPollerState PeekState(PrReference prRef) => _state[prRef];
```

- [ ] **Step 4: Schedule the fast retry** in `TickAsync`, in the per-candidate `foreach` (after the snapshot is derived, alongside the existing state updates). Compute the gate, then make the existing `state.NextRetryAt = null;` reset (`:233`) conditional:

```csharp
var nonTerminal = snapshot.PrState == PrState.Open;
var wantsFastRetry = nonTerminal
    && !snapshot.IsDraft
    && snapshot.MergeReadiness == MergeReadiness.None
    && state.FastRetryCount < FastRetryCap;

// (existing) state.LastHeadSha/.../ConsecutiveErrors = 0; updates stay as-is...
if (wantsFastRetry)
{
    state.NextRetryAt = now + FastBackoff(state.FastRetryCount);
    state.FastRetryCount++;
}
else
{
    state.NextRetryAt = null;        // replaces the unconditional :233 reset
    if (snapshot.MergeReadiness != MergeReadiness.None) state.FastRetryCount = 0; // resolved -> reset budget
}
```

Add the constants/method to the class:

```csharp
private const int FastRetryCap = 5;
private static TimeSpan FastBackoff(int n) => TimeSpan.FromSeconds(Math.Pow(2, n));
```

- [ ] **Step 5: Adaptive `ExecuteAsync` delay.** Change the flat `Task.Delay(_cadence, ...)` (`:105`) so a near-future `NextRetryAt` shortens the sleep:

```csharp
var soonest = _state.Values
    .Select(s => s.NextRetryAt)
    .Where(t => t is not null)
    .DefaultIfEmpty(null)
    .Min();
var delay = soonest is { } due
    ? TimeSpan.FromTicks(Math.Clamp((due - DateTimeOffset.UtcNow).Ticks, TimeSpan.FromMilliseconds(50).Ticks, _cadence.Ticks))
    : _cadence;
await Task.Delay(delay, stoppingToken).ConfigureAwait(false);
```

(Task 4 replaces this `Task.Delay` with the `WhenAny`+signal version; this step proves the budget arithmetic in isolation first.)

- [ ] **Step 6: Run the three tests — verify they pass.**

- [ ] **Step 7: Commit.**

```bash
git add PRism.Core/PrDetail/ActivePrPollerState.cs PRism.Core/PrDetail/ActivePrPoller.cs tests/PRism.Core.Tests/PrDetail/ActivePrPollerTests.cs
git commit -m "feat(#655): adaptive fast-retry for UNKNOWN readiness in ActivePrPoller"
```

---

## Task 4: `ActivePrPoller` wake signal + DI dual-register

**Files:**
- Modify: `PRism.Core/PrDetail/ActivePrPoller.cs` (`_refreshSignal`, `RequestImmediateRefresh`, `ExecuteAsync` `WhenAny`+signal-loss, min-interval)
- Modify: `PRism.Core/ServiceCollectionExtensions.cs:152-154` (dual-register)
- Test: `tests/PRism.Core.Tests/PrDetail/ActivePrPollerTests.cs`; `tests/PRism.Web.Tests/.../ActivePrPollerResolvableTests.cs` (new, mirror `InboxPollerResolvableTests`)

**Interfaces:**
- Produces: `ActivePrPoller.RequestImmediateRefresh()` (public), consumed by `SseChannel` in Task 5.

- [ ] **Step 1: Write the failing tests:**

```csharp
[Fact]
public async Task RequestImmediateRefresh_wakes_the_loop_within_one_second()
{
    var (poller, _, batch) = NewPoller(cadenceSeconds: 30);
    using var cts = new CancellationTokenSource();
    Subscribe(poller, Pr(1));
    batch.Next(Pr(1), readiness: MergeReadiness.None, isDraft: false);
    var run = poller.StartAsync(cts.Token);                 // BackgroundService loop
    poller.RequestImmediateRefresh();
    await Poll.Until(() => batch.PollCount >= 1, timeout: TimeSpan.FromSeconds(2)); // not 30s
    Assert.True(batch.PollCount >= 1);
    cts.Cancel(); await run;
}

[Fact]
public async Task RequestImmediateRefresh_is_rate_limited_by_min_interval()
{
    var (poller, _, batch) = NewPoller(cadenceSeconds: 30);
    using var cts = new CancellationTokenSource();
    Subscribe(poller, Pr(1));
    await poller.StartAsync(cts.Token);
    for (var i = 0; i < 10; i++) poller.RequestImmediateRefresh(); // storm
    await Task.Delay(500);
    Assert.True(batch.PollCount <= 2);                        // coalesced + min-interval, not 10
    cts.Cancel();
}
```

And the resolvability test (new file, mirror `InboxPollerResolvableTests`):

```csharp
[Fact]
public void ActivePrPoller_resolves_as_singleton_and_hosted_service()
{
    using var sp = BuildPrismServiceProvider();              // existing test helper
    var a = sp.GetRequiredService<ActivePrPoller>();
    var hosted = sp.GetServices<IHostedService>();
    Assert.Same(a, hosted.OfType<ActivePrPoller>().Single());
}
```

- [ ] **Step 2: Run — verify failure** (`RequestImmediateRefresh` missing; resolvability fails because `ActivePrPoller` isn't registered as a singleton).

- [ ] **Step 3: Add the signal + min-interval** to `ActivePrPoller`:

```csharp
private readonly SemaphoreSlim _refreshSignal = new(0, 1);
private DateTimeOffset _lastTickAt = DateTimeOffset.MinValue;
private static readonly TimeSpan MinWakeInterval = TimeSpan.FromSeconds(3);

public void RequestImmediateRefresh()
{
    try { _refreshSignal.Release(); }
    catch (SemaphoreFullException) { /* already signalled; coalesce */ }
    catch (ObjectDisposedException) { /* stopped */ }
}
```

- [ ] **Step 4: Rewrite the `ExecuteAsync` delay** to the `InboxPoller` `WhenAny`+signal-loss pattern (copy the block from `InboxPoller.cs:75-103`), computing `delay` via the Task-3 adaptive formula, and honor the min-interval so a wake within `MinWakeInterval` of the last tick is ignored:

```csharp
// after each TickAsync: _lastTickAt = DateTimeOffset.UtcNow;
using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
var delayTask = Task.Delay(delay, linkedCts.Token);
var signalTask = _refreshSignal.WaitAsync(linkedCts.Token);
var winner = await Task.WhenAny(delayTask, signalTask).ConfigureAwait(false);
if (stoppingToken.IsCancellationRequested) return;
await linkedCts.CancelAsync().ConfigureAwait(false);
if (winner == delayTask && signalTask.IsCompletedSuccessfully)
{
    try { _refreshSignal.Release(); } catch (SemaphoreFullException) { } catch (ObjectDisposedException) { }
}
// If woken by the signal but DateTimeOffset.UtcNow - _lastTickAt < MinWakeInterval, loop back to re-delay
// the remaining interval instead of ticking (reconnect-storm guard).
```

Dispose `_refreshSignal` in the poller's `Dispose`/`StopAsync` path (mirror `InboxPoller.Dispose`).

- [ ] **Step 5: Dual-register** in `ServiceCollectionExtensions.cs` — replace `services.AddHostedService<ActivePrPoller>();` with:

```csharp
services.AddSingleton<ActivePrPoller>();
services.AddHostedService(sp => sp.GetRequiredService<ActivePrPoller>());
```

- [ ] **Step 6: Run all Task-4 tests — verify pass.**

- [ ] **Step 7: Commit.**

```bash
git add PRism.Core/PrDetail/ActivePrPoller.cs PRism.Core/ServiceCollectionExtensions.cs tests/PRism.Core.Tests/PrDetail/ActivePrPollerTests.cs tests/PRism.Web.Tests/**/ActivePrPollerResolvableTests.cs
git commit -m "feat(#655): subscribe wake signal + dual-register for ActivePrPoller"
```

---

## Task 5: Re-emit readiness + wake the poller on subscribe

**Files:**
- Modify: `PRism.Web/Sse/SseChannel.cs:59-85` (ctor deps), `:115-133` (`TrySubscribe`)
- Test: `tests/PRism.Web.Tests/Sse/SseChannelTests.cs` (or the existing SSE/subscription test file)

**Interfaces:**
- Consumes: `IActivePrCache.GetCurrent(prRef)?.MergeReadiness` (Task 2), `ActivePrPoller.RequestImmediateRefresh` (Task 4), the existing `SseEventProjection` for `ActivePrUpdated` → `pr-updated`.

- [ ] **Step 1: Write the failing tests:**

```csharp
[Fact]
public async Task Subscribe_reemits_targeted_pr_updated_when_cached_readiness_non_none()
{
    var cache = new FakeActivePrCache();
    cache.Update(Pr(1), Snap(readiness: MergeReadiness.Ready));
    var channel = NewChannel(cache, out var sub);           // one connected subscriber on the cookie
    channel.TrySubscribe(sub.CookieSession, Pr(1));
    var frame = await sub.NextFrameWithin(TimeSpan.FromSeconds(1));
    Assert.Contains("event: pr-updated", frame);
    Assert.Contains("\"mergeReadinessChanged\":true", frame);
    Assert.Contains("\"mergeReadiness\":\"ready\"", frame);
    Assert.DoesNotContain(frame, OtherSubscriber.Frames);    // targeted, not fanned out
}

[Fact]
public async Task Subscribe_emits_nothing_when_cached_readiness_none()
{
    var cache = new FakeActivePrCache();                     // no entry => None/absent
    var channel = NewChannel(cache, out var sub);
    channel.TrySubscribe(sub.CookieSession, Pr(1));
    Assert.False(await sub.HasFrameWithin(TimeSpan.FromMilliseconds(200)));
}

[Fact]
public void Subscribe_requests_immediate_poll()
{
    var poller = new FakeWakeable();
    var channel = NewChannel(poller: poller, out var sub);
    channel.TrySubscribe(sub.CookieSession, Pr(1));
    Assert.Equal(1, poller.WakeCount);
}
```

- [ ] **Step 2: Run — verify failure** (ctor doesn't take the cache/poller; no re-emit).

- [ ] **Step 3: Inject the deps** into `SseChannel`'s constructor (`IActivePrCache cache, ActivePrPoller poller`) and store them. No DI cycle: the poller's deps (registry/cache/bus/reader) don't reference `SseChannel`.

- [ ] **Step 4: Re-emit + wake** in `TrySubscribe`, right after the successful `_activeRegistry.Add(subscriberId, prRef);`:

```csharp
_activeRegistry.Add(subscriberId, prRef);
_poller.RequestImmediateRefresh();
var readiness = _cache.GetCurrent(prRef)?.MergeReadiness ?? MergeReadiness.None;
if (readiness != MergeReadiness.None && _subscribers.TryGetValue(subscriberId, out var sub))
{
    var evt = new ActivePrUpdated(prRef, HeadShaChanged: false, CommentCountChanged: false,
        NewHeadSha: null, CommentCountDelta: 0, IsMerged: false, IsClosed: false,
        BaseShaChanged: false, NewBaseSha: null,
        MergeReadiness: readiness, MergeReadinessChanged: true,
        Approvals: null, ChangesRequested: null, Approvers: null, ChangesRequestedBy: null, AwaitingReviewers: null);
    var frame = SseEventProjection.Project(evt);             // reuse the existing projection helper
    _ = sub.WriteAsync(frame, CancellationToken.None);       // fire-and-forget to that one connection
}
return true;
```

(If `SseEventProjection.Project` is private, expose the same internal helper `OnActivePrUpdated`/`FanoutProjected` uses — but scoped to the single `sub`, not the fanout list.)

- [ ] **Step 5: Run the Task-5 tests — verify pass.**

- [ ] **Step 6: Commit.**

```bash
git add PRism.Web/Sse/SseChannel.cs tests/PRism.Web.Tests/Sse/SseChannelTests.cs
git commit -m "feat(#655): re-emit readiness and wake the poller on PR subscribe"
```

---

## Task 6: C1 — panel consumes the live readiness feed

**Files:**
- Modify: `frontend/src/components/PrDetail/prDetailContext.tsx:12-53`
- Modify: `frontend/src/components/PrDetail/PrDetailView.tsx:436-473`
- Modify: `frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.tsx:43,68-69`
- Test: `frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.test.tsx`

**Interfaces:**
- Produces: `PrDetailContextValue.liveMergeReadiness?: MergeReadiness`.

- [ ] **Step 1: Write the failing test** (vitest). Render `PrActionsPanel` inside a context provider where the snapshot readiness is `none` but `liveMergeReadiness` is `ready`; assert the Merge button is enabled (panel uses the live value):

```tsx
it('uses live readiness over the snapshot seed', () => {
  renderPanel({ snapshotReadiness: 'none', liveMergeReadiness: 'ready' });
  expect(screen.getByRole('button', { name: /merge/i })).toBeEnabled();
});

it('falls back to the snapshot when no live value yet', () => {
  renderPanel({ snapshotReadiness: 'none', liveMergeReadiness: undefined });
  expect(screen.getByText(/still being calculated/i)).toBeInTheDocument();
});
```

(`renderPanel` wraps `<PrDetailContext.Provider value={...}>`; add `liveMergeReadiness` to the test's context value builder.)

- [ ] **Step 2: Run — verify failure.**

Run (from `frontend/`): `node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/PrActionsPanel.test.tsx -t "live readiness"`
Expected: FAIL (panel still reads the snapshot).

- [ ] **Step 3: Add the context field** in `prDetailContext.tsx`:

```typescript
import type { MergeReadiness } from '../../api/types';
// inside PrDetailContextValue:
  liveMergeReadiness?: MergeReadiness;
```

- [ ] **Step 4: Feed it** in `PrDetailView.tsx` `ctxValue` (the `useMemo` at `:436-473`) — add `liveMergeReadiness: updates.mergeReadiness,` to the object and `updates.mergeReadiness` to the dep array.

- [ ] **Step 5: Read it** in `PrActionsPanel.tsx`. Pull `liveMergeReadiness` from the context (`:43` destructure) and change the readiness derivation (`:68-69`):

```typescript
const { /* ...existing... */ liveMergeReadiness } = usePrDetailContext();
const readiness = (liveMergeReadiness ?? pr?.mergeReadiness ?? 'none') as MergeReadiness;
```

- [ ] **Step 6: Run the tests — verify pass.** Also run prettier + tsc:

Run (from `frontend/`): `node ./node_modules/prettier/bin/prettier.cjs --write src/components/PrDetail/prDetailContext.tsx src/components/PrDetail/PrDetailView.tsx src/components/PrDetail/OverviewTab/PrActionsPanel.tsx` then `node_modules/.bin/tsc -b`.

- [ ] **Step 7: Commit.**

```bash
git add frontend/src/components/PrDetail/prDetailContext.tsx frontend/src/components/PrDetail/PrDetailView.tsx frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.tsx frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.test.tsx
git commit -m "feat(#655): merge panel consumes live readiness feed"
```

---

## Task 7: C1 — announce auto-resolution + keep focus on Refresh unmount

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.tsx` (live-region `:224-232`; focus useEffect `:131-140`; Refresh button `:364-385`)
- Test: `frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.test.tsx`

**Interfaces:**
- Consumes: `READINESS_SHORT` from `../../shared/mergeReadiness` (add to the existing import at `:10`), `MERGE_ENABLED`.

- [ ] **Step 1: Write the failing tests:**

```tsx
it('announces ready-to-merge on auto-resolve none -> ready', async () => {
  const { rerender } = renderPanel({ snapshotReadiness: 'none', liveMergeReadiness: undefined });
  rerender(panel({ snapshotReadiness: 'none', liveMergeReadiness: 'ready' }));
  expect(await screen.findByRole('status')).toHaveTextContent(/ready to merge/i);
});

it('does NOT re-announce when navigating back to an already-ready PR', () => {
  // effective readiness starts at 'ready' (snapshot seed), then a re-emit sets live 'ready'
  const { rerender } = renderPanel({ snapshotReadiness: 'ready', liveMergeReadiness: undefined });
  rerender(panel({ snapshotReadiness: 'ready', liveMergeReadiness: 'ready' }));
  expect(screen.getByRole('status')).toHaveTextContent('');     // no announcement
});

it('moves focus off the Refresh button when readiness auto-resolves', async () => {
  const { rerender } = renderPanel({ snapshotReadiness: 'none', liveMergeReadiness: undefined });
  screen.getByRole('button', { name: /refresh/i }).focus();
  rerender(panel({ snapshotReadiness: 'none', liveMergeReadiness: 'ready' }));
  expect(document.body).not.toHaveFocus();
  expect(screen.getByRole('button', { name: /merge/i })).toHaveFocus();
});
```

- [ ] **Step 2: Run — verify failure.**

- [ ] **Step 3: Add the announcement branch.** Track effective readiness in a ref seeded to the snapshot, fire only on a `none`→non-`none` transition:

```typescript
import { READINESS_LONG, READINESS_SHORT, MERGE_ENABLED, type MergeReadiness } from '../../shared/mergeReadiness';

const prevReadinessRef = useRef<MergeReadiness>(readiness); // seeded to first effective value
const [readinessAnnounce, setReadinessAnnounce] = useState('');
useEffect(() => {
  const prev = prevReadinessRef.current;
  prevReadinessRef.current = readiness;
  if (prev === 'none' && readiness !== 'none') {
    setReadinessAnnounce(
      MERGE_ENABLED.has(readiness)
        ? 'Pull request is ready to merge'
        : `Merge unavailable: ${READINESS_SHORT[readiness]}`,
    );
  }
}, [readiness]);
```

Add `readinessAnnounce` as a branch in the `role=status` ternary (`:224-232`), after the existing branches and before the `''` fallback (a readiness change during `confirmingClose`/`confirmingMerge` is an impossible flow, so ordering is harmless):

```typescript
: readinessAnnounce
  ? readinessAnnounce
  : ''}
```

- [ ] **Step 4: Widen the focus-recovery guard** (`:131-140`). Add a `refreshBtnRef` to the Refresh button (`:364-385`) and widen the condition:

```typescript
const refreshBtnRef = useRef<HTMLButtonElement | null>(null);
// ...
useEffect(() => {
  if ((refreshArmedRef.current || document.activeElement === refreshBtnRef.current) && readiness !== 'none') {
    refreshArmedRef.current = false;
    if (MERGE_ENABLED.has(readiness)) mergeBtnRef.current?.focus();
    else mergeReasonRef.current?.focus();
  }
}, [readiness]);
```

Attach `ref={refreshBtnRef}` to the Refresh `<button>`.

- [ ] **Step 5: Run the tests — verify pass; prettier + tsc.**

- [ ] **Step 6: Run the FULL panel suite** (aria/disabled changes have bitten an explicit-`false` a11y test before):

Run (from `frontend/`): `node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/PrActionsPanel.test.tsx`
Expected: all green.

- [ ] **Step 7: Commit.**

```bash
git add frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.tsx frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.test.tsx
git commit -m "feat(#655): announce mergeability auto-resolve and preserve focus"
```

---

## Task 8: Inbox — stateless derived-`None` cache-skip

**Files:**
- Modify: `PRism.GitHub/Inbox/GitHubPrBatchReader.cs` (the parse-and-cache path around `:248-254`; cache write into `_cache`)
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubPrBatchReaderTests.cs`

**Interfaces:**
- Produces: a `None` readiness for an open, non-draft, non-terminal PR is never written to `_cache` (re-fetched every read).

- [ ] **Step 1: Write the failing tests:**

```csharp
[Fact]
public async Task OpenNonDraft_unknown_readiness_is_not_cached()
{
    var reader = NewReader(http: SequenceReturning(
        first: OpenNode(7, mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN"),
        second: OpenNode(7, mergeStateStatus: "CLEAN",   mergeable: "MERGEABLE")));
    var item = Raw(7, updatedAt: T0);
    var r1 = await reader.ReadAsync(new[] { item }, "viewer", default);
    var r2 = await reader.ReadAsync(new[] { item }, "viewer", default); // same (ref,UpdatedAt)
    Assert.Equal(MergeReadiness.None,  r1[item.Reference].MergeReadiness); // first read, still computing
    Assert.Equal(MergeReadiness.Ready, r2[item.Reference].MergeReadiness); // re-fetched, NOT cache-served
}

[Fact]
public async Task MergeStateStatus_lag_none_is_not_cached()   // derived-None gate, not raw mergeable
{
    var reader = NewReader(http: SequenceReturning(
        first: OpenNode(7, mergeStateStatus: "UNKNOWN", mergeable: "MERGEABLE"), // lag: mergeable definitive
        second: OpenNode(7, mergeStateStatus: "CLEAN",   mergeable: "MERGEABLE")));
    var item = Raw(7, updatedAt: T0);
    await reader.ReadAsync(new[] { item }, "viewer", default);
    var r2 = await reader.ReadAsync(new[] { item }, "viewer", default);
    Assert.Equal(MergeReadiness.Ready, r2[item.Reference].MergeReadiness); // re-fetched, not frozen
}

[Fact]
public async Task Draft_none_is_cached()
{
    var reader = NewReader(http: SequenceReturning(
        first: OpenNode(7, isDraft: true, mergeStateStatus: "UNKNOWN"),
        second: ThrowIfCalled()));               // a second fetch would mean it wasn't cached
    var item = Raw(7, updatedAt: T0);
    await reader.ReadAsync(new[] { item }, "viewer", default);
    var r2 = await reader.ReadAsync(new[] { item }, "viewer", default); // served from cache, no fetch
    Assert.Equal(MergeReadiness.None, r2[item.Reference].MergeReadiness);
}
```

- [ ] **Step 2: Run — verify failure** (the `None` is currently cached, so `r2` re-serves it / draft test passes vacuously only if logic exists).

- [ ] **Step 3: Implement the skip.** In the parse path (after `var readiness = MergeReadinessRule.Derive(...)`, `:254`), compute whether the row is non-definitive and skip the cache write:

```csharp
var nonDefinitive =
    readiness == MergeReadiness.None
    && prState == PrState.Open
    && !isDraft;
// ... build the BatchPrData as today ...
if (!nonDefinitive)
{
    _cache[(item.Reference, item.UpdatedAt)] = data;   // existing cache write — now guarded
}
// always include `data` in the returned result map (the read still returns the fresh value)
```

(Locate the existing `_cache[...] = data;` line and wrap it in the `if (!nonDefinitive)`. The returned dictionary entry is unchanged — only the cache *write* is skipped.)

- [ ] **Step 4: Run the three tests — verify pass.**

- [ ] **Step 5: Commit.**

```bash
git add PRism.GitHub/Inbox/GitHubPrBatchReader.cs tests/PRism.GitHub.Tests/Inbox/GitHubPrBatchReaderTests.cs
git commit -m "feat(#655): inbox batch reader stops freezing transient UNKNOWN readiness"
```

---

## Task 9: Inbox — single re-probe pass (full-set read, writer-lock, patch fresh `_current`)

**Files:**
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` (a `ReprobeOnceAsync` helper + target selection)
- Test: `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs`

**Interfaces:**
- Consumes: `GitHubPrBatchReader` skip (Task 8), `_writerLock`, `_current`, `InboxUpdated`.
- Produces: `internal Task<bool> ReprobeOnceAsync(CancellationToken ct)` — re-reads still-`None` open non-draft rows once, patches resolved rows, returns `true` if any row is still `None` (i.e. another pass is warranted).

- [ ] **Step 1: Write the failing tests:**

```csharp
[Fact]
public async Task Reprobe_patches_resolved_row_and_publishes_InboxUpdated()
{
    var (orch, reader, bus) = NewOrchestrator();
    reader.NextReadiness(Pr(7), MergeReadiness.None);   await orch.RefreshAsync(default);
    reader.NextReadiness(Pr(7), MergeReadiness.Ready);
    bus.Clear();
    var more = await orch.ReprobeOnceAsync(default);
    Assert.False(more);
    Assert.Equal(MergeReadiness.Ready, RowFor(orch.Current!, Pr(7)).MergeReadiness);
    Assert.Contains(bus.Published, e => e is InboxUpdated);
}

[Fact]
public async Task Reprobe_passes_full_item_set_not_a_subset()
{
    var (orch, reader, _) = NewOrchestrator();
    reader.SeedRows(Pr(7) /*None*/, Pr(8) /*Ready, cached*/);
    await orch.RefreshAsync(default);
    await orch.ReprobeOnceAsync(default);
    Assert.Equal(new[] { Pr(7), Pr(8) }, reader.LastReadRefs);   // both refs => PruneAbsent safe
}

[Fact]
public async Task Reprobe_skips_a_row_absent_from_current()
{
    var (orch, reader, _) = NewOrchestrator();
    reader.NextReadiness(Pr(7), MergeReadiness.None); await orch.RefreshAsync(default);
    reader.NextReadiness(Pr(7), MergeReadiness.Ready);
    orch.SimulateConcurrentDropOf(Pr(7));               // a parallel refresh removed PR 7 (closed)
    await orch.ReprobeOnceAsync(default);
    Assert.DoesNotContain(orch.Current!.Sections.SelectMany(s => s.Value), p => p.Reference == Pr(7).Reference);
}

[Fact]
public async Task Reprobe_no_targets_returns_false_and_does_not_read()
{
    var (orch, reader, _) = NewOrchestrator();
    reader.SeedRows(Pr(8) /*Ready*/); await orch.RefreshAsync(default);
    reader.ResetReadCount();
    Assert.False(await orch.ReprobeOnceAsync(default));
    Assert.Equal(0, reader.ReadCount);
}
```

- [ ] **Step 2: Run — verify failure** (`ReprobeOnceAsync` undefined).

- [ ] **Step 3: Implement `ReprobeOnceAsync`.** Select targets from `_current` (open, `!IsDraft`, `MergeReadiness == None`); if none, return `false` without reading. Otherwise hold `_writerLock` around the full-set `ReadAsync`, then patch onto a freshly-read `_current` skipping vanished rows (mirror `OnInboxEnrichmentsReady`'s `liveByPrId` guard at `:471-474`):

```csharp
internal async Task<bool> ReprobeOnceAsync(CancellationToken ct)
{
    var snap = _current;
    if (snap is null) return false;
    var targets = snap.Sections.Values.SelectMany(s => s)
        .Where(p => p.MergedAt is null && p.ClosedAt is null && !p.IsDraft && p.MergeReadiness == MergeReadiness.None)
        .ToList();
    if (targets.Count == 0) return false;

    var fullSet = snap.Sections.Values.SelectMany(s => s).Select(ToRaw).ToList(); // FULL set -> PruneAbsent safe
    IReadOnlyDictionary<PrReference, RawPrInboxItem> read;
    await _writerLock.WaitAsync(ct).ConfigureAwait(false);
    try { if (_disposed) return false; read = await _batchReader.ReadAsync(fullSet, _viewerLogin, ct).ConfigureAwait(false); }
    finally { _writerLock.Release(); }

    await _writerLock.WaitAsync(ct).ConfigureAwait(false);
    try
    {
        if (_disposed) return false;
        var current = _current;
        if (current is null) return false;
        var liveByPrId = current.Sections.Values.SelectMany(s => s)
            .GroupBy(p => p.Reference.PrId, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        var anyStillNone = false; var changed = false;
        // build a patched section map: for each target ref, if present in liveByPrId AND read resolved it, replace readiness.
        var patched = PatchReadiness(current, read, targets, liveByPrId, ref anyStillNone, ref changed);
        if (changed) { Volatile.Write(ref _current, patched); _events.Publish(new InboxUpdated(patched.Sections.Keys.ToArray(), 0)); }
        return anyStillNone;
    }
    finally { _writerLock.Release(); }
}
```

Implement `PatchReadiness` to: skip any target absent from `liveByPrId` (vanished — not resurrected); for present rows whose `read` value is non-`None`, set the new readiness; mark `anyStillNone = true` for rows still `None`. Add `ToRaw` (map `PrInboxItem`→`RawPrInboxItem`) or reuse the orchestrator's existing materialization seam.

- [ ] **Step 4: Run the four tests — verify pass.**

- [ ] **Step 5: Commit.**

```bash
git add PRism.Core/Inbox/InboxRefreshOrchestrator.cs tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs
git commit -m "feat(#655): inbox single readiness re-probe pass"
```

---

## Task 10: Inbox — fast re-probe loop, lifecycle, and cap

**Files:**
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` (launch the detached loop at the end of `RefreshAsync`; per-generation CTS; headSha-keyed cap counter; `Dispose`; hardRefresh reset)
- Test: `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs`

**Interfaces:**
- Consumes: `ReprobeOnceAsync` (Task 9).

**Constants:** `FastRetryCap = 5`; same `FastBackoff(n)` schedule as Task 3.

- [ ] **Step 1: Write the failing tests:**

```csharp
[Fact]
public async Task Refresh_launches_burst_that_resolves_then_stops()
{
    var (orch, reader, bus) = NewOrchestrator(testClock: true);
    reader.ResolveAfter(Pr(7), attempts: 2);          // None, None, Ready
    await orch.RefreshAsync(default);                  // launches the burst
    await orch.WaitForBurstIdle(TimeSpan.FromSeconds(5));
    Assert.Equal(MergeReadiness.Ready, RowFor(orch.Current!, Pr(7)).MergeReadiness);
}

[Fact]
public async Task Burst_caps_at_five_attempts_for_never_resolving_row()
{
    var (orch, reader, _) = NewOrchestrator(testClock: true);
    reader.AlwaysNone(Pr(7));
    await orch.RefreshAsync(default);
    await orch.WaitForBurstIdle(TimeSpan.FromSeconds(40));
    Assert.Equal(5, orch.BurstAttempts(Pr(7)));        // capped
}

[Fact]
public async Task Comment_only_UpdatedAt_bump_does_not_rearm_burst()
{
    var (orch, reader, _) = NewOrchestrator(testClock: true);
    reader.AlwaysNone(Pr(7), headSha: "abc");
    await orch.RefreshAsync(default); await orch.WaitForBurstIdle(default);     // exhausts budget for (ref, abc)
    reader.BumpUpdatedAt(Pr(7), headSha: "abc");        // comment: UpdatedAt changes, headSha same
    await orch.RefreshAsync(default);
    Assert.Equal(0, orch.NewBurstsSinceLastRefresh());  // no re-arm
}

[Fact]
public async Task New_commit_rearms_burst()
{
    var (orch, reader, _) = NewOrchestrator(testClock: true);
    reader.AlwaysNone(Pr(7), headSha: "abc");
    await orch.RefreshAsync(default); await orch.WaitForBurstIdle(default);
    reader.NewHead(Pr(7), headSha: "def");
    await orch.RefreshAsync(default);
    Assert.True(orch.NewBurstsSinceLastRefresh() >= 1);
}

[Fact]
public async Task New_refresh_cancels_prior_in_flight_pass_and_Dispose_cancels()
{
    var (orch, reader, _) = NewOrchestrator(testClock: true);
    reader.BlockOnRead();                                // pass hangs mid-ReadAsync
    await orch.RefreshAsync(default);                    // pass A launched
    await orch.RefreshAsync(default);                    // pass B cancels A
    Assert.True(orch.PriorPassWasCancelled);
    orch.Dispose();                                      // cancels the live CTS, no ObjectDisposedException
}
```

- [ ] **Step 2: Run — verify failure.**

- [ ] **Step 3: Add the loop + state.** Fields:

```csharp
private CancellationTokenSource? _reprobeCts;
private readonly ConcurrentDictionary<(string PrId, string HeadSha), int> _burstAttempts = new();
private const int FastRetryCap = 5;
private static TimeSpan FastBackoff(int n) => TimeSpan.FromSeconds(Math.Pow(2, n));
```

At the end of `RefreshAsync` (after the snapshot is published, near `:548`), launch the burst (replace the prior pass's CTS):

```csharp
LaunchReprobeBurst();
```

```csharp
private void LaunchReprobeBurst()
{
    var prior = Interlocked.Exchange(ref _reprobeCts, null);
    prior?.Cancel(); prior?.Dispose();
    if (_disposed) return;
    var cts = CancellationTokenSource.CreateLinkedTokenSource(CancellationToken.None);
    _reprobeCts = cts;
    _ = Task.Run(() => RunReprobeBurstAsync(cts.Token));
}

private async Task RunReprobeBurstAsync(CancellationToken ct)
{
    try
    {
        for (var attempt = 0; attempt < FastRetryCap && !ct.IsCancellationRequested; attempt++)
        {
            try { await Task.Delay(FastBackoff(attempt), ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }
            // budget gate keyed on (PrId, headSha): increment per still-None target; stop if all capped
            if (!AnyTargetUnderCap()) return;
            bool more;
            try { more = await ReprobeOnceAsync(ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }
            catch (Exception) { return; }     // swallow tick errors (mirror CI-probe/refresh passes)
            if (!more) return;                 // all resolved
        }
    }
    finally { /* leave _reprobeCts; next refresh replaces it */ }
}
```

`AnyTargetUnderCap()` increments `_burstAttempts[(PrId, headSha)]` for each still-`None` target and returns whether any is `< FastRetryCap`; prune `_burstAttempts` entries whose `(PrId, headSha)` is absent from `_current` (so a comment-only `UpdatedAt` bump keeps the same `headSha` key → no re-arm; a new commit is a new key → re-arms).

- [ ] **Step 4: hardRefresh resets the budget.** In `RefreshAsync(..., bool hardRefresh = false, ...)`, when `hardRefresh`, clear `_burstAttempts` before `LaunchReprobeBurst()` so the manual inbox Refresh re-opens the fast burst. (Debounce is the frontend Refresh button's existing disabled-while-loading; no backend change needed.)

- [ ] **Step 5: Dispose** — cancel/dispose the CTS (extend `:448-454`):

```csharp
public void Dispose()
{
    _enrichmentSub.Dispose();
    _config.Changed -= OnConfigChanged;
    _disposed = true;
    Interlocked.Exchange(ref _reprobeCts, null)?.Cancel();
    Interlocked.Exchange(ref _reprobeCts, null)?.Dispose();
    _writerLock.Dispose();
}
```

- [ ] **Step 6: Run the Task-10 tests — verify pass.**

- [ ] **Step 7: Commit.**

```bash
git add PRism.Core/Inbox/InboxRefreshOrchestrator.cs tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs
git commit -m "feat(#655): inbox fast re-probe burst with headSha-keyed cap and lifecycle"
```

---

## Final verification (run before raising the PR)

- [ ] Backend: `/c/Program\ Files/dotnet/dotnet.exe test tests/PRism.Core.Tests/PRism.Core.Tests.csproj` and `tests/PRism.GitHub.Tests/...` and `tests/PRism.Web.Tests/...` — all green. (No detached PRism server running.)
- [ ] Frontend (from `frontend/`): `npm run lint` (eslint + prettier --check), `node_modules/.bin/tsc -b`, `node_modules/.bin/vitest run`.
- [ ] `/simplify` over the branch diff (run before the verify gate — it edits the tree).
- [ ] Run the repo's full pre-push checklist verbatim (`.ai/docs/development-process.md`).
- [ ] **Live B-gate (real token store, serve detached):** push a commit to a `prpande/prism-sandbox` PR and immediately watch (a) the inbox badge and (b) the PR-detail merge panel resolve from blank → definitive within a few seconds, no manual refresh, light + dark. Also confirm the slow-compute path: a PR that stays `UNKNOWN` past the ~31s burst still resolves on the next normal-cadence read.

---

## Notes carried from the spec (accepted, not blockers)

- The narrow publish-before-`_cache.Update` re-subscribe race (`ActivePrPoller.cs:205` before `:237`) is accepted — resolves on re-navigation.
- Persistently-`UNKNOWN` quiescent-inbox cost is accepted given rarity; escape hatch = demote post-cap stuck rows to a slower-than-60s re-probe if a deployment sees many.
- Base-only mergeability re-compute (no headSha change) rides the normal cadence, not the fast burst.
