using FluentAssertions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceDiffTests
{
    private static IReviewService NewService(PaginatedFakeHandler handler)
    {
        var factory = new FakeHttpClientFactory(handler, new Uri("https://api.github.com/"));
        return new GitHubReviewService(factory, () => Task.FromResult<string?>("ghp_test"), "https://github.com");
    }

    private static string FilePage(int n, int startIndex = 0) =>
        "[" + string.Join(",", Enumerable.Range(startIndex, n).Select(i =>
            $"{{\"filename\":\"src/F{i}.cs\",\"status\":\"modified\",\"additions\":1,\"deletions\":0,\"patch\":\"@@ -0,0 +1 @@\\n+x\"}}"
        )) + "]";

    private static string PullJson(string baseSha, string headSha, int changedFiles) =>
        $"{{\"changed_files\":{changedFiles},\"head\":{{\"sha\":\"{headSha}\"}},\"base\":{{\"sha\":\"{baseSha}\"}}}}";

    [Fact]
    public async Task GetDiffAsync_paginates_pulls_files_until_link_next_exhausts()
    {
        var handler = new PaginatedFakeHandler()
            .RouteJson("/repos/o/r/pulls/1/files", FilePage(100, 0), FilePage(100, 100), FilePage(50, 200))
            .RouteJson("/repos/o/r/pulls/1", PullJson("base", "head", 250));

        var diff = await NewService(handler).GetDiffAsync(
            new PrReference("o", "r", 1),
            new DiffRangeRequest("base", "head"),
            CancellationToken.None);

        diff.Files.Should().HaveCount(250);
        diff.Truncated.Should().BeFalse();
    }

    [Fact]
    public async Task GetDiffAsync_marks_truncated_when_pull_changed_files_exceeds_assembled_count()
    {
        // Pulls/{n}/files may return fewer files than pull.changed_files reports
        // (server-side soft truncation on very large PRs). Spec § 6.1.
        var pages = Enumerable.Range(0, 30).Select(i => FilePage(100, i * 100)).ToArray();
        var handler = new PaginatedFakeHandler()
            .RouteJson("/repos/o/r/pulls/1/files", pages)
            .RouteJson("/repos/o/r/pulls/1", PullJson("base", "head", 3500));

        var diff = await NewService(handler).GetDiffAsync(
            new PrReference("o", "r", 1),
            new DiffRangeRequest("base", "head"),
            CancellationToken.None);

        diff.Files.Should().HaveCount(3000);
        diff.Truncated.Should().BeTrue();
    }

    [Fact]
    public async Task GetDiffAsync_with_cross_iteration_range_uses_3_dot_compare_endpoint()
    {
        // When DiffRangeRequest does not equal pull.base..pull.head, route through
        // /repos/{o}/{r}/compare/{base}...{head}. Spec § 6.1.
        var compareJson = "{\"files\":[" +
            "{\"filename\":\"src/X.cs\",\"status\":\"modified\",\"additions\":2,\"deletions\":1,\"patch\":\"@@\"}" +
            "]}";
        var handler = new PaginatedFakeHandler()
            .RouteJson("/repos/o/r/compare/iter1...iter2", compareJson)
            .RouteJson("/repos/o/r/pulls/1", PullJson("base", "head", 1));

        var diff = await NewService(handler).GetDiffAsync(
            new PrReference("o", "r", 1),
            new DiffRangeRequest("iter1", "iter2"),
            CancellationToken.None);

        diff.Range.Should().Be("iter1..iter2");
        diff.Files.Should().HaveCount(1);
    }

    [Fact]
    public async Task GetDiffAsync_returns_range_unreachable_on_garbage_collected_sha()
    {
        // GC'd SHA → compare endpoint 404 → throws RangeUnreachableException.
        // Endpoint layer maps to ProblemDetails type "/diff/range-unreachable". Spec § 6.1 + § 8.
        var handler = new PaginatedFakeHandler()
            .RouteStatus("/repos/o/r/compare/dead-sha...head", System.Net.HttpStatusCode.NotFound)
            .RouteJson("/repos/o/r/pulls/1", PullJson("base", "head", 0));

        var sut = NewService(handler);

        await sut.Invoking(s => s.GetDiffAsync(
                new PrReference("o", "r", 1),
                new DiffRangeRequest("dead-sha", "head"),
                CancellationToken.None))
            .Should().ThrowAsync<RangeUnreachableException>();
    }
}
