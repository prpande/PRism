using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace PRism.Core.Activity;

public sealed partial class ActivityProvider : IActivityProvider
{
    private readonly IReceivedEventsReader _reader;
    private readonly ILogger<ActivityProvider> _log;

    public ActivityProvider(IReceivedEventsReader reader, ILogger<ActivityProvider> log)
    {
        _reader = reader;
        _log = log;
    }

    public async Task<ActivityResponse> GetActivityAsync(CancellationToken ct)
    {
        var read = await _reader.ReadAsync(ct).ConfigureAwait(false);
        // Capture the clock once so the 24h feed-window cutoff and the reported
        // GeneratedAt are derived from the same instant (no sub-call skew).
        var now = DateTimeOffset.UtcNow;
        var built = ActivityFeedBuilder.Build(read.Events, now);

        if (built.DroppedRecognized > 0)
            Log.DroppedRecognized(_log, built.DroppedRecognized);

        return new ActivityResponse(
            built.Items, now, new ActivityDegradation(read.Degraded));
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Debug,
            Message = "Activity: dropped {Count} recognized events missing actor/PR (payload-shape drift?).")]
        internal static partial void DroppedRecognized(ILogger logger, int count);
    }
}
