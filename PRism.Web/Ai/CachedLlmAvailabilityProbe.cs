using PRism.AI.Contracts.Provider;

namespace PRism.Web.Ai;

/// <summary>
/// Caches the inner availability probe result for a short TTL (KTD-6).
/// Live mode is FE-reachable this slice and <c>useCapabilities</c> refetches on every
/// window focus, so an uncached ~10 s probe would spawn a claude subprocess per focus.
/// Availability rarely changes within a session; a ~30 s memo bounds the spawn rate.
/// <para>
/// Thread-safety: a <see cref="SemaphoreSlim"/>(1,1) prevents concurrent callers from
/// each firing a real probe when the cache is cold; the double-check after acquiring the
/// gate means only the first caller probes while the rest wait and then read the freshly
/// written cache.
/// </para>
/// </summary>
internal sealed class CachedLlmAvailabilityProbe : ILlmAvailabilityProbe, IDisposable
{
    private readonly ILlmAvailabilityProbe _inner;
    private readonly TimeProvider _clock;
    private readonly TimeSpan _ttl;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private LlmAvailability? _cached;
    private DateTimeOffset _cachedAt;

    public CachedLlmAvailabilityProbe(ILlmAvailabilityProbe inner, TimeProvider clock, TimeSpan ttl)
    {
        _inner = inner;
        _clock = clock;
        _ttl = ttl;
    }

    public async Task<LlmAvailability> ProbeAsync(CancellationToken ct)
    {
        var now = _clock.GetUtcNow();
        if (_cached is not null && now - _cachedAt < _ttl) return _cached;

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            // Double-check after acquiring the gate: another caller may have probed
            // while we were waiting, making the cache valid now.
            now = _clock.GetUtcNow();
            if (_cached is not null && now - _cachedAt < _ttl) return _cached;

            var result = await _inner.ProbeAsync(ct).ConfigureAwait(false);
            _cached = result;
            _cachedAt = now;
            return result;
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Dispose() => _gate.Dispose();
}
