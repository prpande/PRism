using PRism.Core.Contracts;
using PRism.Core.Iterations;

namespace PRism.Core;

// Capability sub-interface from the ADR-S5-1 split of IReviewService.
// See docs/specs/2026-05-11-s5-submit-pipeline-design.md § 3.
public interface IPrReader
{
    // Legacy S0+S1 surface — unused; retained for the capability split.
    Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct);
    Task<PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct);
    Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct);
    Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct);

    // PR detail (S3) — see spec § 6.1.
    Task<PrDetailDto?> GetPrDetailAsync(PrReference reference, CancellationToken ct);
    Task<DiffDto> GetDiffAsync(PrReference reference, DiffRangeRequest range, CancellationToken ct);
    Task<ClusteringInput> GetTimelineAsync(PrReference reference, CancellationToken ct);
    Task<FileContentResult> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct);
    Task<ActivePrPollSnapshot> PollActivePrAsync(PrReference reference, CancellationToken ct);

    // S4 PR3 force-push fallback. Returns null if commit is unreachable from the repo (404);
    // throws on transport errors. Used by ReviewServiceFileContentSource.IsCommitReachableAsync.
    Task<CommitInfo?> GetCommitAsync(PrReference reference, string sha, CancellationToken ct);
}
