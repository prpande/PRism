using System.Collections.Concurrent;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;

namespace PRism.Core.PrDetail;

// BackgroundService that polls every PR with at least one active subscriber and publishes
// ActivePrUpdated when head SHA or comment count changes. Per-PR backoff isolates flaky
// PRs from healthy ones — see spec § 6.2.
// Implements IImmediateRefresh (Task 4) so the SSE channel can cut the cadence delay
// short the moment a new subscriber connects — causing mergeability to resolve in ~1s
// instead of waiting up to 30s for the next scheduled tick.
public sealed partial class ActivePrPoller : BackgroundService, IImmediateRefresh
{
    private readonly ActivePrSubscriberRegistry _registry;
    private readonly IPrReader _review;
    // #598 Slice B — ONE batched GraphQL read per tick across all subscribed PRs, replacing the
    // old per-ref REST PollActivePrAsync fan-out. _review is retained only for its 3 non-poller
    // callers (the poller no longer calls PollActivePrAsync).
    private readonly IActivePrBatchReader _batch;
    private readonly IReviewEventBus _bus;
    private readonly IActivePrCache _cache;
    private readonly ILogger<ActivePrPoller> _logger;
    private readonly ConcurrentDictionary<PrReference, ActivePrPollerState> _state = new();

    // Coalescing wake signal: Release() cuts the current WaitForNextCycleAsync short so a
    // newly-connected SSE subscriber's mergeability resolves in ~1s not up to 30s. Capacity 1
    // + initial 0: first Release transitions 0→1 and wakes the waiter; a second Release while
    // already pending throws SemaphoreFullException (swallowed) — a duplicate wake in the same
    // window is the correct coalesce semantic.
    private readonly SemaphoreSlim _refreshSignal = new(0, 1);

    // Min-interval guard: a wake that lands within _minWakeInterval of the last tick re-delays
    // the remaining window instead of ticking — coalescing reconnect storms to one extra tick.
    // Default 3s; tests inject a shorter value to observe the guard without waiting wall-clock.
    private readonly TimeSpan _minWakeInterval;

    // Timestamp of the last completed tick (updated in ExecuteAsync after TickAsync returns).
    // DateTimeOffset.MinValue on first cycle so the guard never fires before the first tick.
    private DateTimeOffset _lastTickAt = DateTimeOffset.MinValue;

    // Read-only observability seam for tests: the number of PRs with retained poller state.
    // Backs the regression assertion that _state does not grow without bound across
    // subscribe/unsubscribe cycles (issue #609). No behavior; surfaces _state.Count only.
    internal int TrackedStateCount => _state.Count;

    // Test accessor: exposes the mutable per-PR state bag so unit tests can assert on
    // NextRetryAt and FastRetryCount after calling TickAsync directly. Mirrors TrackedStateCount.
    internal ActivePrPollerState PeekState(PrReference prRef) => _state[prRef];

    // Default 30s for production; PRISM_POLLER_CADENCE_SECONDS overrides ONLY
    // when the host is running under Test env so that a stray env var set on a
    // production host cannot drive the poller into GitHub secondary-rate-limit
    // territory (the existing exponential backoff fires on errors, not on
    // healthy 1Hz traffic). E2E tests need a sub-30s cadence so the
    // pr-updated event fires inside a Playwright test window — Test-env-only
    // gating is sufficient for that.
    //
    // Env gate keys off IHostEnvironment (not the raw env var) so that
    // WebApplicationFactory tests using UseEnvironment("Test") agree with the
    // hosting model. Reading the env var directly diverges from the host's
    // view in those tests.
    private readonly TimeSpan _cadence;

    private static TimeSpan ResolveCadence(IHostEnvironment env)
    {
        if (env.IsEnvironment("Test"))
        {
            var raw = Environment.GetEnvironmentVariable("PRISM_POLLER_CADENCE_SECONDS");
            if (!string.IsNullOrEmpty(raw)
                && int.TryParse(raw, System.Globalization.CultureInfo.InvariantCulture, out var sec)
                && sec > 0)
            {
                return TimeSpan.FromSeconds(sec);
            }
        }
        return TimeSpan.FromSeconds(30);
    }

