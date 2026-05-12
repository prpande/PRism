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
///
/// Entries are never evicted: the dictionary holds one tiny <see cref="SemaphoreSlim"/> per
/// distinct PR ref a submit has ever been attempted on, for the host process's lifetime. That is
/// acceptable here — PRism is a single-user local tool and a session reviews a handful of PRs at
/// most, so the set is bounded by realistic usage (mirrors the existing "explicit cap, no eviction"
/// stance the per-PR poller / subscriber registry take). A timestamped-entry + periodic-sweep
/// eviction would be the move if a long-lived multi-user variant ever lands; it is not worth the
/// machinery for the PoC.
/// </summary>
internal sealed class SubmitLockRegistry
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new(StringComparer.Ordinal);

    public async Task<SubmitLockHandle?> TryAcquireAsync(PrReference reference, TimeSpan timeout, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        var key = reference.ToString();
        // GetOrAdd may evaluate the factory on each of N racing first-callers and keep only one
        // result; the discarded SemaphoreSlim(s) hold no unmanaged resource (ManualResetEventSlim's
        // finalizer covers it) and are GC'd — no OS-handle leak. The race is vanishingly rare and
        // inconsequential for a single-user PoC; noted so a future reviewer doesn't flag it.
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
