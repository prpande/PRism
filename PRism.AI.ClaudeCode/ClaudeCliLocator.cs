namespace PRism.AI.ClaudeCode;

/// <summary>
/// Owns CLI resolution + persistence + self-heal (spec §§3–7). Single-flighted by a
/// <see cref="SemaphoreSlim"/>(1,1) with double-check (mirrors <c>CachedLlmAvailabilityProbe</c>) so
/// the eager Live-entry trigger and any concurrent probe never spawn N login shells.
/// </summary>
public sealed class ClaudeCliLocator : IClaudeCliLocator, IDisposable
{
    private readonly ILoginShellEnvironmentReader _reader;
    private readonly JsonClaudeCliStateStore _store;
    private readonly ICliProcessRunner _runner;
    private readonly ClaudeCodeProviderOptions _options;
    private readonly Func<bool> _identityMatches;
    private readonly TimeProvider _clock;
    private readonly Func<string, bool> _pathExists;
    private readonly SemaphoreSlim _gate = new(1, 1);

    // value + timestamp wrapped in ONE immutable record so the lock-free fast-path read is a single
    // reference load — never a torn multi-word struct read on weak-memory targets (macOS is arm64).
    // This mirrors CachedLlmAvailabilityProbe.CacheEntry, whose comment documents exactly this hazard.
    private sealed record NegativeEntry(NotFound Value, DateTimeOffset At);

    private ResolvedCli? _resolved;                       // sticky positive snapshot (reference read = atomic)
    private NegativeEntry? _negative;                     // in-memory TTL only (single ref read = tear-free)

    public ClaudeCliLocator(
        ILoginShellEnvironmentReader reader,
        JsonClaudeCliStateStore store,
        ICliProcessRunner runner,
        ClaudeCodeProviderOptions options,
        Func<bool> identityMatches,
        TimeProvider clock,
        Func<string, bool>? pathExists = null)
    {
        _reader = reader;
        _store = store;
        _runner = runner;
        _options = options;
        _identityMatches = identityMatches;
        _clock = clock;
        // Test seam ONLY (defaults to File.Exists) — lets the locator tests drive candidate/ladder
        // existence without touching the filesystem. Not an extension point; DI never sets it.
        _pathExists = pathExists ?? File.Exists;
    }

    public ClaudeCliResolution? CurrentResolved => _resolved;

    public void InvalidateResolved()
    {
        // Discard the sticky positive AND the persisted record so warm reuse cannot re-serve a path
        // whose binary no longer launches (spec §6: "discard the record and re-discover"). Deleting
        // the disk record is what breaks the warm-reuse → spawn-fail → invalidate loop for a
        // present-but-broken install (e.g. an npm shim whose `node` was removed): without it, every
        // request reloads the same dead record from disk. Leave _negative intact — invalidation only
        // ever follows a POSITIVE resolve (an exec-not-found can only come from a spawn we resolved),
        // so clearing the negative here would only remove the backoff that throttles re-discovery.
        _resolved = null;
        _store.Delete();
    }

    public async Task<ClaudeCliResolution> ResolveAsync(CancellationToken ct)
    {
        // Identity is cheap and runs on EVERY call (warm + cold), never cached (spec §6).
        if (!_identityMatches()) return new NotFound(ClaudeReasonCodes.IdentityMismatch);

        // Lock-free fast paths.
        var resolved = _resolved;
        if (resolved is not null) return resolved;
        var neg = _negative;
        if (neg is not null && _clock.GetUtcNow() - neg.At < _options.NegativeTtl) return neg.Value;

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            // Double-check after acquiring the gate.
            resolved = _resolved;
            if (resolved is not null) return resolved;
            neg = _negative;
            if (neg is not null && _clock.GetUtcNow() - neg.At < _options.NegativeTtl) return neg.Value;

            // Windows: exact no-op — inherited bare-name invocation, no discovery, no persistence.
            if (OperatingSystem.IsWindows())
            {
                var windows = new ResolvedCli(_options.ClaudeExecutable, ClaudeCliEnvironment.BuildAllowlisted());
                _resolved = windows;
                return windows;
            }

            var result = await ResolveUnixAsync(ct).ConfigureAwait(false);
            if (result is ResolvedCli ok)
            {
                _resolved = ok;
                _negative = null;
                return ok;
            }

            var notFound = (NotFound)result;
            _negative = new NegativeEntry(notFound, _clock.GetUtcNow());
            return notFound;
        }
        finally
        {
            _gate.Release();
        }
    }

    // Filled in by Tasks 6 (cold discovery + ladder) and 7 (warm reuse + self-heal). For now the
    // shell has no Unix resolution path.
    private static Task<ClaudeCliResolution> ResolveUnixAsync(CancellationToken ct) =>
        Task.FromResult<ClaudeCliResolution>(new NotFound(ClaudeReasonCodes.CliDiscoveryFailed));

    public void Dispose() => _gate.Dispose();
}
