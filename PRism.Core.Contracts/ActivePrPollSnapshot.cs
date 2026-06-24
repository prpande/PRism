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
    int? ChangesRequested = null);
