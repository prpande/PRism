using System.Net;
using FluentAssertions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

/// <summary>
/// Regression cover for the "REST helpers built without an Authorization header"
/// class of bug. Every new S3 REST call must attach the Bearer token from
/// <c>_readToken()</c>; without it, private repos 404 and public repos burn the
/// 60/hr anonymous rate limit. See PR #19 review thread.
/// </summary>
public class GitHubReviewServiceAuthHeaderTests
{
    private static GitHubReviewService NewService(HttpMessageHandler handler, Func<Task<string?>>? readToken = null)
    {
        var factory = new FakeHttpClientFactory(handler, new Uri("https://api.github.com/"));
        return new GitHubReviewService(
            factory,
            readToken ?? (() => Task.FromResult<string?>("ghp_test")),
            "https://github.com");
    }

    private sealed class CapturingHandler : HttpMessageHandler
    {
        public List<string?> AuthValues { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
        {
            ArgumentNullException.ThrowIfNull(req);
            AuthValues.Add(req.Headers.Authorization?.Parameter);
            // Return whatever shape the caller is parsing; "{}" is enough for the
            // test (we don't actually decode it — assertions are on the headers).
            // For pulls/{n}/files etc., return [] / pull metadata stubs as needed.
            var path = req.RequestUri!.AbsolutePath;
            string body;
            if (path.EndsWith("/files", StringComparison.Ordinal)) body = "[]";
            else if (path.Contains("/pulls/", StringComparison.Ordinal)
                     && !path.Contains("/comments", StringComparison.Ordinal)
                     && !path.Contains("/reviews", StringComparison.Ordinal))
                body = "{\"changed_files\":0,\"head\":{\"sha\":\"h\"},\"base\":{\"sha\":\"b\"}}";
            else if (path.Contains("/comments", StringComparison.Ordinal)
                  || path.Contains("/reviews", StringComparison.Ordinal)) body = "[]";
            else body = "{}";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
            });
        }
    }

    [Fact]
    public async Task GetDiffAsync_attaches_bearer_token()
    {
        var handler = new CapturingHandler();
        await NewService(handler).GetDiffAsync(
            new PrReference("o", "r", 1),
            new DiffRangeRequest("b", "h"),
            CancellationToken.None);

        handler.AuthValues.Should().NotBeEmpty();
        handler.AuthValues.Should().AllSatisfy(v => v.Should().Be("ghp_test"),
            because: "every REST call (pull meta + files pagination) must carry the Bearer token");
    }

    [Fact]
    public async Task GetFileContentAsync_attaches_bearer_token()
    {
        var handler = new CapturingHandler();
        await NewService(handler).GetFileContentAsync(
            new PrReference("o", "r", 1), "src/Foo.cs", "abc", CancellationToken.None);

        handler.AuthValues.Should().HaveCount(1);
        handler.AuthValues[0].Should().Be("ghp_test");
    }

    [Fact]
    public async Task PollActivePrAsync_attaches_bearer_token_on_all_three_calls()
    {
        var handler = new CapturingHandler();
        await NewService(handler).PollActivePrAsync(new PrReference("o", "r", 1), CancellationToken.None);

        handler.AuthValues.Should().HaveCount(3,
            because: "PollActivePrAsync issues 3 parallel REST calls (pulls/{n} + comments + reviews)");
        handler.AuthValues.Should().AllSatisfy(v => v.Should().Be("ghp_test"));
    }

    [Fact]
    public async Task SendGitHubAsync_omits_authorization_when_token_is_null_or_empty()
    {
        // Defensive: if the token store hasn't been seeded yet, the helper must omit
        // the header rather than send a malformed `Bearer ` value to GitHub.
        var handler = new CapturingHandler();
        await NewService(handler, readToken: () => Task.FromResult<string?>(null))
            .GetDiffAsync(new PrReference("o", "r", 1), new DiffRangeRequest("b", "h"), CancellationToken.None);

        handler.AuthValues.Should().NotBeEmpty();
        handler.AuthValues.Should().AllSatisfy(v => v.Should().BeNull());
    }
}
