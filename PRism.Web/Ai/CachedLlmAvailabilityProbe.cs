using PRism.AI.ClaudeCode;
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
/// written cache. The cached value and its timestamp are held together in a single
/// immutable <see cref="CacheEntry"/> read through one reference load, so the lock-free
/// fast path can never observe a torn or mismatched (value, timestamp) pair — a reference
/// read is atomic on every runtime, whereas reading a multi-word <see cref="DateTimeOffset"/>
/// field unsynchronised could tear on weak-memory targets (e.g. arm64).
/// </para>
/// </summary>
internal sealed class CachedLlmAvailabilityProbe : ILlmAvailabilityProbe, IDisposable
{
    private sealed record CacheEntry(LlmAvailability Value, DateTimeOffset At);

    // Discovery-owned negatives: the ClaudeCliLocator owns their (sole) negative TTL. Re-caching them
    // here for a fresh TTL would compound into ~2× recovery latency after a mid-session install (spec §7).
    // PRism.Web already references PRism.AI.ClaudeCode (it calls AddPrismClaudeCode), so use the shared
    // constants rather than literals — a reason-code rename then stays a single edit.
    private static readonly HashSet<string> DiscoveryNegativeReasonCodes =
        new(StringComparer.Ordinal) { ClaudeReasonCodes.CliNotInstalled, ClaudeReasonCodes.CliDiscoveryFailed };

    private readonly ILlmAvailabilityProbe _inner;
    private readonly TimeProvider _clock;
    private readonly TimeSpan _ttl;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private CacheEntry? _entry;

    public CachedLlmAvailabilityProbe(ILlmAvailabilityProbe inner, TimeProvider clock, TimeSpan ttl)
    {
        _inner = inner;
        _clock = clock;
        _ttl = ttl;
    }

    public async Task<LlmAvailability> ProbeAsync(CancellationToken ct)
    {
        var now = _clock.GetUtcNow();
        var entry = _entry; // single atomic reference read — value and timestamp stay consistent
        if (entry is not null && now - entry.At < _ttl) return entry.Value;

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            // Double-check after acquiring the gate: another caller may have probed
            // while we were waiting, making the cache valid now.
            now = _clock.GetUtcNow();
            entry = _entry;
            if (entry is not null && now - entry.At < _ttl) return entry.Value;

            var result = await _inner.ProbeAsync(ct).ConfigureAwait(false);
            // Pass discovery-negatives straight through — do not extend them past the locator's TTL.
            // For all other results, stamp at probe COMPLETION, not the pre-await `now`: a multi-second
            // CLI probe would otherwise shorten the effective TTL by its own latency and raise the
            // subprocess spawn rate the cache exists to bound.
            if (!DiscoveryNegativeReasonCodes.Contains(result.ReasonCode))
                _entry = new CacheEntry(result, _clock.GetUtcNow());
            return result;
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Dispose() => _gate.Dispose();
}
