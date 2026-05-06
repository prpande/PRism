using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

public sealed record RawPrInboxItem(
    PrReference Reference,
    string Title,
    string Author,
    string Repo,
    DateTimeOffset UpdatedAt,
    DateTimeOffset PushedAt,
    int CommentCount,
    int Additions,
    int Deletions,
    string HeadSha,
    int IterationNumberApprox);
