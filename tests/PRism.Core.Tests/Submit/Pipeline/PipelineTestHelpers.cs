using PRism.Core.State;
using PRism.Core.Submit.Pipeline;

namespace PRism.Core.Tests.Submit.Pipeline;

// Shared fixtures for the SubmitPipeline unit tests.

internal sealed class NoopProgress : IProgress<SubmitProgressEvent>
{
    public static readonly NoopProgress Instance = new();
    public void Report(SubmitProgressEvent value) { }
}

// Captures every progress event the pipeline emits so a test can assert step ordering / skips.
internal sealed class RecordingProgress : IProgress<SubmitProgressEvent>
{
    private readonly List<SubmitProgressEvent> _events = new();
    public IReadOnlyList<SubmitProgressEvent> Events => _events;
    public void Report(SubmitProgressEvent value) => _events.Add(value);
}

internal static class SessionFactory
{
    // A bare session at a given head with no drafts / replies / summary / verdict and no pending review.
    public static ReviewSessionState Empty(string headSha = "head1") => new(
        TabStamps: new Dictionary<string, TabStamp> { ["tab-test"] = new TabStamp(headSha, DateTime.UtcNow.AddMinutes(-1)) },
        LastSeenCommentId: null,
        PendingReviewId: null,
        PendingReviewCommitOid: null,
        ViewedFiles: new Dictionary<string, string>(),
        DraftComments: new List<DraftComment>(),
        DraftReplies: new List<DraftReply>(),
        DraftVerdict: null,
        DraftVerdictStatus: DraftVerdictStatus.Draft);

    // V7 unification — the historic `summary` parameter materialises as a PR-root DraftComment
    // (FilePath / LineNumber both null). NOTE: this means the pipeline's AttachThreads step still
    // throws on PR-root drafts until Task 7 partitions; SubmitPipeline tests that pass a non-null
    // summary will surface that throw as `SubmitOutcome.Failed(AttachThreads, …)`. That breakage
    // is expected and is partitioned away in Task 7.
    public static ReviewSessionState With(
        string headSha = "head1",
        string? pendingReviewId = null,
        string? pendingReviewCommitOid = null,
        IEnumerable<DraftComment>? drafts = null,
        IEnumerable<DraftReply>? replies = null,
        string? summary = null,
        DraftVerdict? verdict = null)
    {
        var draftList = (drafts ?? Enumerable.Empty<DraftComment>()).ToList();
        if (!string.IsNullOrEmpty(summary))
        {
            draftList.Insert(0, new DraftComment(
                Id: "pr-root-seed",
                FilePath: null, LineNumber: null, Side: "pr",
                AnchoredSha: null, AnchoredLineContent: null,
                BodyMarkdown: summary,
                Status: DraftStatus.Draft, IsOverriddenStale: false));
        }
        return new(
            TabStamps: new Dictionary<string, TabStamp> { ["tab-test"] = new TabStamp(headSha, DateTime.UtcNow.AddMinutes(-1)) },
            LastSeenCommentId: null,
            PendingReviewId: pendingReviewId,
            PendingReviewCommitOid: pendingReviewCommitOid ?? (pendingReviewId is not null ? headSha : null),
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: draftList,
            DraftReplies: (replies ?? Enumerable.Empty<DraftReply>()).ToList(),
            DraftVerdict: verdict,
            DraftVerdictStatus: DraftVerdictStatus.Draft);
    }

    public static DraftComment Draft(string id, string? threadId = null, string filePath = "src/Foo.cs", int? lineNumber = 42, string side = "RIGHT", string body = "body")
        => new(id, filePath, lineNumber, side, AnchoredSha: "anchorsha", AnchoredLineContent: "line", BodyMarkdown: body, Status: DraftStatus.Draft, IsOverriddenStale: false, ThreadId: threadId);

    public static DraftReply Reply(string id, string parentThreadId, string? replyCommentId = null, string body = "reply", DraftStatus status = DraftStatus.Draft)
        => new(id, parentThreadId, replyCommentId, BodyMarkdown: body, Status: status, IsOverriddenStale: false);
}
