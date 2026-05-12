using System.Collections.Concurrent;

using PRism.Core.Contracts;

namespace PRism.Web.Submit;

/// <summary>
/// Per-PR submit lock. Each PR ref gets its own <see cref="SemaphoreSlim"/>(1, 1); concurrent
/// submit attempts on the same PR get back <c>null</c> (the endpoint surfaces 409 submit-in-progress).
///
/// Separate primitive from <c>AppStateStore._gate</c> by design (spec § 7.1). Putting submit
/// serialization on <c>_gate</c> would block every other PR's draft writes for the duration of any
/// one PR's submit (10–30s), and re-introduce the publication-vs-<c>_gate</c> ordering hazard the
/// SubmitPipeline's step-5 contract defends against. Registered as a DI singleton.
/// </summary>
internal sealed class SubmitLockRegistry
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new(StringComparer.Ordinal);

    public async Task<SubmitLockHandle?> TryAcquireAsync(PrReference reference, TimeSpan timeout, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        var key = reference.ToString();
        var sem = _locks.GetOrAdd(key, static _ => new SemaphoreSlim(1, 1));

        var acquired = await sem.WaitAsync(timeout, ct).ConfigureAwait(false);
        return acquired ? new SubmitLockHandle(sem) : null;
    }
}

/// <summary>
/// Disposable handle returned by <see cref="SubmitLockRegistry.TryAcquireAsync"/>. Releasing it
/// (via <c>await using</c> or an explicit <see cref="DisposeAsync"/>) frees the per-PR lock. Idempotent.
/// </summary>
internal sealed class SubmitLockHandle : IAsyncDisposable
{
    private readonly SemaphoreSlim _sem;
    private int _disposed;

    internal SubmitLockHandle(SemaphoreSlim sem) => _sem = sem;

    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
            _sem.Release();
        return ValueTask.CompletedTask;
    }
}
