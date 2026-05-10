namespace PRism.Core.State;

public sealed record AppState(
    int Version,
    PrSessionsState Reviews,
    AiState AiState,
    string? LastConfiguredGithubHost,
    UiPreferences UiPreferences)
{
    public static AppState Default { get; } = new(
        Version: 3,
        Reviews: PrSessionsState.Empty,
        AiState: new AiState(new Dictionary<string, RepoCloneEntry>(), null),
        LastConfiguredGithubHost: null,
        UiPreferences: UiPreferences.Default);
}

public sealed record ReviewSessionState(
    string? LastViewedHeadSha,
    string? LastSeenCommentId,
    string? PendingReviewId,
    string? PendingReviewCommitOid,
    IReadOnlyDictionary<string, string> ViewedFiles,
    IReadOnlyList<DraftComment> DraftComments,
    IReadOnlyList<DraftReply> DraftReplies,
    string? DraftSummaryMarkdown,
    DraftVerdict? DraftVerdict,
    DraftVerdictStatus DraftVerdictStatus);

public sealed record DraftComment(
    string Id,
    string? FilePath,
    int? LineNumber,
    string? Side,
    string? AnchoredSha,
    string? AnchoredLineContent,
    string BodyMarkdown,
    DraftStatus Status,
    bool IsOverriddenStale);

public sealed record DraftReply(
    string Id,
    string ParentThreadId,
    string? ReplyCommentId,
    string BodyMarkdown,
    DraftStatus Status,
    bool IsOverriddenStale);

public enum DraftVerdict { Approve, RequestChanges, Comment }
public enum DraftVerdictStatus { Draft, NeedsReconfirm }
public enum DraftStatus { Draft, Moved, Stale }

public sealed record AiState(
    IReadOnlyDictionary<string, RepoCloneEntry> RepoCloneMap,
    DateTime? WorkspaceMtimeAtLastEnumeration);

public sealed record RepoCloneEntry(string Path, string Ownership);
