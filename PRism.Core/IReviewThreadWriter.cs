using PRism.Core.Contracts;

namespace PRism.Core;

// #571 — the GitHub review-thread resolution write surface. Sibling of IPrLifecycleWriter
// (kept separate per that interface's own header note). GraphQL-only: resolveReviewThread /
// unresolveReviewThread, keyed by the opaque thread node id. Methods take PrReference so the
// endpoint can bind the thread to its PR (spec §5.4) before the mutation.
public interface IReviewThreadWriter
{
    Task<ReviewThreadResult> ResolveAsync(PrReference reference, string threadId, CancellationToken ct);
    Task<ReviewThreadResult> UnresolveAsync(PrReference reference, string threadId, CancellationToken ct);
}

public enum ReviewThreadErrorCode
{
    None,
    TokenCannotWrite, // scope/permission denial OR non-collaborator (GitHub uses one body)
    ThreadNotFound,   // "Could not resolve to a node" — stale/foreign thread id
    RateLimited,      // secondary/primary rate-limit — transient, never token-cannot-write
    Generic,          // anything else
}

public sealed record ReviewThreadResult(bool Success, ReviewThreadErrorCode ErrorCode)
{
    public static ReviewThreadResult Ok { get; } = new(true, ReviewThreadErrorCode.None);
    public static ReviewThreadResult Fail(ReviewThreadErrorCode code) => new(false, code);
}
