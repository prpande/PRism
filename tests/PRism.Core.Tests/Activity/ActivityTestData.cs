using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using PRism.Core.Activity;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.State;
using PRism.Core.Storage;
using PRism.Core.Tests.Inbox;

namespace PRism.Core.Tests.Activity;

// ---------------------------------------------------------------------------
// Null / stub doubles shared by ActivityCacheTests and ActivityProviderTests
// ---------------------------------------------------------------------------

/// <summary>No-op IIdentityKeyedFileCache: never saves, always misses, never evicts.
/// Use in existing ActivityProviderTests to satisfy the new required ctor params.</summary>
internal sealed class NullFileCache<T> : IIdentityKeyedFileCache<T> where T : class
{
    public static readonly NullFileCache<T> Instance = new();

    public Task SaveAsync(T payload, CacheIdentity identity, CancellationToken ct) =>
        Task.CompletedTask;

    public T? TryLoad(CacheIdentity identity) => null;

    public Task EvictAsync(CancellationToken ct) => Task.CompletedTask;
}

/// <summary>Minimal IViewerLoginProvider backed by a delegate (so tests can swap the login mid-call).</summary>
internal sealed class StubViewerLoginProvider(Func<string> getter) : IViewerLoginProvider
{
    public static StubViewerLoginProvider For(string login) => new(() => login);

    public string Get() => getter();

    public void Set(string login) { /* ignored in tests */ }
}

// ---------------------------------------------------------------------------
// SpyReaders — wraps three reader fakes + a once-fired fan-out hook
// ---------------------------------------------------------------------------

/// <summary>Three reader spies wired together: counts total ReadAsync calls and fires
/// <see cref="OnFanOutStarted"/> exactly once (when the events reader is first entered),
/// so tests can flip state (login, generation) at the precise fan-out boundary.</summary>
public sealed class SpyReaders
{
    public int TotalReads { get; private set; }

    /// <summary>Invoked once when the events reader enters ReadAsync (i.e. fan-out starts,
    /// after loginSnapshot is captured but before any network result returns).</summary>
    public Action? OnFanOutStarted { get; set; }

    public IReceivedEventsReader Events { get; }
    public INotificationsReader Notifs { get; }
    public IWatchedReposReader Watched { get; }
    public IPrTimelineReader Timeline { get; }

    public SpyReaders()
    {
        Events  = new SpyEventsReader(this);
        Notifs  = new SpyNotifsReader(this);
        Watched = new SpyWatchReader(this);
        Timeline = new NoOpTimelineReader();
    }

    private sealed class SpyEventsReader(SpyReaders parent) : IReceivedEventsReader
    {
        public Task<ReceivedEventsResult> ReadAsync(CancellationToken ct)
        {
            // Consume the hook once so it does not fire on subsequent calls (e.g. test 16's
            // second GetActivityAsync).
            var hook = parent.OnFanOutStarted;
            parent.OnFanOutStarted = null;
            hook?.Invoke();
            parent.TotalReads++;
            return Task.FromResult(new ReceivedEventsResult([], Degraded: false));
        }
    }

    private sealed class SpyNotifsReader(SpyReaders parent) : INotificationsReader
    {
        public Task<NotificationsResult> ReadAsync(DateTimeOffset since, CancellationToken ct)
        {
            parent.TotalReads++;
            return Task.FromResult(new NotificationsResult([], Degraded: false));
        }
    }

    private sealed class SpyWatchReader(SpyReaders parent) : IWatchedReposReader
    {
        public Task<WatchedReposResult> ReadAsync(CancellationToken ct)
        {
            parent.TotalReads++;
            return Task.FromResult(new WatchedReposResult([], Degraded: false));
        }
    }

    private sealed class NoOpTimelineReader : IPrTimelineReader
    {
        public Task<IReadOnlyDictionary<(string Repo, int PrNumber), TimelineActor>> ReadLatestAsync(
            IReadOnlyCollection<(string Repo, int PrNumber)> pullRequests, CancellationToken ct) =>
            Task.FromResult<IReadOnlyDictionary<(string Repo, int PrNumber), TimelineActor>>(
                new Dictionary<(string Repo, int PrNumber), TimelineActor>());
    }
}

