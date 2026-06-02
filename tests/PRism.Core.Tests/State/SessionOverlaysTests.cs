using FluentAssertions;
using PRism.Core.State;
using Xunit;

namespace PRism.Core.Tests.State;

public class SessionOverlaysTests
{
    private const string SessionKey = "owner/repo/1";

    private static AppState StateWithSession(ReviewSessionState session, string key = SessionKey)
    {
        var sessions = new Dictionary<string, ReviewSessionState> { [key] = session };
        return AppState.Default.WithDefaultReviews(new PrSessionsState(sessions));
    }

    private static ReviewSessionState NewSession(
        string? pendingReviewId = null,
        string? pendingReviewCommitOid = null,
        IReadOnlyList<DraftComment>? draftComments = null,
        IReadOnlyList<DraftReply>? draftReplies = null)
        => new(
            TabStamps: new Dictionary<string, TabStamp> { ["tab-test"] = new TabStamp("head1", DateTime.UtcNow.AddMinutes(-1)) },
            LastSeenCommentId: null,
            PendingReviewId: pendingReviewId,
            PendingReviewCommitOid: pendingReviewCommitOid,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: draftComments ?? new List<DraftComment>(),
            DraftReplies: draftReplies ?? new List<DraftReply>(),
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);

    [Fact]
    public void ClearPendingReviewStamps_nulls_pending_review_id_and_commit_oid()
    {
        var session = NewSession(pendingReviewId: "PRR_abc", pendingReviewCommitOid: "abc123");
        var state = StateWithSession(session);

        var result = SessionOverlays.ClearPendingReviewStamps(state, SessionKey);

        var cleared = result.Reviews.Sessions[SessionKey];
        cleared.PendingReviewId.Should().BeNull();
        cleared.PendingReviewCommitOid.Should().BeNull();
    }

    [Fact]
    public void ClearPendingReviewStamps_nulls_every_DraftComment_ThreadId()
    {
        var drafts = new List<DraftComment>
        {
            new(
                Id: "d1",
                FilePath: "src/Foo.cs", LineNumber: 10, Side: "RIGHT",
                AnchoredSha: "sha", AnchoredLineContent: "line",
                BodyMarkdown: "first",
                Status: DraftStatus.Draft, IsOverriddenStale: false,
                ThreadId: "thread-1"),
            new(
                Id: "d2",
                FilePath: "src/Bar.cs", LineNumber: 20, Side: "RIGHT",
                AnchoredSha: "sha", AnchoredLineContent: "line",
                BodyMarkdown: "second",
                Status: DraftStatus.Draft, IsOverriddenStale: false,
                ThreadId: "thread-2"),
        };
        var state = StateWithSession(NewSession(draftComments: drafts));

        var result = SessionOverlays.ClearPendingReviewStamps(state, SessionKey);

        var cleared = result.Reviews.Sessions[SessionKey];
        cleared.DraftComments.Should().HaveCount(2);
        cleared.DraftComments.Should().OnlyContain(d => d.ThreadId == null);
    }

    [Fact]
    public void ClearPendingReviewStamps_nulls_every_DraftReply_ReplyCommentId()
    {
        var replies = new List<DraftReply>
        {
            new(
                Id: "r1",
                ParentThreadId: "thread-1",
                ReplyCommentId: "RC_111",
                BodyMarkdown: "reply 1",
                Status: DraftStatus.Draft,
                IsOverriddenStale: false),
            new(
                Id: "r2",
                ParentThreadId: "thread-2",
                ReplyCommentId: "RC_222",
                BodyMarkdown: "reply 2",
                Status: DraftStatus.Draft,
                IsOverriddenStale: false),
        };
        var state = StateWithSession(NewSession(draftReplies: replies));

        var result = SessionOverlays.ClearPendingReviewStamps(state, SessionKey);

        var cleared = result.Reviews.Sessions[SessionKey];
        cleared.DraftReplies.Should().HaveCount(2);
        cleared.DraftReplies.Should().OnlyContain(r => r.ReplyCommentId == null);
    }

    [Fact]
    public void ClearPendingReviewStamps_preserves_PostedCommentId_and_PostedBodySnapshot()
    {
        var prRootDraft = new DraftComment(
            Id: "pr-root",
            FilePath: null, LineNumber: null, Side: "pr",
            AnchoredSha: null, AnchoredLineContent: null,
            BodyMarkdown: "summary",
            Status: DraftStatus.Draft, IsOverriddenStale: false,
            ThreadId: null,
            PostedCommentId: 42L,
            PostedBodySnapshot: "x");
        var state = StateWithSession(NewSession(
            pendingReviewId: "PRR_abc",
            pendingReviewCommitOid: "abc123",
            draftComments: new List<DraftComment> { prRootDraft }));

        var result = SessionOverlays.ClearPendingReviewStamps(state, SessionKey);

        var cleared = result.Reviews.Sessions[SessionKey];
        var preserved = cleared.DraftComments.Single();
        preserved.PostedCommentId.Should().Be(42L);
        preserved.PostedBodySnapshot.Should().Be("x");
    }

    [Fact]
    public void ClearPendingReviewStamps_no_op_when_session_key_absent()
    {
        var state = AppState.Default;

        var result = SessionOverlays.ClearPendingReviewStamps(state, "missing/key/99");

        result.Should().BeSameAs(state);
    }
}
