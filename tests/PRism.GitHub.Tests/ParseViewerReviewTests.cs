using System.Text.Json;
using PRism.Core.Contracts;
using Xunit;

namespace PRism.GitHub.Tests;

public class ParseViewerReviewTests
{
    private static JsonElement Pull(string reviewsJson)
        => JsonDocument.Parse($"{{\"reviews\":{{\"nodes\":{reviewsJson}}}}}").RootElement;

    private static string Review(string login, string state, string? submittedAt, string? oid)
    {
        var sa = submittedAt is null ? "null" : $"\"{submittedAt}\"";
        var commit = oid is null ? "null" : $"{{\"oid\":\"{oid}\"}}";
        return $"{{\"author\":{{\"login\":\"{login}\"}},\"state\":\"{state}\",\"submittedAt\":{sa},\"commit\":{commit}}}";
    }

    [Fact]
    public void Selects_viewer_latest_submitted_by_max_submittedAt()
    {
        var pull = Pull($"[{Review("me", "COMMENTED", "2026-01-01T00:00:00Z", "old")}," +
                        $"{Review("me", "APPROVED", "2026-02-01T00:00:00Z", "newsha")}]");
        var r = GitHubPrParser.ParseViewerReview(pull, "me");
        Assert.NotNull(r);
        Assert.Equal(ReviewState.Approved, r!.State);
        Assert.Equal("newsha", r.CommitSha);
        Assert.Equal(DateTimeOffset.Parse("2026-02-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture), r.SubmittedAt);
    }

    [Theory]
    [InlineData("APPROVED", ReviewState.Approved)]
    [InlineData("CHANGES_REQUESTED", ReviewState.ChangesRequested)]
    [InlineData("COMMENTED", ReviewState.Commented)]
    public void Maps_each_state(string wire, ReviewState expected)
    {
        var pull = Pull($"[{Review("me", wire, "2026-01-01T00:00:00Z", "x")}]");
        Assert.Equal(expected, GitHubPrParser.ParseViewerReview(pull, "me")!.State);
    }

    [Fact]
    public void Excludes_dismissed_and_pending_and_falls_back_to_effective()
    {
        var pull = Pull($"[{Review("me", "APPROVED", "2026-01-01T00:00:00Z", "a")}," +
                        $"{Review("me", "DISMISSED", "2026-03-01T00:00:00Z", "b")}," +
                        $"{Review("me", "PENDING", null, null)}]");
        var r = GitHubPrParser.ParseViewerReview(pull, "me");
        Assert.Equal(ReviewState.Approved, r!.State); // dismissed (later) + pending excluded
    }

    [Fact]
    public void Ignores_other_users()
    {
        var pull = Pull($"[{Review("someone-else", "APPROVED", "2026-01-01T00:00:00Z", "a")}]");
        Assert.Null(GitHubPrParser.ParseViewerReview(pull, "me"));
    }

    [Fact]
    public void Selects_review_with_null_commit_as_null_CommitSha()
    {
        var pull = Pull($"[{Review("me", "COMMENTED", "2026-01-01T00:00:00Z", null)}]");
        var r = GitHubPrParser.ParseViewerReview(pull, "me");
        Assert.NotNull(r);
        Assert.Null(r!.CommitSha);
    }

    [Fact]
    public void Returns_null_when_viewerLogin_null_or_no_reviews()
    {
        var pull = Pull($"[{Review("me", "APPROVED", "2026-01-01T00:00:00Z", "a")}]");
        Assert.Null(GitHubPrParser.ParseViewerReview(pull, null));
        Assert.Null(GitHubPrParser.ParseViewerReview(JsonDocument.Parse("{}").RootElement, "me"));
    }

    [Fact]
    public void Skips_malformed_node_without_throwing()
    {
        var pull = Pull($"[{{\"author\":42}},{Review("me", "APPROVED", "2026-01-01T00:00:00Z", "a")}]");
        Assert.Equal(ReviewState.Approved, GitHubPrParser.ParseViewerReview(pull, "me")!.State);
    }
}
