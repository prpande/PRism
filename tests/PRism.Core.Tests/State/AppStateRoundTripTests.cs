using System.Text.Json;
using PRism.Core.Json;
using PRism.Core.State;

namespace PRism.Core.Tests.State;

public class AppStateRoundTripTests
{
    [Fact]
    public void Default_HasEmptyReviews()
    {
        Assert.Empty(AppState.Default.Reviews.Sessions);
    }

    [Fact]
    public void SerializeAndDeserialize_PreservesShape()
    {
        var session = new ReviewSessionState(
            LastViewedHeadSha: "abc",
            LastSeenCommentId: null,
            PendingReviewId: null,
            PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment>(),
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null,
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);

        var state = AppState.Default.WithDefaultReviews(new PrSessionsState(new Dictionary<string, ReviewSessionState>
        {
            ["acme/api/123"] = session
        }));

        var json = JsonSerializer.Serialize(state, JsonSerializerOptionsFactory.Storage);
        var roundTripped = JsonSerializer.Deserialize<AppState>(json, JsonSerializerOptionsFactory.Storage);

        Assert.NotNull(roundTripped);
        Assert.Single(roundTripped!.Reviews.Sessions);
        Assert.Equal("abc", roundTripped.Reviews.Sessions["acme/api/123"].LastViewedHeadSha);
    }

    [Fact]
    public void JsonShape_TopLevelKey_IsReviewsNotReviewSessions()
    {
        var state = AppState.Default;

        var json = JsonSerializer.Serialize(state, JsonSerializerOptionsFactory.Storage);

        Assert.Contains("\"reviews\":", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"review-sessions\":", json, StringComparison.Ordinal);
    }
}
