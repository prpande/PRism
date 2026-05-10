using System.Text.Json.Nodes;
using PRism.Core.State.Migrations;

namespace PRism.Core.Tests.State;

public class MigrationStepTests
{
    [Fact]
    public void MigrateV1ToV2_AddsViewedFilesToEachSession()
    {
        var root = JsonNode.Parse("""
        {
          "version": 1,
          "review-sessions": {
            "acme/api/123": { "last-viewed-head-sha": "abc" }
          }
        }
        """)!.AsObject();

        var result = AppStateMigrations.MigrateV1ToV2(root);

        Assert.Equal(2, result["version"]!.GetValue<int>());
        var session = result["review-sessions"]!["acme/api/123"]!.AsObject();
        Assert.NotNull(session["viewed-files"]);
        Assert.IsType<JsonObject>(session["viewed-files"]);
    }

    [Fact]
    public void MigrateV2ToV3_RenamesReviewSessionsKeyToReviewsDotSessions()
    {
        var root = JsonNode.Parse("""
        {
          "version": 2,
          "review-sessions": {
            "acme/api/123": { "viewed-files": {} }
          }
        }
        """)!.AsObject();

        var result = AppStateMigrations.MigrateV2ToV3(root);

        Assert.Equal(3, result["version"]!.GetValue<int>());
        Assert.Null(result["review-sessions"]);
        Assert.NotNull(result["reviews"]);
        Assert.NotNull(result["reviews"]!["sessions"]);
        Assert.NotNull(result["reviews"]!["sessions"]!["acme/api/123"]);
    }

    [Fact]
    public void MigrateV2ToV3_BackfillsDraftFieldsPerSession()
    {
        var root = JsonNode.Parse("""
        {
          "version": 2,
          "review-sessions": {
            "acme/api/123": { "viewed-files": {} }
          }
        }
        """)!.AsObject();

        var result = AppStateMigrations.MigrateV2ToV3(root);

        var session = result["reviews"]!["sessions"]!["acme/api/123"]!.AsObject();
        Assert.IsType<JsonArray>(session["draft-comments"]);
        Assert.IsType<JsonArray>(session["draft-replies"]);
        Assert.Null(session["draft-summary-markdown"]?.GetValue<string?>());
        Assert.Null(session["draft-verdict"]?.GetValue<string?>());
        Assert.Equal("draft", session["draft-verdict-status"]!.GetValue<string>());
    }

    [Fact]
    public void MigrateV2ToV3_NormalizesHashKeyToSlashForm()
    {
        var root = JsonNode.Parse("""
        {
          "version": 2,
          "review-sessions": {
            "acme/api#123": { "viewed-files": {} }
          }
        }
        """)!.AsObject();

        var result = AppStateMigrations.MigrateV2ToV3(root);

        var sessions = result["reviews"]!["sessions"]!.AsObject();
        Assert.True(sessions.ContainsKey("acme/api/123"));
        Assert.False(sessions.ContainsKey("acme/api#123"));
    }

    [Fact]
    public void MigrateV2ToV3_HashKeyCollidesWithSlashKey_SlashFormWins()
    {
        var root = JsonNode.Parse("""
        {
          "version": 2,
          "review-sessions": {
            "acme/api/123": { "viewed-files": {}, "marker": "slash" },
            "acme/api#123": { "viewed-files": {}, "marker": "hash" }
          }
        }
        """)!.AsObject();

        var result = AppStateMigrations.MigrateV2ToV3(root);

        var sessions = result["reviews"]!["sessions"]!.AsObject();
        Assert.Single(sessions);
        Assert.Equal("slash", sessions["acme/api/123"]!["marker"]!.GetValue<string>());
    }

    [Fact]
    public void MigrateV2ToV3_HalfMigratedV3File_SkipsRenameRunsBackfillOnly()
    {
        var root = JsonNode.Parse("""
        {
          "version": 2,
          "reviews": {
            "sessions": {
              "acme/api/123": { "viewed-files": {} }
            }
          }
        }
        """)!.AsObject();

        var result = AppStateMigrations.MigrateV2ToV3(root);

        var session = result["reviews"]!["sessions"]!["acme/api/123"]!.AsObject();
        Assert.IsType<JsonArray>(session["draft-comments"]);
    }
}
