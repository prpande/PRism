namespace PRism.Core.Contracts;

public sealed record PrInboxItem(
    PrReference Reference,
    string Title,
    string Author,
    string Repo,
    DateTime UpdatedAt);
