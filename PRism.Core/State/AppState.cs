using System.Collections.Immutable;

namespace PRism.Core.State;

public sealed record AppState(
    int Version,
    UiPreferences UiPreferences,
    ImmutableDictionary<string, AccountState> Accounts)
{
    // Read delegate properties — preserved to keep call sites compiling unchanged across
    // the V4→V5 reshape. v2 will remove these when interfaces gain accountKey; until then
    // they are part of the public API (see spec § 11 + the deferrals sidecar entry "delegate
    // properties stay public").
    //
    // NB: deliberately NOT marked [Obsolete] in v1 (spec § 11, plan-time decision 3). There is
    // nothing for callers to migrate to until v2 ships the parameterized interface changes, so
    // [Obsolete] would flood the build with warnings at zero benefit (the solution enables
    // TreatWarningsAsErrors). v2's PR that introduces the parameterized replacements applies
    // [Obsolete] in the same change so consumers see deprecation + migration target together.
    public PrSessionsState Reviews => Accounts[AccountKeys.Default].Reviews;
    public AiState AiState => Accounts[AccountKeys.Default].AiState;
    public string? LastConfiguredGithubHost => Accounts[AccountKeys.Default].LastConfiguredGithubHost;

    // Write helpers — replace `state with { Reviews = ... }` patterns. Each helper rebuilds
    // the AccountState entry under AccountKeys.Default and writes it back via
    // ImmutableDictionary.SetItem. The other account-state fields and top-level fields are
    // preserved by record `with` semantics.
    public AppState WithDefaultReviews(PrSessionsState newReviews) =>
        this with { Accounts = Accounts.SetItem(AccountKeys.Default,
            Accounts[AccountKeys.Default] with { Reviews = newReviews }) };

    public AppState WithDefaultAiState(AiState newAiState) =>
        this with { Accounts = Accounts.SetItem(AccountKeys.Default,
            Accounts[AccountKeys.Default] with { AiState = newAiState }) };

    public AppState WithDefaultLastConfiguredGithubHost(string? newHost) =>
        this with { Accounts = Accounts.SetItem(AccountKeys.Default,
            Accounts[AccountKeys.Default] with { LastConfiguredGithubHost = newHost }) };

    public static AppState Default { get; } = new(
        Version: 5,
        UiPreferences: UiPreferences.Default,
        Accounts: ImmutableDictionary<string, AccountState>.Empty
            .Add(AccountKeys.Default, AccountState.Default));
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
    bool IsOverriddenStale,
    string? ThreadId = null);  // S5 v4 — stamped by SubmitPipeline.AttachThreads (trailing default
                               // matches DraftThreadRequest's reserved-field pattern; pre-v4 entries
                               // and every non-pipeline call site leave it null)

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
