using PRism.Core.Contracts;

namespace PRism.Core.PrDetail;

// Interface in Core (the poller consumes it; Core cannot reference PRism.GitHub). Mirrors the
// IPrBatchReader (Core) / GitHubPrBatchReader (GitHub) split. The implementation
// (GitHubActivePrBatchReader) lives in PRism.GitHub/ActivePr/. ONE aliased GraphQL query
// hydrates merge-readiness + counts for every subscribed PR per tick, replacing the active
// poll's N x 3 REST round-trips.
public interface IActivePrBatchReader
{
    Task<IReadOnlyDictionary<PrReference, ActivePrPollSnapshot>> PollBatchAsync(
        IReadOnlyList<PrReference> refs, CancellationToken ct);
}
