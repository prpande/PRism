using System.Net;
using System.Text;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.GitHub.Inbox;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests.Inbox;

public sealed class GitHubAwaitingAuthorFilterTests
{
    private const string ViewerLogin = "alice";

    private static RawPrInboxItem Raw(int n, string headSha = "new", string repo = "acme/api")
    {
        var parts = repo.Split('/');
        return new RawPrInboxItem(
            new PrReference(parts[0], parts[1], n),
            $"PR #{n}", "author", repo,
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow,
            0, 0, 0, headSha, 1);
    }

    private static string ReviewsResponse(string viewerLogin, string lastReviewSha) => $$"""
        [
            { "user": { "login": "{{viewerLogin}}" }, "commit_id": "{{lastReviewSha}}" }
        ]
        """;

    private static HttpResponseMessage Respond(HttpStatusCode code, string body) => new(code)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    [Fact]
    public async Task Includes_pr_with_newer_commits_than_last_review()
    {
        // reviews returns viewer's last review at sha "old"; PR HeadSha is "new"
        var handler = new FakeHttpMessageHandler(_ =>
            Respond(HttpStatusCode.OK, ReviewsResponse(ViewerLogin, "old")));
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com/") };
        var sut = new GitHubAwaitingAuthorFilter(http, () => Task.FromResult<string?>("t"));

        var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "new")], default);

        result.Should().HaveCount(1);
        result[0].Reference.Number.Should().Be(1);
    }

    [Fact]
    public async Task Excludes_pr_where_viewer_review_matches_head_sha()
    {
        // reviews returns viewer's last review at sha "head"; PR HeadSha is "head"
        var handler = new FakeHttpMessageHandler(_ =>
            Respond(HttpStatusCode.OK, ReviewsResponse(ViewerLogin, "head")));
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com/") };
        var sut = new GitHubAwaitingAuthorFilter(http, () => Task.FromResult<string?>("t"));

        var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "head")], default);

        result.Should().BeEmpty();
    }

    [Fact]
    public async Task Pr_404_is_filtered_silently()
    {
        // handler returns 404 for pulls/{n}/reviews → PR excluded; no exception
        var handler = new FakeHttpMessageHandler(_ =>
            Respond(HttpStatusCode.NotFound, "{}"));
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com/") };
        var sut = new GitHubAwaitingAuthorFilter(http, () => Task.FromResult<string?>("t"));

        var act = async () => await sut.FilterAsync(ViewerLogin, [Raw(1, "sha1")], default);

        await act.Should().NotThrowAsync();
        var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "sha1")], default);
        result.Should().BeEmpty();
    }

    [Fact]
    public async Task Cache_hit_skips_http()
    {
        // call once for (pr, sha); call again same key → second call: zero new HTTP calls
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(_ =>
        {
            Interlocked.Increment(ref requestCount);
            return Respond(HttpStatusCode.OK, ReviewsResponse(ViewerLogin, "old"));
        });
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com/") };
        var sut = new GitHubAwaitingAuthorFilter(http, () => Task.FromResult<string?>("t"));

        var candidate = Raw(1, "new");
        await sut.FilterAsync(ViewerLogin, [candidate], default);
        await sut.FilterAsync(ViewerLogin, [candidate], default);

        requestCount.Should().Be(1);
    }

    [Fact]
    public async Task Cache_invalidates_on_head_sha_change()
    {
        // call once with sha A, then with same prRef but sha B → two HTTP calls
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(_ =>
        {
            Interlocked.Increment(ref requestCount);
            return Respond(HttpStatusCode.OK, ReviewsResponse(ViewerLogin, "old"));
        });
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com/") };
        var sut = new GitHubAwaitingAuthorFilter(http, () => Task.FromResult<string?>("t"));

        await sut.FilterAsync(ViewerLogin, [Raw(1, "sha-A")], default);
        await sut.FilterAsync(ViewerLogin, [Raw(1, "sha-B")], default);

        requestCount.Should().Be(2);
    }

    [Fact]
    public async Task Empty_input_returns_empty()
    {
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(_ =>
        {
            Interlocked.Increment(ref requestCount);
            return Respond(HttpStatusCode.OK, "[]");
        });
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com/") };
        var sut = new GitHubAwaitingAuthorFilter(http, () => Task.FromResult<string?>("t"));

        var result = await sut.FilterAsync(ViewerLogin, [], default);

        result.Should().BeEmpty();
        requestCount.Should().Be(0);
    }

    [Fact]
    public async Task Cancellation_propagates()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel(); // pre-cancelled

        var handler = new FakeHttpMessageHandler(_ =>
        {
            cts.Token.ThrowIfCancellationRequested();
            return Respond(HttpStatusCode.OK, ReviewsResponse(ViewerLogin, "old"));
        });
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com/") };
        var sut = new GitHubAwaitingAuthorFilter(http, () => Task.FromResult<string?>("t"));

        var act = async () => await sut.FilterAsync(ViewerLogin, [Raw(1, "sha1")], cts.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
    }

    [Fact]
    public async Task Pr_without_head_sha_is_skipped_silently()
    {
        // candidate.HeadSha is empty → PR not in result; no HTTP calls
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(_ =>
        {
            Interlocked.Increment(ref requestCount);
            return Respond(HttpStatusCode.OK, ReviewsResponse(ViewerLogin, "sha"));
        });
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com/") };
        var sut = new GitHubAwaitingAuthorFilter(http, () => Task.FromResult<string?>("t"));

        var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "")], default);

        result.Should().BeEmpty();
        requestCount.Should().Be(0);
    }
}
