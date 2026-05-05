namespace PRism.Core.Contracts;

public sealed record Pr(
    PrReference Reference,
    string Title,
    string Author,
    string State,
    string HeadSha);
