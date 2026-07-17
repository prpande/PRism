using System.Text.Json;
namespace PRism.GitHub.Tests;

public class ParseReviewThreadsOutdatedFieldsTests
{
    private static IReadOnlyList<PRism.Core.Contracts.ReviewThreadDto> Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return GitHubPrParser.ParseReviewThreads(doc.RootElement);
    }

    [Fact]
    public void Outdated_thread_maps_null_line_and_anchor_fields()
    {
        const string json = """
        {"reviewThreads":{"nodes":[{"id":"PRRT_1","path":"a.cs","line":null,
          "isOutdated":true,"originalLine":592,"originalStartLine":588,"subjectType":"LINE","isResolved":false,
          "comments":{"nodes":[{"id":"PRRC_1","databaseId":1,
            "author":{"login":"octocat","avatarUrl":null},
            "createdAt":"2026-01-01T00:00:00Z","body":"hi","lastEditedAt":null,
            "diffHunk":"@@ -588,9 +588,9 @@ ctx","pullRequestReview":{"databaseId":777}}]}}]}}
        """;
        var t = Assert.Single(Parse(json));
        Assert.Null(t.LineNumber);
        Assert.True(t.IsOutdated);
        Assert.Equal(592, t.OriginalLine);
        Assert.Equal(588, t.OriginalStartLine);
        Assert.Equal("LINE", t.SubjectType);
        Assert.Equal("@@ -588,9 +588,9 @@ ctx", t.DiffHunk);
        Assert.Equal(777L, t.ReviewDatabaseId);
    }

    [Fact]
    public void Anchored_thread_keeps_line_and_projects_first_comment_fields()
    {
        const string json = """
        {"reviewThreads":{"nodes":[{"id":"PRRT_2","path":"b.cs","line":42,
          "isOutdated":false,"originalLine":40,"originalStartLine":null,"subjectType":"LINE","isResolved":true,
          "comments":{"nodes":[
            {"id":"PRRC_2","databaseId":2,"author":{"login":"octocat","avatarUrl":null},
             "createdAt":"2026-01-01T00:00:00Z","body":"first","lastEditedAt":null,
             "diffHunk":"@@ -40,3 +40,3 @@ first-hunk","pullRequestReview":{"databaseId":888}},
            {"id":"PRRC_3","databaseId":3,"author":{"login":"hubot","avatarUrl":null},
             "createdAt":"2026-01-02T00:00:00Z","body":"second","lastEditedAt":null,
             "diffHunk":"@@ -40,3 +40,3 @@ second-hunk","pullRequestReview":{"databaseId":999}}]}}]}}
        """;
        var t = Assert.Single(Parse(json));
        Assert.Equal(42, t.LineNumber);
        Assert.False(t.IsOutdated);
        Assert.Equal("@@ -40,3 +40,3 @@ first-hunk", t.DiffHunk);   // FIRST comment wins
        Assert.Equal(888L, t.ReviewDatabaseId);                     // FIRST comment wins
    }

    [Fact]
    public void File_level_thread_maps_null_line_and_file_subject()
    {
        const string json = """
        {"reviewThreads":{"nodes":[{"id":"PRRT_3","path":"c.cs","line":null,
          "isOutdated":false,"originalLine":null,"originalStartLine":null,"subjectType":"FILE","isResolved":false,
          "comments":{"nodes":[]}}]}}
        """;
        var t = Assert.Single(Parse(json));
        Assert.Null(t.LineNumber);
        Assert.False(t.IsOutdated);
        Assert.Equal("FILE", t.SubjectType);
        Assert.Null(t.DiffHunk);
        Assert.Null(t.ReviewDatabaseId);
    }

    [Fact]
    public void Pre_capture_payload_without_new_fields_parses_tolerantly()
    {
        // Shape of payloads captured before this change (and of test fakes) — absent
        // fields must default, not throw, so replaying old captures still works.
        const string json = """
        {"reviewThreads":{"nodes":[{"id":"PRRT_4","path":"d.cs","line":3,"isResolved":false,
          "comments":{"nodes":[{"id":"PRRC_4","databaseId":4,
            "author":{"login":"octocat","avatarUrl":null},
            "createdAt":"2026-01-01T00:00:00Z","body":"hi","lastEditedAt":null}]}}]}}
        """;
        var t = Assert.Single(Parse(json));
        Assert.Equal(3, t.LineNumber);
        Assert.False(t.IsOutdated);
        Assert.Null(t.OriginalLine);
        Assert.Null(t.OriginalStartLine);
        Assert.Equal("LINE", t.SubjectType);
        Assert.Null(t.DiffHunk);
        Assert.Null(t.ReviewDatabaseId);
    }
}
