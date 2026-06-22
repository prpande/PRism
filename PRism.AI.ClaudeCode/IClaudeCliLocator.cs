namespace PRism.AI.ClaudeCode;

/// <summary>
/// Resolves the `claude` CLI to a launchable <see cref="ResolvedCli"/> (or a <see cref="NotFound"/>).
/// Discover-once-persist-reuse with self-heal (spec §6); single-flighted + memoized. On Windows it is
/// an exact no-op returning the inherited bare-name invocation.
/// </summary>
public interface IClaudeCliLocator
{
    /// <summary>Resolve, running discovery at most once per cold state. Memoized: a positive result
    /// is sticky until <see cref="InvalidateResolved"/>; a negative result is in-memory TTL only.</summary>
    Task<ClaudeCliResolution> ResolveAsync(CancellationToken ct);

    /// <summary>The last positive resolution, or <c>null</c> if none yet. A NON-BLOCKING snapshot for
    /// the synchronous streaming provider, which cannot await (spec §3.2).</summary>
    ClaudeCliResolution? CurrentResolved { get; }

    /// <summary>Self-heal seam (spec §6): a spawn site that hit an executable-not-found signature
    /// under the resolved env calls this so the next <see cref="ResolveAsync"/> re-discovers.</summary>
    void InvalidateResolved();
}