// ---------------------------------------------------------------------------
// ActivityTestData — factory helpers for provider + response
// ---------------------------------------------------------------------------

public static class ActivityTestData
{
    // Mirror the same epoch used in ActivityProviderTests so the 24h activity window
    // includes any `now`-stamped fixtures (UnixEpoch+56years ≈ 2026).
    private static FakeTimeProvider Clock() =>
        new(DateTimeOffset.UnixEpoch.AddYears(56));

    // Builds a StubConfigStore whose Github.Host equals the provided host string.
    // ActivityProvider does `cfg.Github.Host.TrimEnd('/')`, so pass the already-trimmed value.
    private static IConfigStore ConfigWith(string host)
    {
        var d = AppConfig.Default;
        return new StubConfigStore(d with
        {
            Github = new GithubConfig(new[]
            {
                new GithubAccountConfig(
                    Id: AccountKeys.Default,
                    Host: host,
                    Login: null,
                    LocalWorkspace: null)
            })
        });
    }

    /// <summary>
    /// Constructs an <see cref="ActivityProvider"/> wired with <paramref name="readers"/> and
    /// <paramref name="fileCache"/>.  Exactly one of <paramref name="login"/> or
    /// <paramref name="loginProvider"/> must be supplied:
    /// <list type="bullet">
    ///   <item><paramref name="login"/> — fixed string; provider always returns it.</item>
    ///   <item><paramref name="loginProvider"/> — delegate; lets tests flip the value mid-call
    ///     (test 17b cross-identity).</item>
    /// </list>
    /// </summary>
    public static ActivityProvider Provider(
        IIdentityKeyedFileCache<ActivityResponse> fileCache,
        SpyReaders readers,
        string? login = null,
        Func<string>? loginProvider = null,
        string host = "github.com")
    {
        var viewerLogin = new StubViewerLoginProvider(loginProvider ?? (() => login ?? string.Empty));
        return new ActivityProvider(
            readers.Events, readers.Notifs, readers.Watched, readers.Timeline,
            Clock(), ConfigWith(host), NullLogger<ActivityProvider>.Instance,
            fileCache, viewerLogin);
    }

    /// <summary>Builds a minimal <see cref="ActivityResponse"/> with one item for the given PR number.
    /// Use <c>with { Stale = true/false }</c> on the result to override the default <c>Stale = false</c>.</summary>
    public static ActivityResponse Response(int prNumber = 1)
    {
        var now = DateTimeOffset.UtcNow;
        return new ActivityResponse(
            Items: new[]
            {
                new ActivityItem(
                    ActorLogin: "octocat",
                    ActorAvatarUrl: "https://avatars.githubusercontent.com/u/1",
                    ActorIsBot: false,
                    Verb: ActivityVerb.Reviewed,
                    Repo: "octocat/hello",
                    PrNumber: prNumber,
                    Title: $"PR #{prNumber}",
                    Url: $"https://github.com/octocat/hello/pull/{prNumber}",
                    Timestamp: now,
                    Source: ActivitySource.ReceivedEvent)
            },
            GeneratedAt: now,
            Degraded: new ActivityDegradation(false, false, false),
            Watching: []);
    }

    // --- shared stub config store (provider only calls .Current) ---
    private sealed class StubConfigStore(AppConfig current) : IConfigStore
    {
        public AppConfig Current { get; } = current;
        public string ConfigPath => throw new NotSupportedException();
        public Exception? LastLoadError => null;
        public Task InitAsync(CancellationToken ct) => throw new NotSupportedException();
        public Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct) => throw new NotSupportedException();
        public Task SetDefaultAccountLoginAsync(string login, CancellationToken ct) => throw new NotSupportedException();
        public Task RecordAiConsentAsync(string providerId, string disclosureVersion, CancellationToken ct) => throw new NotSupportedException();
        public event EventHandler<ConfigChangedEventArgs>? Changed { add { } remove { } }
    }
}
