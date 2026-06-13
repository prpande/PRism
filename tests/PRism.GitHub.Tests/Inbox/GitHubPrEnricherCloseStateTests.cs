using System.Globalization;
using System.Net;
using System.Text;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.GitHub.Inbox;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests.Inbox;

public sealed class GitHubPrEnricherCloseStateTests
{
    private static RawPrInboxItem Raw(int n) => new(
        new PrReference("acme", "api", n), "t", "a", "acme/api",
        DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0, 0, 0, "sha", 1, 0);

    private static HttpResponseMessage Ok(string body) =>
        new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private static GitHubPrEnricher BuildSut(string json)
    {
        var handler = new FakeHttpMessageHandler(_ => Ok(json));
        return new GitHubPrEnricher(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("t"));
    }

    [Fact]
    public async Task Enrich_PopulatesMergedAt_OnMergedPr()
    {
        const string json = """
        {"head":{"sha":"abc"},"additions":1,"deletions":2,"commits":3,
         "merged_at":"2026-05-20T10:00:00Z","closed_at":"2026-05-20T10:00:00Z"}
        """;
        var enricher = BuildSut(json);

        var result = await enricher.EnrichAsync(new[] { Raw(1) }, default);

        result[0].MergedAt.Should().Be(DateTimeOffset.Parse("2026-05-20T10:00:00Z", CultureInfo.InvariantCulture));
        result[0].ClosedAt.Should().Be(DateTimeOffset.Parse("2026-05-20T10:00:00Z", CultureInfo.InvariantCulture));
        result[0].HeadSha.Should().Be("abc"); // Task 2b: confirm head.sha is read on merged PRs
    }

    [Fact]
    public async Task Enrich_LeavesMergedAtNull_OnClosedUnmergedPr()
    {
        const string json = """
        {"head":{"sha":"abc"},"additions":1,"deletions":2,"commits":3,
         "merged_at":null,"closed_at":"2026-05-21T08:00:00Z"}
        """;
        var enricher = BuildSut(json);

        var result = await enricher.EnrichAsync(new[] { Raw(1) }, default);

        result[0].MergedAt.Should().BeNull();
        result[0].ClosedAt.Should().Be(DateTimeOffset.Parse("2026-05-21T08:00:00Z", CultureInfo.InvariantCulture));
    }
}
