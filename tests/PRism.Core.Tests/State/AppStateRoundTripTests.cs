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
        // Pre-V6 the session carried a flat LastViewedHeadSha; under V6 the same value lives
        // under the seeded "tab-test" stamp. Assert via TabStamps lookup directly.
        Assert.Equal("abc", roundTripped.Reviews.Sessions["acme/api/123"].TabStamps["tab-test"].HeadSha);
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

    [Fact]
    public void DraftComment_PostedFieldsRoundTrip()
    {
        var draft = new DraftComment(
            Id: "d1",
            FilePath: null,
            LineNumber: null,
            Side: "pr",
            AnchoredSha: null,
            AnchoredLineContent: null,
            BodyMarkdown: "hello",
            Status: DraftStatus.Draft,
            IsOverriddenStale: false,
            ThreadId: null,
            PostedCommentId: 12345L,
            PostedBodySnapshot: "hello");

        var json = JsonSerializer.Serialize(draft, JsonSerializerOptionsFactory.Storage);
        var roundTripped = JsonSerializer.Deserialize<DraftComment>(json, JsonSerializerOptionsFactory.Storage);

        Assert.NotNull(roundTripped);
        Assert.Equal(draft, roundTripped);
    }

    [Fact]
    public void IsPrRoot_is_a_computed_predicate_and_does_not_serialize_into_state_json()
    {
        // #324 — IsPrRoot is a derived convenience getter, not persisted data. A getter-only
        // property is serialized by System.Text.Json on write (it is only ignored on read),
        // so without [JsonIgnore] it would leak an "is-pr-root" key into state.json: an
        // unintended persisted-schema change and redundant data. Pin that it stays out.
        var draft = new DraftComment(
            Id: "d1",
            FilePath: null,
            LineNumber: null,
            Side: "pr",
            AnchoredSha: null,
            AnchoredLineContent: null,
            BodyMarkdown: "hello",
            Status: DraftStatus.Draft,
            IsOverriddenStale: false);

        var json = JsonSerializer.Serialize(draft, JsonSerializerOptionsFactory.Storage);

        Assert.DoesNotContain("is-pr-root", json, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void DraftReply_posted_fields_round_trip_and_default_null()
    {
        var reply = new DraftReply("r1", "PRRT_1", null, "body", DraftStatus.Draft, false);
        Assert.Null(reply.PostedCommentId);
        Assert.Null(reply.PostedBodySnapshot);
        var stamped = reply with { PostedCommentId = 99L, PostedBodySnapshot = "body" };
        var json = JsonSerializer.Serialize(stamped, JsonSerializerOptionsFactory.Storage);
        var back = JsonSerializer.Deserialize<DraftReply>(json, JsonSerializerOptionsFactory.Storage)!;
        Assert.Equal(99L, back.PostedCommentId);
        Assert.Equal("body", back.PostedBodySnapshot);
    }
}
