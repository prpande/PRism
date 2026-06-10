using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

/// <summary>Result of a CI probe sweep over a set of live PRs.</summary>
/// <param name="Items">Each input PR annotated with its <see cref="CiStatus"/>.</param>
/// <param name="Complete">
/// False when at least one probe degraded this sweep (a non-2xx read such as a
/// fine-grained-PAT 403 on the Checks API or a transient 5xx). A degraded probe
/// yields <see cref="CiStatus.None"/> (unknown/unprobed — distinct from the
/// explicit <see cref="CiStatus.Passing"/>); callers use Complete=false to signal
/// that CI-based filters may under-match this sweep.
/// </param>
public readonly record struct CiDetectResult(
    IReadOnlyList<(RawPrInboxItem Item, CiStatus Ci)> Items,
    bool Complete);

public interface ICiFailingDetector
{
    /// <summary>
    /// Probes Checks API + legacy combined-status for each input PR and annotates it
    /// with its <see cref="CiStatus"/>. Caches by (ref, headSha); degraded reads are
    /// not cached (re-probed next sweep). Throws <see cref="RateLimitExceededException"/>
    /// on 429 so the orchestrator can back off. Scope-agnostic: the caller decides
    /// which PRs to probe.
    /// </summary>
    Task<CiDetectResult> DetectAsync(
        IReadOnlyList<RawPrInboxItem> items,
        CancellationToken ct);
}
