using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PRism.Core.Config;

namespace PRism.Core.Inbox;

public sealed partial class InboxPoller : BackgroundService
{
    private readonly IInboxRefreshOrchestrator _orchestrator;
    private readonly InboxSubscriberCount _subs;
    private readonly IConfigStore _config;
    private readonly ILogger<InboxPoller> _log;

    // Coalescing signal raced against Task.Delay so /api/auth/replace's identity-change
    // path can cut the next refresh tick latency from one cadence (up to 60s) to <500ms.
    // Capacity 1 + initial 0 → first Release transitions 0→1 and wakes the waiter; a
    // second Release while still pending throws SemaphoreFullException which
    // RequestImmediateRefresh swallows (per-tick coalesce is exactly the desired
    // semantic — a duplicate signal in the same window is redundant).
    private readonly SemaphoreSlim _refreshSignal = new(0, 1);

    public InboxPoller(
        IInboxRefreshOrchestrator orchestrator,
        InboxSubscriberCount subs,
        IConfigStore config,
        ILogger<InboxPoller> log)
    {
        _orchestrator = orchestrator;
        _subs = subs;
        _config = config;
        _log = log;
    }

    /// <summary>
    /// Signals the poller loop to cut its current Task.Delay short and run the next
    /// refresh immediately. Called from /api/auth/replace when the identity-change rule
    /// fires so the inbox repopulates under the new login without waiting the full
    /// cadence. Coalescing: multiple calls within one cadence window collapse to one
    /// extra tick (the SemaphoreFullException catch absorbs duplicates).
    /// </summary>
    public void RequestImmediateRefresh()
    {
        try { _refreshSignal.Release(); }
        catch (SemaphoreFullException) { /* already signalled; coalesce. */ }
        catch (ObjectDisposedException) { /* poller stopped; signal is moot. */ }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await _subs.WaitForSubscriberAsync(stoppingToken).ConfigureAwait(false);
            var nextDelay = TimeSpan.FromSeconds(_config.Current.Polling.InboxSeconds);
            // Clamp to a 1s floor: defensive against config typos (zero would tight-loop;
            // negative would throw ArgumentOutOfRangeException out of Task.Delay below).
            // Applied before the rate-limit max-with logic so the floor holds in both paths.
            if (nextDelay < TimeSpan.FromSeconds(1)) nextDelay = TimeSpan.FromSeconds(1);
            try
            {
                await _orchestrator.RefreshAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { throw; }
            catch (RateLimitExceededException rle)
            {
                Log.RefreshTickRateLimited(_log, rle);
                if (rle.RetryAfter is { } ra && ra > nextDelay) nextDelay = ra;
            }
#pragma warning disable CA1031 // poller swallows tick-level errors per spec/03-poc-features.md § 12 — next tick still runs.
            catch (Exception ex)
            {
                Log.RefreshTickFailed(_log, ex);
            }
#pragma warning restore CA1031

            // Race the cadence delay against an immediate-refresh signal. Linked CTS
            // cancels the losing branch so we don't leak a Task that completes minutes
            // later when the delay finally expires. Task.WhenAny itself never throws.
            using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
            var delayTask = Task.Delay(nextDelay, linkedCts.Token);
            var signalTask = _refreshSignal.WaitAsync(linkedCts.Token);
            var winner = await Task.WhenAny(delayTask, signalTask).ConfigureAwait(false);
            if (stoppingToken.IsCancellationRequested) return;
            // Cancel the losing branch. The losing Task transitions to Canceled but is
            // never awaited — Task.Delay(ct) and SemaphoreSlim.WaitAsync(ct) both treat
            // OCE on the token as a clean termination, so no UnobservedTaskException
            // fires when the Task is GC'd.
            await linkedCts.CancelAsync().ConfigureAwait(false);

            // Signal-loss defense (ADV-PR2-001). Race window: Release happens AFTER
            // WhenAny returned with delayTask as winner but BEFORE CancelAsync flips
            // signalTask to Canceled. SemaphoreSlim.Release synchronously hands the
            // slot to the registered waiter; signalTask transitions to RanToCompletion
            // and the semaphore count returns to 0 — the user-requested refresh is
            // silently consumed and lost. Detect by checking signalTask after
            // CancelAsync ran: if it succeeded (i.e., consumed a slot) but delayTask
            // was the WhenAny winner, the signal was lost in the race window and we
            // re-release so the next iteration observes it.
            if (winner == delayTask && signalTask.IsCompletedSuccessfully)
            {
                try { _refreshSignal.Release(); }
                catch (SemaphoreFullException) { /* already at capacity; coalesce */ }
                catch (ObjectDisposedException) { /* poller stopped */ }
            }
        }
    }

    public override void Dispose()
    {
        _refreshSignal.Dispose();
        base.Dispose();
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning, Message = "Inbox refresh tick failed; will retry next cadence")]
        internal static partial void RefreshTickFailed(ILogger logger, Exception ex);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Inbox refresh tick rate-limited by GitHub; honoring Retry-After before next tick")]
        internal static partial void RefreshTickRateLimited(ILogger logger, RateLimitExceededException ex);
    }
}
