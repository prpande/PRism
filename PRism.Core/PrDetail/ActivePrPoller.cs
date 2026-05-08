using System.Collections.Concurrent;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PRism.Core.Contracts;
using PRism.Core.Events;

namespace PRism.Core.PrDetail;

// BackgroundService that polls every PR with at least one active subscriber and publishes
// ActivePrUpdated when head SHA or comment count changes. Per-PR backoff isolates flaky
// PRs from healthy ones — see spec § 6.2.
public sealed class ActivePrPoller : BackgroundService
{
    private readonly ActivePrSubscriberRegistry _registry;
    private readonly IReviewService _review;
    private readonly IReviewEventBus _bus;
    private readonly ILogger<ActivePrPoller> _logger;
    private readonly ConcurrentDictionary<PrReference, ActivePrPollerState> _state = new();
    private readonly TimeSpan _cadence = TimeSpan.FromSeconds(30);

    public ActivePrPoller(
        ActivePrSubscriberRegistry registry,
        IReviewService review,
        IReviewEventBus bus,
        ILogger<ActivePrPoller> logger)
    {
        ArgumentNullException.ThrowIfNull(registry);
        ArgumentNullException.ThrowIfNull(review);
        ArgumentNullException.ThrowIfNull(bus);
        ArgumentNullException.ThrowIfNull(logger);
        _registry = registry;
        _review = review;
        _bus = bus;
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
        foreach (var prRef in prs)
        {
            ct.ThrowIfCancellationRequested();
            var state = _state.GetOrAdd(prRef, _ => new ActivePrPollerState());
            if (state.NextRetryAt is { } retryAt && retryAt > now) continue;

            try
            {
                var snapshot = await _review.PollActivePrAsync(prRef, ct).ConfigureAwait(false);

                var headChanged = state.LastHeadSha is { } prev && prev != snapshot.HeadSha;
                var commentChanged = state.LastCommentCount is { } prevCount && prevCount != snapshot.CommentCount;

                if (headChanged || commentChanged)
                {
                    _bus.Publish(new ActivePrUpdated(
                        prRef,
                        HeadShaChanged: headChanged,
                        CommentCountChanged: commentChanged,
                        NewHeadSha: headChanged ? snapshot.HeadSha : null,
                        NewCommentCount: commentChanged ? snapshot.CommentCount : null));
                }

                state.LastHeadSha = snapshot.HeadSha;
                state.LastCommentCount = snapshot.CommentCount;
                state.ConsecutiveErrors = 0;
                state.NextRetryAt = null;
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
}
