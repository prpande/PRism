namespace PRism.Core.Contracts;

public sealed record ActivePrPollSnapshot(
    string HeadSha,
    string BaseSha,
    string Mergeability,
    PrState PrState,
    int CommentCount,
    int ReviewCount,
    // Populated by the batched active-PR poll path (GitHubActivePrBatchReader), which reads
    // reviewDecision/mergeStateStatus from GraphQL. The single-PR REST PollActivePrAsync leaves
    // this None: REST /pulls/{n} has no reviewDecision, and that method's 3 non-poller callers
    // consume only HeadSha. Trailing-with-defaults so the REST path + existing tests still compile.
    MergeReadiness MergeReadiness = MergeReadiness.None,
    int? Approvals = null,
    int? ChangesRequested = null,
    // #593 reviewer name-lists, parsed from the active-poll latestReviews + reviewRequests so the
    // detail readiness popover's people section updates live (parallel to Approvals/ChangesRequested).
    IReadOnlyList<Reviewer>? Approvers = null,
    IReadOnlyList<Reviewer>? ChangesRequestedBy = null,
    IReadOnlyList<Reviewer>? AwaitingReviewers = null,
    // #655 surfaced from GraphQL isDraft so later tasks can skip fast-polling draft PRs.
    bool IsDraft = false,
    // Root PR issue-comment total (comments{ totalCount }). Distinct from CommentCount, which is the
    // per-inline-review-comment count. Drives root-comment live-refresh (#620). REST path leaves it 0.
    int IssueCommentCount = 0);
