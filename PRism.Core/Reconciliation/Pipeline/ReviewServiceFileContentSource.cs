using PRism.Core.Contracts;

namespace PRism.Core.Reconciliation.Pipeline;

// Production IFileContentSource adapter — fetches file content + commit reachability via
// IReviewService for the reconciliation pipeline (S4 PR3 Task 28). The PrReference is
// captured at construction so the caller (POST /api/pr/{ref}/reload) can scope a single
// instance to a single PR's reconcile pass.
//
// FileContentResult → string? mapping decisions:
//   - Ok        → content (the matcher gets real text)
//   - NotFound  → null (caller treats as FileDeleted per IFileContentSource contract)
//   - TooLarge  → null (unreconcileable; matcher falls through to NoMatch / Stale)
//   - Binary    → null (same — can't do line-content match on binary)
//   - NotInDiff → throw (programmer error: FileResolution should have rejected this)
//
// Future enhancement: add distinct StaleReason variants for FileBinary / FileTooLarge so
// the reconciliation panel can surface a more specific message ("file too large to
// reconcile — re-anchor manually"). Out of scope for S4.
public sealed class ReviewServiceFileContentSource : IFileContentSource
{
    private readonly IReviewService _inner;
    private readonly PrReference _pr;

    public ReviewServiceFileContentSource(IReviewService inner, PrReference pr)
    {
        ArgumentNullException.ThrowIfNull(inner);
        ArgumentNullException.ThrowIfNull(pr);
        _inner = inner;
        _pr = pr;
    }

    public async Task<string?> GetAsync(string filePath, string sha, CancellationToken ct)
    {
        var result = await _inner.GetFileContentAsync(_pr, filePath, sha, ct).ConfigureAwait(false);
        return result.Status switch
        {
            FileContentStatus.Ok => result.Content,
            FileContentStatus.NotFound => null,
            FileContentStatus.TooLarge => null,
            FileContentStatus.Binary => null,
            FileContentStatus.NotInDiff =>
                throw new InvalidOperationException(
                    $"Reconciliation pipeline requested file '{filePath}' at SHA '{sha}' that is not in the PR diff. " +
                    "FileResolution step should reject this earlier — this is a bug in the pipeline."),
            _ => null
        };
    }

    public async Task<bool> IsCommitReachableAsync(string sha, CancellationToken ct)
    {
        var commit = await _inner.GetCommitAsync(_pr, sha, ct).ConfigureAwait(false);
        return commit is not null;
    }
}
