using System.Diagnostics.CodeAnalysis;

using PRism.Core.Contracts;
using PRism.Core.Iterations;

namespace PRism.Core;

public interface IReviewService
{
    // Auth
    Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct);

    // Discovery
    Task<InboxSection[]> GetInboxAsync(CancellationToken ct);

    [SuppressMessage("Design", "CA1054:URI-like parameters should not be strings",
        Justification = "URL is parsed by callers from user input; conversion to Uri is exactly what this method does.")]
    bool TryParsePrUrl(string url, out PrReference? reference);

    // PR detail (legacy S0+S1 surface — unused; retained for the S5 capability split per ADR-S5-1)
    Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct);
    Task<PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct);
    Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct);
    Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct);

    // PR detail (S3) — see spec § 6.1, plan Task 3.3
    Task<PrDetailDto?> GetPrDetailAsync(PrReference reference, CancellationToken ct);
    Task<DiffDto> GetDiffAsync(PrReference reference, DiffRangeRequest range, CancellationToken ct);
    Task<ClusteringInput> GetTimelineAsync(PrReference reference, CancellationToken ct);
    Task<FileContentResult> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct);
    Task<ActivePrPollSnapshot> PollActivePrAsync(PrReference reference, CancellationToken ct);

    // Submit (GraphQL pending-review pipeline)
    Task SubmitReviewAsync(PrReference reference, DraftReview review, CancellationToken ct);
}
