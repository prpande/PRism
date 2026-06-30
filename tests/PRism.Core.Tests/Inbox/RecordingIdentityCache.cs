using System.Collections.Concurrent;
using PRism.Core.Storage;

namespace PRism.Core.Tests.Inbox;

/// <summary>In-memory IIdentityKeyedFileCache that records every SaveAsync (payload + identity) and
/// serves the last saved payload from TryLoad, for orchestrator/activity write-path assertions.</summary>
public sealed class RecordingIdentityCache<T> : IIdentityKeyedFileCache<T> where T : class
{
    public ConcurrentQueue<(T Payload, CacheIdentity Identity)> Saves { get; } = new();
    public int EvictCount { get; private set; }
    private (T Payload, CacheIdentity Identity)? _last;
    private readonly Func<T, CacheIdentity>? _seed;

    /// <summary>Optional gate: when set, SaveAsync awaits it BEFORE recording, so a test can hold a
    /// write-through in flight (e.g. to land it after a Reset()/EvictAsync and assert the resurrection
    /// is undone). Null = complete synchronously.</summary>
    public Func<Task>? SaveDelay { get; set; }

    /// <summary>Invoked at the end of every EvictAsync (after EvictCount is bumped), so a test can
    /// signal on the Nth evict — e.g. the continuation-driven re-evict after a resurrected write.</summary>
    public Action? OnEvict { get; set; }

    public RecordingIdentityCache(Func<T, CacheIdentity>? seed = null) => _seed = seed;

    public async Task SaveAsync(T payload, CacheIdentity identity, CancellationToken ct)
    {
        if (SaveDelay is { } delay) await delay().ConfigureAwait(false);
        Saves.Enqueue((payload, identity));
        _last = (payload, identity);
    }

    public T? TryLoad(CacheIdentity identity) =>
        _last is { } v && v.Identity.Login.Equals(identity.Login, StringComparison.OrdinalIgnoreCase)
            && v.Identity.Host.Equals(identity.Host, StringComparison.OrdinalIgnoreCase)
            ? v.Payload : null;

    public Task EvictAsync(CancellationToken ct) { EvictCount++; _last = null; OnEvict?.Invoke(); return Task.CompletedTask; }
}

/// <summary>
/// A <see cref="Func{String}"/> whose first invocation returns <see cref="Value"/> then runs
/// <see cref="OnNextRead"/> to flip the backing value, so subsequent calls return the new value.
/// Used in test 13 to prove the cache write closes over the fetch-time login, not a later read.
/// </summary>
public sealed class MutableLogin
{
    public string Value { get; set; }
    public Action? OnNextRead { get; set; }

    public MutableLogin(string initial) => Value = initial;

    public string Get()
    {
        var current = Value;
        var action = OnNextRead;
        OnNextRead = null; // consume once
        action?.Invoke();
        return current;
    }
}
