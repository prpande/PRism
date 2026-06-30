using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Config;
using PRism.Core.Storage;

namespace PRism.Core.Inbox;

/// <summary>
/// #619 — On startup, rehydrates the last-known-good inbox snapshot from disk into the orchestrator
/// BEFORE the first poll, so /api/inbox paints real prior data instantly (offline-capable: reads only
/// config + the cache file, never the network). Registered FIRST among hosted services — BEFORE
/// ViewerLoginHydrator (whose StartAsync does a BLOCKING network credential validation, round-1 ADV-1) and
/// before InboxPoller, so the offline paint is never gated behind a network timeout. The last-validated
/// identity is read from on-disk config (loaded by ConfigStore at construction), so no upstream hosted
/// service need run first. (StartAsync runs in registration order.)
/// Fails closed: rehydrates only against a NON-EMPTY config identity matching the cache envelope (§4).
/// </summary>
public sealed class InboxCacheRehydrator : IHostedService
{
    private readonly InboxRefreshOrchestrator _orchestrator;
    private readonly IIdentityKeyedFileCache<InboxSnapshot> _cache;
    private readonly IConfigStore _config;
    private readonly ILogger<InboxCacheRehydrator> _log;

    public InboxCacheRehydrator(
        InboxRefreshOrchestrator orchestrator,
        IIdentityKeyedFileCache<InboxSnapshot> cache,
        IConfigStore config,
        ILogger<InboxCacheRehydrator>? log = null)
    {
        _orchestrator = orchestrator;
        _cache = cache;
        _config = config;
        _log = log ?? NullLogger<InboxCacheRehydrator>.Instance;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        var cfg = _config.Current; // single snapshot (each .Current acquires the reader lock)
        var accounts = cfg.Github.Accounts;
        var login = accounts.Count > 0 ? accounts[0].Login : null;
        if (string.IsNullOrEmpty(login))
            return Task.CompletedTask; // first-ever connect not yet persisted → skeleton → live

        var identity = new CacheIdentity(login, cfg.Github.Host);
        var snapshot = _cache.TryLoad(identity);
        if (snapshot is not null)
            _orchestrator.TryRehydrate(snapshot);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
