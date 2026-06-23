namespace PRism.Core.Inbox;

/// <summary>
/// The awaiting-author inclusion predicate, extracted as a pure function so it is unit-testable
/// independent of the GraphQL reader. A PR is "awaiting author" (from the viewer's seat) when the
/// viewer has reviewed at an earlier head than the PR's current head. A null last-review SHA (the
/// viewer never left a review with a comparable commit) means "not awaiting".
/// </summary>
public static class AwaitingAuthorRule
{
    public static bool IsAwaitingAuthor(string? viewerLastReviewSha, string headSha)
        => viewerLastReviewSha is { } sha && sha != headSha;
}
