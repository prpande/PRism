namespace PRism.Core.State;

public sealed record AppState(
    int Version,
    IReadOnlyDictionary<string, ReviewSessionState> ReviewSessions,
    AiState AiState,
    string? LastConfiguredGithubHost)
{
    public static AppState Default { get; } = new(
        Version: 1,
        ReviewSessions: new Dictionary<string, ReviewSessionState>(),
        AiState: new AiState(new Dictionary<string, RepoCloneEntry>(), null),
        LastConfiguredGithubHost: null);
}

public sealed record ReviewSessionState(
    string? LastViewedHeadSha,
    string? LastSeenCommentId,
    string? PendingReviewId,
    string? PendingReviewCommitOid);

public sealed record AiState(
    IReadOnlyDictionary<string, RepoCloneEntry> RepoCloneMap,
    DateTime? WorkspaceMtimeAtLastEnumeration);

public sealed record RepoCloneEntry(string Path, string Ownership);
