using System.Diagnostics.CodeAnalysis;

using PRism.Core.State;

namespace PRism.Core.Submit.Pipeline;

// The terminal result of a SubmitPipeline.SubmitAsync run (spec § 5.1). Four variants:
//  - Success: the pending review was finalized; carries its GraphQL node id.
//  - Failed: a step threw; carries the failed step, a message, and the session-at-failure
//    (already overlay-persisted by the pipeline — surfaced here for the endpoint's bus events).
//  - ForeignPendingReviewPromptRequired: a pending review exists on the PR that isn't ours;
//    the endpoint surfaces the foreign-pending-review modal (TOCTOU defense is endpoint-side).
//  - StaleCommitOidRecreating: our pending review's commitOID no longer matches head; the orphan
//    was deleted and the session's pending state cleared — the user re-confirms and re-runs.
[SuppressMessage("Design", "CA1034:Nested types should not be visible",
    Justification = "Closed result hierarchy: the four variants are intentionally namespaced under " +
                    "SubmitOutcome (SubmitOutcome.Success / .Failed / .ForeignPendingReviewPromptRequired / " +
                    ".StaleCommitOidRecreating) — the canonical discriminated-union shape per spec § 5.1. " +
                    "Promoting them to top-level types would lose the union name from every call site.")]
public abstract record SubmitOutcome
{
    public sealed record Success(string PullRequestReviewId) : SubmitOutcome;
    public sealed record Failed(SubmitStep FailedStep, string ErrorMessage, ReviewSessionState NewSession) : SubmitOutcome;
    public sealed record ForeignPendingReviewPromptRequired(OwnPendingReviewSnapshot Snapshot) : SubmitOutcome;
    public sealed record StaleCommitOidRecreating(string OrphanReviewId, string OrphanCommitOid) : SubmitOutcome;
}
