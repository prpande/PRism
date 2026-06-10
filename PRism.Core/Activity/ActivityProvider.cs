using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using PRism.Core.Config;

namespace PRism.Core.Activity;

public sealed partial class ActivityProvider : IActivityProvider, IDisposable
{
    private static readonly TimeSpan Ttl = TimeSpan.FromSeconds(60);
    private readonly IReceivedEventsReader _events;
    private readonly INotificationsReader _notifs;
    private readonly IWatchedReposReader _watched;
    private readonly TimeProvider _clock;
    private readonly IConfigStore _config;
    private readonly ILogger<ActivityProvider> _log;
    private readonly SemaphoreSlim _gate = new(1, 1);

    // volatile reference: publish (new CacheEntry) and clear (null) are each a single
    // atomic reference store on every CLR — no torn read, unlike a multi-word value tuple.
    private volatile CacheEntry? _cache;
    private int _generation;

    private sealed record CacheEntry(ActivityResponse Response, DateTimeOffset At, int Generation);

    public ActivityProvider(
        IReceivedEventsReader events,
        INotificationsReader notifs,
        IWatchedReposReader watched,
        TimeProvider clock,
        IConfigStore config,
        ILogger<ActivityProvider> log)
    {
        _events = events;
        _notifs = notifs;
        _watched = watched;
        _clock = clock;
        _config = config;
        _log = log;
    }

    private static string[] ParseExtraBots(string csv) =>
        csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
           .Distinct(StringComparer.OrdinalIgnoreCase)
           .ToArray();

    public async Task<ActivityResponse> GetActivityAsync(CancellationToken ct)
    {
        var now = _clock.GetUtcNow();
        var gen = Volatile.Read(ref _generation);
        // Cache-hit read is generation-checked, not just TTL-checked: a token rotation
        // bumps the generation, so an entry stamped under the old generation is rejected
        // even within its 60s TTL (closes the cache-HIT race where a reader captures a
        // pre-reset entry and serves a stale feed).
        if (_cache is { } hit && hit.Generation == gen && now - hit.At < Ttl)
            return hit.Response;

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            gen = Volatile.Read(ref _generation);                  // re-read under the gate
            if (_cache is { } c && c.Generation == gen && now - c.At < Ttl)
                return c.Response;

            var evT = _events.ReadAsync(ct);
            var nfT = _notifs.ReadAsync(now.AddHours(-24), ct);
            var wtT = _watched.ReadAsync(ct);
            await Task.WhenAll(evT, nfT, wtT).ConfigureAwait(false);
            var ev = await evT.ConfigureAwait(false);
            var nf = await nfT.ConfigureAwait(false);
            var wt = await wtT.ConfigureAwait(false);

            var cfg = _config.Current;                             // read host + bots fresh per fetch
            var host = cfg.Github.Host.TrimEnd('/');
            var extraBots = ParseExtraBots(cfg.Inbox.KnownBots);
            var built = ActivityFeedBuilder.Build(ev.Events, nf.Notifications, wt.Repos, host, extraBots, now);

            if (built.DroppedRecognized > 0)
                Log.DroppedRecognized(_log, built.DroppedRecognized);

            var resp = new ActivityResponse(
                built.Items, now,
                new ActivityDegradation(ev.Degraded, nf.Degraded, wt.Degraded),
                built.Watching);

            // Discard (don't cache) if a Reset() bumped the generation mid-fetch.
            if (Volatile.Read(ref _generation) == gen)
                _cache = new CacheEntry(resp, now, gen);

            return resp;
        }
        finally
        {
            _gate.Release();
        }
    }

    // Non-blocking: never waits on an in-flight fetch (called on the auth/replace request
    // thread). Bumps the generation so any in-flight build is discarded rather than cached,
    // and clears the published entry.
    public void Reset()
    {
        Interlocked.Increment(ref _generation);
        _cache = null;
    }

    public void Dispose() => _gate.Dispose();

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Debug,
            Message = "Activity: dropped {Count} recognized events missing actor/PR (payload-shape drift?).")]
        internal static partial void DroppedRecognized(ILogger logger, int count);
    }
}
