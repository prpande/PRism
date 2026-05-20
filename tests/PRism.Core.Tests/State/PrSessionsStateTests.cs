using PRism.Core.State;

namespace PRism.Core.Tests.State;

public class PrSessionsStateTests
{
    [Fact]
    public void Empty_HasZeroSessions()
    {
        Assert.Empty(PrSessionsState.Empty.Sessions);
    }

    [Fact]
    public void Constructor_HoldsProvidedDictionary()
    {
        var sessions = new Dictionary<string, ReviewSessionState>
        {
            ["acme/api/123"] = new ReviewSessionState(
                TabStamps: new Dictionary<string, TabStamp> { ["tab-test"] = new TabStamp("abc", DateTime.UtcNow.AddMinutes(-1)) },
                LastSeenCommentId: null,
                PendingReviewId: null,
                PendingReviewCommitOid: null,
                ViewedFiles: new Dictionary<string, string>(),
                DraftComments: new List<DraftComment>(),
                DraftReplies: new List<DraftReply>(),
                DraftSummaryMarkdown: null,
                DraftVerdict: null,
                DraftVerdictStatus: DraftVerdictStatus.Draft)
        };

        var state = new PrSessionsState(sessions);

        Assert.Single(state.Sessions);
        Assert.True(state.Sessions.ContainsKey("acme/api/123"));
    }
}
