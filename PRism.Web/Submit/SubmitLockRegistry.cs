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
///
/// S6 PR1: the <see cref="AnyHeld"/> probe is backed by a separate held-set
/// (<see cref="_heldLocks"/>) rather than the never-evicting <see cref="_locks"/> dictionary.
/// Reading <c>_locks.Any()</c> would report "held" forever after the first acquire because
/// entries persist for the host's lifetime; the held-set tracks the currently-held subset so
/// <see cref="AnyHeld"/> reflects actual in-flight submits. Note: the held-set is updated
/// AFTER the semaphore is acquired, so there is a microsecond window in which the lock is held
/// but the held-set is empty (an AnyHeld false negative). This is acceptable for the PoC's
/// single-user model — the legitimate caller (Settings page + Replace-token flow) polls AnyHeld
/// from the UI thread, not from inside the submit pipeline itself. The release direction is the
/// one that previously broke (entries never evicted from <c>_locks</c>) and is what this design
/// fixes. See spec § 3.5 for the design rationale.
/// </summary>
internal sealed class SubmitLockRegistry
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _heldLocks = new(StringComparer.Ordinal);

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
        if (!acquired) return null;

        _heldLocks[key] = 0;
        return new SubmitLockHandle(sem, key, _heldLocks);
    }

    // Best-effort "is any submit lock currently held?" probe (spec § 3.5). NOT a hard
    // TOCTOU guarantee — readers can race against in-flight acquire (held-set written
    // AFTER WaitAsync returns → microsecond false-negative window) and against dispose
    // (held-set TryRemove → concurrent reader may see the key disappear). Acceptable
    // for the UI-thread caller (Settings page + Replace-token flow). For the design
    // rationale + race-window discussion, see the class-level XML doc above.
    // Returns the first observed held key (ConcurrentDictionary enumeration order is
    // unspecified — callers must not depend on which key surfaces when more than one
    // is held; the value is for forensic / UI display only).
    public (bool Held, string? PrRef) AnyHeld()
    {
        foreach (var key in _heldLocks.Keys)
        {
            return (true, key);
        }
        return (false, null);
    }
}

/// <summary>
/// Disposable handle returned by <see cref="SubmitLockRegistry.TryAcquireAsync"/>. Releasing it
/// (via <c>await using</c> or an explicit <see cref="DisposeAsync"/>) frees the per-PR lock AND
/// removes the entry from the registry's held-set so <see cref="SubmitLockRegistry.AnyHeld"/>
/// reflects the release. Idempotent.
/// </summary>
internal sealed class SubmitLockHandle : IAsyncDisposable
{
    private readonly SemaphoreSlim _sem;
    private readonly string _prRefKey;
    private readonly ConcurrentDictionary<string, byte> _heldLocks;
    private int _disposed;

    internal SubmitLockHandle(
        SemaphoreSlim sem,
        string prRefKey,
        ConcurrentDictionary<string, byte> heldLocks)
    {
        _sem = sem;
        _prRefKey = prRefKey;
        _heldLocks = heldLocks;
    }

    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            _heldLocks.TryRemove(_prRefKey, out _);
            _sem.Release();
        }
        return ValueTask.CompletedTask;
    }
}
