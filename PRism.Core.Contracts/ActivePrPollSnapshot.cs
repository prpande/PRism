namespace PRism.Core.Contracts;

public sealed record ActivePrPollSnapshot(
    string HeadSha,
    string Mergeability,
    string PrState,
    int CommentCount,
    int ReviewCount);
