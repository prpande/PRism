using PRism.Core.Contracts;

namespace PRism.Core;

// GitHub PUT /pulls/{n}/merge merge_method values. Mapped to the wire strings at the writer.
public enum MergeMethod { Merge, Squash, Rebase }

// #566 — the GitHub PR lifecycle write surface (slice 1: the optionless state actions).
// Kept separate from IReviewSubmitter (lifecycle actions are not reviews) so the review
// fakes don't grow irrelevant methods. Slice 2 adds merge to this same seam; #571 mirrors
// the pattern on its own interface for thread resolve/unresolve.
public interface IPrLifecycleWriter
{
    // REST PATCH /repos/{o}/{r}/pulls/{n} { "state": "closed" }.
    Task<PrLifecycleResult> CloseAsync(PrReference reference, CancellationToken ct);

    // REST PATCH /repos/{o}/{r}/pulls/{n} { "state": "open" }. 422 (deleted head branch)
    // surfaces as ReopenNotPossible.
    Task<PrLifecycleResult> ReopenAsync(PrReference reference, CancellationToken ct);

    // GraphQL markPullRequestReadyForReview (node-id keyed). An "already ready" error is a
    // benign no-op (returns Ok).
    Task<PrLifecycleResult> MarkReadyForReviewAsync(PrReference reference, CancellationToken ct);

    // GraphQL convertPullRequestToDraft (node-id keyed). An "already a draft" error is a benign
    // no-op (returns Ok); a plan-without-drafts failure surfaces as PlanUnsupportedDrafts.
    Task<PrLifecycleResult> ConvertToDraftAsync(PrReference reference, CancellationToken ct);

    // REST PUT /repos/{o}/{r}/pulls/{n}/merge { merge_method, sha }. 405 → MergeNotMergeable
    // (not mergeable / method disallowed), 409 → MergeHeadChanged (head moved / conflict).
    // expectedHeadSha is the SHA the UI rendered; the endpoint guarantees it non-empty.
    Task<PrLifecycleResult> MergeAsync(
        PrReference reference, MergeMethod method, string? expectedHeadSha, CancellationToken ct);
}

// Why an error code (not an exception or a bare bool): the endpoint maps the cause to the right
// HTTP status + the FE maps it to actionable copy. See the spec's error-handling section.
public enum PrLifecycleErrorCode
{
    None,
    TokenCannotWrite,      // scope/permission denial OR non-collaborator (GitHub uses one body)
    RepoRuleBlocked,       // branch-protection / policy block — do NOT advise changing the PAT
    ReopenNotPossible,     // reopen 422 (head branch/repo deleted)
    PlanUnsupportedDrafts, // convert-to-draft on a plan without draft PRs
    RateLimited,           // secondary rate-limit / abuse — transient/retry, never token-cannot-write
    MergeNotMergeable,     // merge 405/422 — checks/protection/method changed; can't merge now
    MergeHeadChanged,      // merge 409 — head moved since load (stale sha) or merge conflict
    Generic,               // anything else
}

public sealed record PrLifecycleResult(bool Success, PrLifecycleErrorCode ErrorCode)
{
    public static PrLifecycleResult Ok { get; } = new(true, PrLifecycleErrorCode.None);
    public static PrLifecycleResult Fail(PrLifecycleErrorCode code) => new(false, code);
}
