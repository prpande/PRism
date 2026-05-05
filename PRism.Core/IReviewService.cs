using System.Diagnostics.CodeAnalysis;

using PRism.Core.Contracts;

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

    // PR detail
    Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct);
    Task<PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct);
    Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct);
    Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct);
    Task<string> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct);

    // Submit (GraphQL pending-review pipeline)
    Task SubmitReviewAsync(PrReference reference, DraftReview review, CancellationToken ct);
}