    public ActivePrPoller(
        ActivePrSubscriberRegistry registry,
        IPrReader review,
        IActivePrBatchReader batch,
        IReviewEventBus bus,
        IActivePrCache cache,
        ILogger<ActivePrPoller> logger,
        IHostEnvironment env,
        TimeSpan minWakeInterval = default)
    {
        ArgumentNullException.ThrowIfNull(registry);
        ArgumentNullException.ThrowIfNull(review);
        ArgumentNullException.ThrowIfNull(batch);
        ArgumentNullException.ThrowIfNull(bus);
        ArgumentNullException.ThrowIfNull(cache);
        ArgumentNullException.ThrowIfNull(env);
        _cadence = ResolveCadence(env);
        ArgumentNullException.ThrowIfNull(logger);
        _minWakeInterval = minWakeInterval == default ? TimeSpan.FromSeconds(3) : minWakeInterval;
        _registry = registry;
        _review = review;
        _batch = batch;
        _bus = bus;
        _cache = cache;
        _logger = logger;
    }

    /// <summary>
    /// Signals the poller loop to cut its current wait short and tick immediately.
    /// Called by the SSE channel when a new subscriber connects so mergeability
    /// resolves in ~1s rather than waiting up to 30s for the next cadence tick.
    /// Coalescing: multiple calls within one min-interval window collapse to one
    /// extra tick (the SemaphoreFullException catch absorbs duplicates).
    /// </summary>
    public void RequestImmediateRefresh()
    {
        try { _refreshSignal.Release(); }
        catch (SemaphoreFullException) { /* already signalled; coalesce */ }
        catch (ObjectDisposedException) { /* poller stopped; signal is moot */ }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await TickAsync(DateTimeOffset.UtcNow, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
#pragma warning disable CA1031
            catch (Exception ex)
            {
                s_tickFailedLog(_logger, ex);
            }
#pragma warning restore CA1031
            _lastTickAt = DateTimeOffset.UtcNow;
            try
            {
                await WaitForNextCycleAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
        }
    }

    // Sleeps until it's time to tick. Adaptive: wakes at the soonest NextRetryAt (clamped to
    // [0, _cadence]). A subscribe/commit wake that lands within _minWakeInterval of the last tick
    // re-delays at least the remaining guard window instead of ticking — coalescing a reconnect storm to one tick
    // without busy-looping (each iteration awaits a real Task.Delay >= minRemaining).
    private async Task WaitForNextCycleAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var now = DateTimeOffset.UtcNow;
            var soonest = _state.Values.Select(s => s.NextRetryAt).Where(t => t is not null).DefaultIfEmpty(null).Min();
            var delay = ComputeWaitDelay(now, _lastTickAt, soonest, _minWakeInterval, _cadence);
            if (delay <= TimeSpan.Zero) return;                          // due and outside the guard window -> tick

            using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
            var delayTask = Task.Delay(delay, linkedCts.Token);
            var signalTask = _refreshSignal.WaitAsync(linkedCts.Token);
            var winner = await Task.WhenAny(delayTask, signalTask).ConfigureAwait(false);
            if (stoppingToken.IsCancellationRequested) return;
            await linkedCts.CancelAsync().ConfigureAwait(false);
            // Signal-loss defense (ADV-PR2-001): timer won but a signal had also fired -> re-arm it.
            if (winner == delayTask && signalTask.IsCompletedSuccessfully)
            { try { _refreshSignal.Release(); } catch (SemaphoreFullException) { } catch (ObjectDisposedException) { } }

            if (winner == delayTask) return;                            // adaptive/cadence elapsed -> tick
            if (DateTimeOffset.UtcNow - _lastTickAt >= _minWakeInterval) return; // wake outside window -> tick now
            // else: woken inside the guard window -> loop and re-delay the remaining window (no tick).
        }
    }

    // Pure delay arithmetic extracted for deterministic unit testing (no timers, no state).
    // Returns the duration WaitForNextCycleAsync should sleep before the next tick:
    //   adaptive = how long until the soonest scheduled fast-retry (clamped to [0, cadence]),
    //              or cadence when no fast-retry is pending.
    //   minRemaining = guard window remainder; positive only while inside the guard.
    //   delay = max(adaptive, minRemaining) — the guard prevents adaptive from going below the
    //           remaining window, ensuring a within-window wake never causes an immediate re-tick.
    //   ≤ 0 → caller should return (tick now): due fast-retry, outside the guard window.
    internal static TimeSpan ComputeWaitDelay(
        DateTimeOffset now,
        DateTimeOffset lastTickAt,
        DateTimeOffset? soonestNextRetry,
        TimeSpan minWakeInterval,
        TimeSpan cadence)
    {
        var adaptive = soonestNextRetry is { } due
            ? TimeSpan.FromTicks(Math.Clamp((due - now).Ticks, 0, cadence.Ticks))
            : cadence;
        var minRemaining = minWakeInterval - (now - lastTickAt);   // > 0 while inside the guard window
        return adaptive < minRemaining ? minRemaining : adaptive;
    }

    public override void Dispose()
    {
        _refreshSignal.Dispose();
        base.Dispose();
    }

    // Internal for unit tests; ExecuteAsync passes DateTimeOffset.UtcNow each tick. The
    // explicit `now` parameter keeps backoff arithmetic deterministic in tests without
    // requiring a TimeProvider injection.
    internal async Task TickAsync(DateTimeOffset now, CancellationToken ct)
    {
        var prs = _registry.UniquePrRefs();

        // Prune retained state for PRs that no longer have any active subscriber (issue #609).
        // Two reasons: (1) without this, _state grows one entry per distinct PR ever subscribed
        // for the process lifetime; (2) a re-subscribe to a previously-viewed quiet PR would
        // otherwise find the stale entry, so firstPoll is false and no hydration ActivePrUpdated
        // fires, leaving the frontend Mark-all-read gate (useFirstActivePrPollComplete) closed.
        // A re-subscribe that lands inside the same cadence window as the unsubscribe keeps its
        // state — the tick never observed zero subscribers — which is acceptable: only a
        // re-subscribe AFTER an observed unsubscribe re-fires first-poll. _state.Keys is a
        // snapshot, so removing during iteration is safe. This runs BEFORE the empty-candidates
        // early return below so a tick that observes zero subscribers still reclaims their state.
        // The cache (_snapshots) is the sibling per-PR map with the same leak (#624) — prune both
        // against the SAME live set so they can never diverge.
        var live = new HashSet<PrReference>(prs);
        foreach (var key in _state.Keys)
        {
            if (!live.Contains(key)) _state.TryRemove(key, out _);
        }
        _cache.Retain(live);

        // #598 Slice B: gather every subscribed PR not currently in backoff, then issue ONE
        // batched GraphQL read for the whole set. Whole-tick-abort contract: a rate-limited or
        // poison tick retains last-known for ALL candidates and publishes nothing — one query
        // serves all PRs, so an aborted tick must never blank any PR's readiness/counts.
        var candidates = prs
            .Where(r => _state.GetOrAdd(r, _ => new ActivePrPollerState()).NextRetryAt is not { } t || t <= now)
            .ToList();
        if (candidates.Count == 0) return;

        IReadOnlyDictionary<PrReference, ActivePrPollSnapshot> snapshots;
        try
        {
            snapshots = await _batch.PollBatchAsync(candidates, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (RateLimitExceededException ex)
        {
            // Expected backoff (GitHub rate limit). Retain last-known for all candidates, back off, publish nothing.
            s_pollRateLimitedLog(_logger, candidates.Count, ex);
            foreach (var r in candidates) ApplyBackoff(_state[r], now);
            return;
        }
#pragma warning disable CA1031 // whole-tick abort: a transport / poison-payload failure must not crash the loop
        catch (Exception ex)
        {
            // Whole-tick abort on transport / poison payload (e.g. JsonException from a truncated body
            // or a GitHub schema change). Log at ERROR so a persistent break is visible — a silent
            // back-off-every-tick would otherwise mask it. Retain last-known, back off, publish nothing.
            s_pollTickFailedLog(_logger, candidates.Count, ex);
            foreach (var r in candidates) ApplyBackoff(_state[r], now);
            return;
        }
#pragma warning restore CA1031

        foreach (var prRef in candidates)
        {
            if (!snapshots.TryGetValue(prRef, out var snapshot)) continue; // per-alias drop: keep last-known
            var state = _state[prRef];

            // First-poll detection: state has no LastHeadSha / LastCommentCount yet. Emit even with
            // zero deltas so the frontend hydration gate (useFirstActivePrPollComplete, spec § 5.6)
            // fires on the first successful poll. LastBaseSha follows the same first-poll null pattern.
            var firstPoll = state.LastHeadSha is null && state.LastCommentCount is null;
            // ORDER-CRITICAL: compute headChanged against the PRIOR LastHeadSha, BEFORE the state
            // update overwrites it below. The fast-retry re-arm (`if (headChanged) FastRetryCount = 0`)
            // depends on this — moving the state mutation above this line silently breaks the re-arm
            // (the compare would always be false). See the matching note at the re-arm site (PR #658 review).
            var headChanged = state.LastHeadSha is { } ph && ph != snapshot.HeadSha;
            var baseChanged = state.LastBaseSha is { } pb && pb != snapshot.BaseSha;
            var commentChanged = state.LastCommentCount is { } pc && pc != snapshot.CommentCount;
            var stateChanged = state.LastPrState is { } ps && ps != snapshot.PrState;
            // Anti-flicker: only a change TO a real (non-None) readiness publishes. A transient
            // None (GitHub's async mergeStateStatus recompute returning UNKNOWN) must not blank or
            // churn the live badge — never-cache-UNKNOWN (D4) applied to the live surface. Terminal
            // Merged/Closed are non-None and ride stateChanged anyway, so the badge still clears on
            // merge. A null LastMergeReadiness (no prior real readiness — e.g. the first read was a
            // transient None) with a non-None new value IS a change: the badge appears for the first
            // time. LastMergeReadiness only ever holds non-None values (it is not reset on a None
            // tick), so `last != new` with non-None new never fires on a steady Ready→Ready tick.
            var readinessChanged = snapshot.MergeReadiness != MergeReadiness.None
                && state.LastMergeReadiness != snapshot.MergeReadiness;
            // #620: a root PR comment is the feed's primary content but bumps none of the terms
            // above (CommentCount is inline-review-thread comments only). Gate on the root
            // issue-comment total fetched separately (GitHubActivePrBatchReader.IssueCommentCount).
            var issueCommentChanged =
                state.LastIssueCommentCount is { } lic && lic != snapshot.IssueCommentCount;
            // #620: reviewer name-lists ride the frame (Approvals/ChangesRequested/AwaitingReviewers)
            // but never triggered the gate on their own. AwaitingReviewers is nullable
            // (IReadOnlyList<Reviewer>?) — `?.Count ?? 0` guards the REST path where it is null.
            var reviewersChanged =
                (state.LastApprovals is { } laApprovals && laApprovals != snapshot.Approvals) ||
                (state.LastChangesRequested is { } laCr && laCr != snapshot.ChangesRequested) ||
                (state.LastAwaitingCount is { } laAwait && laAwait != (snapshot.AwaitingReviewers?.Count ?? 0));

            LogPollSnapshot(_logger, prRef, snapshot.HeadSha, state.LastHeadSha, firstPoll, headChanged, baseChanged, commentChanged, stateChanged);

            if (firstPoll || headChanged || baseChanged || commentChanged || stateChanged || readinessChanged || issueCommentChanged || reviewersChanged)
            {
                var commentDelta = state.LastCommentCount is { } prior ? snapshot.CommentCount - prior : 0;
                // Load-bearing ordering: Publish MUST precede _cache.Update. The bus is synchronous,
                // so eviction handlers (summarizer, loader) run against the pre-move snapshot.
                _bus.Publish(new ActivePrUpdated(
                    prRef,
                    HeadShaChanged: headChanged,
                    CommentCountChanged: commentChanged,
                    NewHeadSha: headChanged ? snapshot.HeadSha : null,
                    CommentCountDelta: commentDelta,
                    IsMerged: snapshot.PrState == PrState.Merged,
                    IsClosed: snapshot.PrState == PrState.Closed,
                    BaseShaChanged: baseChanged,
                    NewBaseSha: baseChanged ? snapshot.BaseSha : null,
                    MergeReadiness: snapshot.MergeReadiness,
                    MergeReadinessChanged: readinessChanged,
                    Approvals: snapshot.Approvals,
                    ChangesRequested: snapshot.ChangesRequested,
                    Approvers: snapshot.Approvers,
                    ChangesRequestedBy: snapshot.ChangesRequestedBy,
                    AwaitingReviewers: snapshot.AwaitingReviewers));
            }

            state.LastHeadSha = snapshot.HeadSha;
            state.LastBaseSha = snapshot.BaseSha;
            state.LastCommentCount = snapshot.CommentCount;
            state.LastPrState = snapshot.PrState;
            // Retain last-known non-None readiness so a transient UNKNOWN→None doesn't reset the
            // baseline and cause a redundant re-publish on the next None→Ready flap.
            if (snapshot.MergeReadiness != MergeReadiness.None)
                state.LastMergeReadiness = snapshot.MergeReadiness;
            state.LastIssueCommentCount = snapshot.IssueCommentCount;
            state.LastApprovals = snapshot.Approvals;
            state.LastChangesRequested = snapshot.ChangesRequested;
            state.LastAwaitingCount = snapshot.AwaitingReviewers?.Count ?? 0;
            state.ConsecutiveErrors = 0;
            // Fast-retry scheduling: if this PR's derived readiness is transiently None (GitHub
            // still computing mergeStateStatus) and the burst budget is not yet exhausted, schedule
            // an early re-poll at exponential backoff. Re-arm the budget when the head SHA changes
            // (new commit supersedes the previous burst) using the already-computed headChanged local
            // — DO NOT compare snapshot.HeadSha != state.LastHeadSha here, because line 224 has
            // already overwritten LastHeadSha to the new value, so that compare is always false.
            if (headChanged) state.FastRetryCount = 0; // new commit -> re-arm the burst budget
            var wantsFastRetry = snapshot.PrState == PrState.Open
                && !snapshot.IsDraft
                && snapshot.MergeReadiness == MergeReadiness.None
                && state.FastRetryCount < FastPollBurst.Cap;
            if (wantsFastRetry)
            {
                state.NextRetryAt = now + FastPollBurst.Backoff(state.FastRetryCount);
                state.FastRetryCount++;
            }
            else
            {
                state.NextRetryAt = null;       // replaces the unconditional pre-Task-3 reset
                if (snapshot.MergeReadiness != MergeReadiness.None) state.FastRetryCount = 0; // resolved -> reset budget
            }

            // Publish cache snapshot for PUT /draft (markAllRead) and POST /reload head-shift
            // detection. HighestIssueCommentId stays null in S4 — see IActivePrCache class comment.
            // MergeReadiness uses the same retain-non-None anti-flicker logic as state.LastMergeReadiness
            // so a transient GitHub UNKNOWN→None recompute does not blank the cached readiness badge.
            _cache.Update(prRef, new ActivePrSnapshot(
                HeadSha: snapshot.HeadSha,
                HighestIssueCommentId: null,
                ObservedAt: now,
                BaseSha: snapshot.BaseSha,
                MergeReadiness: snapshot.MergeReadiness != MergeReadiness.None
                    ? snapshot.MergeReadiness
                    : (state.LastMergeReadiness ?? MergeReadiness.None)));
        }
    }

    private static void ApplyBackoff(ActivePrPollerState state, DateTimeOffset now)
    {
        // min(2^errors * 30, 300) seconds. Q6 (deferrals sidecar): no Retry-After respect, no
        // dedicated secondary-rate-limit handling — plain exponential backoff for any failure.
        // Counter clamped at 32 to prevent int overflow at 2^31 failures: without the clamp,
        // ConsecutiveErrors would wrap to a large negative integer, making `Math.Pow(2, neg)`
        // approach zero and effectively removing the backoff. Backoff hits the 300s ceiling
        // at N≥4, so 32 is well above the point where observable behaviour stops changing.
        state.ConsecutiveErrors = Math.Min(state.ConsecutiveErrors + 1, 32);
        var seconds = Math.Min(Math.Pow(2, state.ConsecutiveErrors) * 30, 300);
        state.NextRetryAt = now.AddSeconds(seconds);
    }

    // Expected GitHub rate-limit backoff for the whole batched tick. Warning (recoverable).
    private static readonly Action<ILogger, int, Exception?> s_pollRateLimitedLog =
        LoggerMessage.Define<int>(LogLevel.Warning,
            new EventId(1, "ActivePrPollRateLimited"),
            "Active-PR batch poll rate-limited; retaining last-known and backing off {Count} ref(s)");

    // Transport / poison-payload whole-tick abort. Error so a persistent break is visible
    // (a silent back-off-every-tick would otherwise mask a schema change or truncated body).
    private static readonly Action<ILogger, int, Exception?> s_pollTickFailedLog =
        LoggerMessage.Define<int>(LogLevel.Error,
            new EventId(1, "ActivePrPollTickFailed"),
            "Active-PR batch poll failed; retaining last-known and backing off {Count} ref(s)");

    private static readonly Action<ILogger, Exception?> s_tickFailedLog =
        LoggerMessage.Define(LogLevel.Error,
            new EventId(2, "ActivePrPollerTickFailed"),
            "ActivePrPoller tick failed");

    [LoggerMessage(EventId = 3, EventName = "ActivePrPollSnapshot", Level = LogLevel.Information,
        Message = "Active-PR poll snapshot {PrRef}: head={HeadSha} prevHead={PrevHeadSha} firstPoll={FirstPoll} headChanged={HeadChanged} baseChanged={BaseChanged} commentChanged={CommentChanged} stateChanged={StateChanged}")]
    private static partial void LogPollSnapshot(
        ILogger logger,
        PrReference prRef,
        string headSha,
        string? prevHeadSha,
        bool firstPoll,
        bool headChanged,
        bool baseChanged,
        bool commentChanged,
        bool stateChanged);
}
