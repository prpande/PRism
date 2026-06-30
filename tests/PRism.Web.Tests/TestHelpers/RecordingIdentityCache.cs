using PRism.Core.Storage;

namespace PRism.Web.Tests.TestHelpers;

/// <summary>
/// Minimal IIdentityKeyedFileCache recording stub for use in PRism.Web.Tests (this project does
/// not reference PRism.Core.Tests, so it cannot use the one in that assembly). Tracks EvictAsync
/// call counts only; Save/TryLoad are no-ops because the auth-eviction tests only assert eviction.
/// </summary>
internal sealed class RecordingIdentityCache<T> : IIdentityKeyedFileCache<T> where T : class
{
    private int _evictCount;

    /// <summary>Number of times EvictAsync has been called.</summary>
    public int EvictCount => Volatile.Read(ref _evictCount);

    public Task SaveAsync(T payload, CacheIdentity identity, CancellationToken ct) =>
        Task.CompletedTask;

    public T? TryLoad(CacheIdentity identity) => null;

    public Task EvictAsync(CancellationToken ct)
    {
        Interlocked.Increment(ref _evictCount);
        return Task.CompletedTask;
    }
}
