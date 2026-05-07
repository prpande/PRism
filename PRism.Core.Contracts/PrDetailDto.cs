namespace PRism.Core.Contracts;

public sealed record PrDetailDto(
    Pr Pr,
    ClusteringQuality ClusteringQuality,
    IReadOnlyList<IterationDto>? Iterations,
    IReadOnlyList<CommitDto> Commits,
    IReadOnlyList<IssueCommentDto> RootComments,
    IReadOnlyList<ReviewThreadDto> ReviewComments,
    bool TimelineCapHit);
