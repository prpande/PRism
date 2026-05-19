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
            TabStamps: new Dictionary<string, TabStamp> { ["tab-test"] = new TabStamp("abc", DateTime.UtcNow.AddMinutes(-1)) },
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
        Assert.Equal("abc", roundTripped.Reviews.Sessions["acme/api/123"].LegacyMostRecentHeadSha());
    }

    [Fact]
    public void TabStamps_round_trips_through_state_serializer_with_kebab_case_keys()
    {
        var stamp = new TabStamp(HeadSha: "abc123", StampedAtUtc: new DateTime(2026, 5, 18, 14, 23, 45, DateTimeKind.Utc));
        var session = new ReviewSessionState(
            TabStamps: new Dictionary<string, TabStamp> { ["tab-A"] = stamp },
            LastSeenCommentId: "999",
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
        Assert.Contains("\"tab-stamps\"", json, StringComparison.Ordinal);
        Assert.Contains("\"head-sha\"", json, StringComparison.Ordinal);
        Assert.Contains("\"stamped-at-utc\"", json, StringComparison.Ordinal);

        var deserialized = JsonSerializer.Deserialize<AppState>(json, JsonSerializerOptionsFactory.Storage)!;
        var rt = deserialized.Reviews.Sessions["acme/api/123"];
        Assert.True(rt.TabStamps.ContainsKey("tab-A"));
        Assert.Equal("abc123", rt.TabStamps["tab-A"].HeadSha);
        Assert.Equal(stamp.StampedAtUtc, rt.TabStamps["tab-A"].StampedAtUtc);
        Assert.Equal("999", rt.LastSeenCommentId);
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
