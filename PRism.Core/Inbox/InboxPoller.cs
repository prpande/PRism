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

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await _subs.WaitForSubscriberAsync(stoppingToken).ConfigureAwait(false);
            var nextDelay = TimeSpan.FromSeconds(_config.Current.Polling.InboxSeconds);
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

            try
            {
                await Task.Delay(nextDelay, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { return; }
        }
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning, Message = "Inbox refresh tick failed; will retry next cadence")]
        internal static partial void RefreshTickFailed(ILogger logger, Exception ex);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Inbox refresh tick rate-limited by GitHub; honoring Retry-After before next tick")]
        internal static partial void RefreshTickRateLimited(ILogger logger, RateLimitExceededException ex);
    }
}
