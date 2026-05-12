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
        LastViewedHeadSha: headSha,
        LastSeenCommentId: null,
        PendingReviewId: null,
        PendingReviewCommitOid: null,
        ViewedFiles: new Dictionary<string, string>(),
        DraftComments: new List<DraftComment>(),
        DraftReplies: new List<DraftReply>(),
        DraftSummaryMarkdown: null,
        DraftVerdict: null,
        DraftVerdictStatus: DraftVerdictStatus.Draft);

    public static ReviewSessionState With(
        string headSha = "head1",
        string? pendingReviewId = null,
        string? pendingReviewCommitOid = null,
        IEnumerable<DraftComment>? drafts = null,
        IEnumerable<DraftReply>? replies = null,
        string? summary = null,
        DraftVerdict? verdict = null) => new(
            LastViewedHeadSha: headSha,
            LastSeenCommentId: null,
            PendingReviewId: pendingReviewId,
            PendingReviewCommitOid: pendingReviewCommitOid ?? (pendingReviewId is not null ? headSha : null),
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: (drafts ?? Enumerable.Empty<DraftComment>()).ToList(),
            DraftReplies: (replies ?? Enumerable.Empty<DraftReply>()).ToList(),
            DraftSummaryMarkdown: summary,
            DraftVerdict: verdict,
            DraftVerdictStatus: DraftVerdictStatus.Draft);

    public static DraftComment Draft(string id, string? threadId = null, string filePath = "src/Foo.cs", int? lineNumber = 42, string side = "RIGHT", string body = "body")
        => new(id, filePath, lineNumber, side, AnchoredSha: "anchorsha", AnchoredLineContent: "line", BodyMarkdown: body, Status: DraftStatus.Draft, IsOverriddenStale: false, ThreadId: threadId);

    public static DraftReply Reply(string id, string parentThreadId, string? replyCommentId = null, string body = "reply", DraftStatus status = DraftStatus.Draft)
        => new(id, parentThreadId, replyCommentId, BodyMarkdown: body, Status: status, IsOverriddenStale: false);
}
