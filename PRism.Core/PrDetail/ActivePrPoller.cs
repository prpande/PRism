using System.Collections.Concurrent;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PRism.Core.Contracts;
using PRism.Core.Events;

namespace PRism.Core.PrDetail;

// BackgroundService that polls every PR with at least one active subscriber and publishes
// ActivePrUpdated when head SHA or comment count changes. Per-PR backoff isolates flaky
// PRs from healthy ones — see spec § 6.2.
public sealed partial class ActivePrPoller : BackgroundService
{
    private readonly ActivePrSubscriberRegistry _registry;
    private readonly IPrReader _review;
    private readonly IReviewEventBus _bus;
    private readonly IActivePrCache _cache;
    private readonly ILogger<ActivePrPoller> _logger;
    private readonly ConcurrentDictionary<PrReference, ActivePrPollerState> _state = new();

    // Read-only observability seam for tests: the number of PRs with retained poller state.
    // Backs the regression assertion that _state does not grow without bound across
    // subscribe/unsubscribe cycles (issue #609). No behavior; surfaces _state.Count only.
    internal int TrackedStateCount => _state.Count;

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
        IReviewEventBus bus,
        IActivePrCache cache,
        ILogger<ActivePrPoller> logger,
        IHostEnvironment env)
    {
        ArgumentNullException.ThrowIfNull(registry);
        ArgumentNullException.ThrowIfNull(review);
        ArgumentNullException.ThrowIfNull(bus);
        ArgumentNullException.ThrowIfNull(cache);
        ArgumentNullException.ThrowIfNull(env);
        _cadence = ResolveCadence(env);
        ArgumentNullException.ThrowIfNull(logger);
        _registry = registry;
        _review = review;
        _bus = bus;
        _cache = cache;
        _logger = logger;
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
            try
            {
                await Task.Delay(_cadence, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
        }
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
        // snapshot, so removing during iteration is safe. When _state is empty the loop is
        // already a no-op (empty key snapshot), so no guard is needed.
        var live = new HashSet<PrReference>(prs);
        foreach (var key in _state.Keys)
        {
            if (!live.Contains(key)) _state.TryRemove(key, out _);
        }

        foreach (var prRef in prs)
        {
            ct.ThrowIfCancellationRequested();
            var state = _state.GetOrAdd(prRef, _ => new ActivePrPollerState());
            if (state.NextRetryAt is { } retryAt && retryAt > now) continue;

            try
            {
                var snapshot = await _review.PollActivePrAsync(prRef, ct).ConfigureAwait(false);

                // First-poll detection: state has no LastHeadSha / LastCommentCount yet.
                // Emit ActivePrUpdated even with zero deltas so frontend gates that
                // depend on the snapshot being hydrated (`useFirstActivePrPollComplete`
                // backing the Mark-all-read button per spec § 5.6) reliably fire on
                // the first successful poll for a newly-subscribed PR. Without this,
                // a quiet PR with no head-SHA or comment-count changes never produces
                // an event, leaving the gate closed indefinitely.
                // LastBaseSha follows the same first-poll null pattern as LastHeadSha/LastCommentCount:
                // it is null on the first poll, so baseChanged short-circuits to false (no hydration false-fire).
                var firstPoll = state.LastHeadSha is null && state.LastCommentCount is null;
                var headChanged = state.LastHeadSha is { } prev && prev != snapshot.HeadSha;
                var baseChanged = state.LastBaseSha is { } prevBase && prevBase != snapshot.BaseSha;
                var commentChanged = state.LastCommentCount is { } prevCount && prevCount != snapshot.CommentCount;
                // Close-state transition (open → merged/closed). Both producers now hand an enum
                // PrState, so this is exact enum inequality — the prior case-insensitive string
                // compare (bridging fake-uppercase vs real-lowercase) is no longer needed.
                var stateChanged = state.LastPrState is { } prevState && prevState != snapshot.PrState;

                LogPollSnapshot(_logger, prRef, snapshot.HeadSha, state.LastHeadSha, firstPoll, headChanged, baseChanged, commentChanged, stateChanged);

                if (firstPoll || headChanged || baseChanged || commentChanged || stateChanged)
                {
                    var commentCountDelta = state.LastCommentCount is { } priorCount
                        ? snapshot.CommentCount - priorCount
                        : 0;
                    var isMerged = snapshot.PrState == PrState.Merged;
                    var isClosed = snapshot.PrState == PrState.Closed;
                    // Load-bearing ordering: Publish MUST precede _cache.Update.
                    // The bus is synchronous, so eviction handlers (summarizer, loader) run
                    // against the pre-move snapshot. _cache.Update installs the new base AFTER
                    // eviction — required by the R7 compare-and-set reasoning in Task 9.
                    _bus.Publish(new ActivePrUpdated(
                        prRef,
                        HeadShaChanged: headChanged,
                        CommentCountChanged: commentChanged,
                        NewHeadSha: headChanged ? snapshot.HeadSha : null,
                        CommentCountDelta: commentCountDelta,
                        IsMerged: isMerged,
                        IsClosed: isClosed,
                        BaseShaChanged: baseChanged,
                        NewBaseSha: baseChanged ? snapshot.BaseSha : null));
                }

                state.LastHeadSha = snapshot.HeadSha;
                state.LastBaseSha = snapshot.BaseSha;
                state.LastCommentCount = snapshot.CommentCount;
                state.LastPrState = snapshot.PrState;
                state.ConsecutiveErrors = 0;
                state.NextRetryAt = null;

                // Publish cache snapshot for PUT /draft (markAllRead) and POST /reload
                // head-shift detection. HighestIssueCommentId stays null in S4 — see
                // IActivePrCache class comment + deferrals doc for the markAllRead gap.
                _cache.Update(prRef, new ActivePrSnapshot(
                    HeadSha: snapshot.HeadSha,
                    HighestIssueCommentId: null,
                    ObservedAt: now,
                    BaseSha: snapshot.BaseSha));
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
#pragma warning disable CA1031 // single-PR failure must not abort the tick
            catch (Exception ex)
            {
                s_pollFailedLog(_logger, prRef, ex);
                ApplyBackoff(state, now);
            }
#pragma warning restore CA1031
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

    private static readonly Action<ILogger, PrReference, Exception?> s_pollFailedLog =
        LoggerMessage.Define<PrReference>(LogLevel.Warning,
            new EventId(1, "ActivePrPollFailed"),
            "Active-PR poll failed for {PrRef}; applying backoff");

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
