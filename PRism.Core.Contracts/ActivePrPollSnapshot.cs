namespace PRism.Core.Contracts;

public sealed record ActivePrPollSnapshot(
    string HeadSha,
    string BaseSha,
    string Mergeability,
    string PrState,
    int CommentCount,
    int ReviewCount);
