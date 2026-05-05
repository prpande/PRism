using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PRism.Core.Config;
using PRism.Core.Time;

namespace PRism.Core.Inbox;

public sealed partial class InboxPoller : BackgroundService
{
    private readonly IInboxRefreshOrchestrator _orchestrator;
    private readonly InboxSubscriberCount _subs;
    private readonly IConfigStore _config;
#pragma warning disable CA1823 // reserved for test-driven cadence injection in v2 — not currently consumed but required by the DI contract
    private readonly IClock _clock;
#pragma warning restore CA1823
    private readonly ILogger<InboxPoller> _log;

    public InboxPoller(
        IInboxRefreshOrchestrator orchestrator,
        InboxSubscriberCount subs,
        IConfigStore config,
        IClock clock,
        ILogger<InboxPoller> log)
    {
        _orchestrator = orchestrator;
        _subs = subs;
        _config = config;
        _clock = clock;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await _subs.WaitForSubscriberAsync(stoppingToken).ConfigureAwait(false);
            try
            {
                await _orchestrator.RefreshAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { throw; }
#pragma warning disable CA1031 // poller swallows tick-level errors per spec/03-poc-features.md § 12 — next tick still runs.
            catch (Exception ex)
            {
                Log.RefreshTickFailed(_log, ex);
            }
#pragma warning restore CA1031

            var cadence = TimeSpan.FromSeconds(_config.Current.Polling.InboxSeconds);
            try
            {
                await Task.Delay(cadence, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { return; }
        }
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning, Message = "Inbox refresh tick failed; will retry next cadence")]
        internal static partial void RefreshTickFailed(ILogger logger, Exception ex);
    }
}
