using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.Storage;

namespace PRism.Core.Activity;

public sealed partial class ActivityProvider : IActivityProvider, IDisposable
{
    private static readonly TimeSpan Ttl = TimeSpan.FromSeconds(60);
    private readonly IReceivedEventsReader _events;
    private readonly INotificationsReader _notifs;
    private readonly IWatchedReposReader _watched;
    private readonly IPrTimelineReader _timeline;
    private readonly TimeProvider _clock;
    private readonly IConfigStore _config;
    private readonly ILogger<ActivityProvider> _log;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly IIdentityKeyedFileCache<ActivityResponse> _fileCache; // #619
    private readonly IViewerLoginProvider _viewerLogin;                    // #619
    private bool _rehydrateAttempted;                                      // #619 — disk read once; touched ONLY
    // inside the _gate-held section of GetActivityAsync (concurrent first-misses serialize on the gate —
    // no double-read race, no volatile needed). Round-1 scope-guardian residual: gate-protected.

    private static readonly IReadOnlyDictionary<(string Repo, int PrNumber), TimelineActor> NoEnrichment =
        new Dictionary<(string, int), TimelineActor>();

    // volatile reference: publish (new CacheEntry) and clear (null) are each a single
    // atomic reference store on every CLR — no torn read, unlike a multi-word value tuple.
    private volatile CacheEntry? _cache;
    private int _generation;

    private sealed record CacheEntry(ActivityResponse Response, DateTimeOffset At, int Generation);

    public ActivityProvider(
        IReceivedEventsReader events,
        INotificationsReader notifs,
        IWatchedReposReader watched,
        IPrTimelineReader timeline,
        TimeProvider clock,
        IConfigStore config,
        ILogger<ActivityProvider> log,
        IIdentityKeyedFileCache<ActivityResponse> fileCache,   // #619
        IViewerLoginProvider viewerLogin)                      // #619
    {
        _events = events;
        _notifs = notifs;
        _watched = watched;
        _timeline = timeline;
        _clock = clock;
        _config = config;
        _log = log;
        _fileCache = fileCache;
        _viewerLogin = viewerLogin;
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
            // Re-read the clock AFTER the wait: a request that queued behind a slow
            // (>TTL) in-flight fetch captured `now` before WaitAsync, so the pre-wait
            // value would make a just-stale entry look fresh and would skew the
            // notifications `since` window. The fast-path check above legitimately uses
            // the pre-wait `now` (no wait happened there).
            now = _clock.GetUtcNow();
            if (_cache is { } c && c.Generation == gen && now - c.At < Ttl)
                return c.Response;

            var cfg = _config.Current;                  // #619 — HOISTED above the fan-out (was post-fan-out)
            var host = cfg.Github.Host.TrimEnd('/');    // #619 — HOISTED
            var loginSnapshot = _viewerLogin.Get();     // #619 round-2 SEC-1 — capture BEFORE fan-out

            // #619 — one-shot cold rehydrate: on the genuine first miss, seed _cache from disk with an
            // already-EXPIRED At so THIS call serves the stale rows immediately while the NEXT call is a
            // miss that fetches live (seeding At=now would defer the live fetch up to ~90s).
            if (!_rehydrateAttempted)
            {
                _rehydrateAttempted = true;
                var rid = new CacheIdentity(loginSnapshot, host); // captured-before-fan-out login + trimmed host
                var loaded = _fileCache.TryLoad(rid);
                if (loaded is not null)
                {
                    var stale = loaded with { Stale = true };
                    _cache = new CacheEntry(stale, now - Ttl, gen); // expired At → next GetActivityAsync misses
                    return stale;
                }
            }

            var evT = _events.ReadAsync(ct);
            var nfT = _notifs.ReadAsync(now.AddHours(-24), ct);
            var wtT = _watched.ReadAsync(ct);
            await Task.WhenAll(evT, nfT, wtT).ConfigureAwait(false);
            var ev = await evT.ConfigureAwait(false);
            var nf = await nfT.ConfigureAwait(false);
            var wt = await wtT.ConfigureAwait(false);

            // Enrich the vague notification rows (no actor of their own) with the latest
            // timeline actor/action via ONE batched GraphQL call. Sequential after the fetch
            // because the PR set isn't known until notifications return. Best-effort: the
            // reader degrades to an empty map on failure → rows stay actorless. Runs only on a
            // cache miss (gated below) and only when /api/activity is hit, i.e. the rail is shown.
            var enrichTargets = nf.Notifications
                .Where(n => NotificationReasonMap.IsEnrichmentCandidate(NotificationReasonMap.ToVerb(n.Reason)))
                .Select(n => (n.Repo, n.PrNumber))
                .Distinct()
                .ToList();
            var enrichment = enrichTargets.Count > 0
                ? await _timeline.ReadLatestAsync(enrichTargets, ct).ConfigureAwait(false)
                : NoEnrichment;

            var extraBots = ParseExtraBots(cfg.Inbox.KnownBots); // reuses the hoisted cfg
            var built = ActivityFeedBuilder.Build(ev.Events, nf.Notifications, wt.Repos, host, extraBots, now, enrichment);

            if (built.DroppedRecognized > 0)
                Log.DroppedRecognized(_log, built.DroppedRecognized);

            var resp = new ActivityResponse(
                built.Items, now,
                new ActivityDegradation(ev.Degraded, nf.Degraded, wt.Degraded),
                built.Watching);

            // Discard (don't cache) if a Reset() bumped the generation mid-fetch.
            if (Volatile.Read(ref _generation) == gen)
            {
                _cache = new CacheEntry(resp, now, gen);
                // #619 — persist last-known-good (gen-gated by this if). resp.Stale is false here (live fetch).
                // CancellationToken.None so a request-abort doesn't surface an unobserved task exception.
                // Stamp with `loginSnapshot` (captured BEFORE the fan-out, round-2 SEC-1) + the `host` local,
                // NOT a fresh _viewerLogin.Get() — a mid-call token swap must not re-attribute alice's feed to bob.
                _ = _fileCache.SaveAsync(resp, new CacheIdentity(loginSnapshot, host), CancellationToken.None);
            }

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
        _ = _fileCache.EvictAsync(CancellationToken.None); // #619 — drop the persisted feed on rotation
    }

    public void Dispose() => _gate.Dispose();

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Debug,
            Message = "Activity: dropped {Count} recognized events missing actor/PR (payload-shape drift?).")]
        internal static partial void DroppedRecognized(ILogger logger, int count);
    }
}
