using System.Text.Json;
namespace PRism.GitHub.Tests;

public class ParseReviewThreadsDatabaseIdTests
{
    [Fact]
    public void ParseReviewThreads_reads_databaseId_onto_comment_dto()
    {
        const string json = """
        {"reviewThreads":{"nodes":[{"id":"PRRT_1","path":"a.cs","line":3,"isResolved":false,
          "comments":{"nodes":[{"id":"PRRC_1","databaseId":4242,
            "author":{"login":"octocat","avatarUrl":"http://x/y"},
            "createdAt":"2026-01-01T00:00:00Z","body":"hi","lastEditedAt":null}]}}]}}
        """;
        using var doc = JsonDocument.Parse(json);
        var threads = GitHubPrParser.ParseReviewThreads(doc.RootElement);
        var comment = Assert.Single(Assert.Single(threads).Comments);
        Assert.Equal(4242L, comment.DatabaseId);
    }
}
