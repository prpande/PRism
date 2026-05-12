using System.Net;
using FluentAssertions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubReviewServicePollActivePrTests
{
    private static GitHubReviewService NewService(HttpMessageHandler handler)
    {
        var factory = new FakeHttpClientFactory(handler, new Uri("https://api.github.com/"));
        return new GitHubReviewService(factory, () => Task.FromResult<string?>("ghp_test"), "https://github.com");
    }

    private const string PullJson = "{" +
        "\"head\":{\"sha\":\"head-1\"}," +
        "\"base\":{\"sha\":\"base-1\"}," +
        "\"state\":\"open\"," +
        "\"mergeable_state\":\"clean\"" +
        "}";

    /// <summary>
    /// Builds a fake handler that responds to pulls/{n}, pulls/{n}/comments, and
    /// pulls/{n}/reviews, with a Link rel="last" header on the comments/reviews paths
    /// when a total count is given.
    /// </summary>
    private sealed class PollHandler : HttpMessageHandler
    {
        public int Comments { get; init; }
        public int Reviews { get; init; }
        public string PullBody { get; init; } = PullJson;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
        {
            ArgumentNullException.ThrowIfNull(req);
            var path = req.RequestUri!.AbsolutePath;
            HttpResponseMessage MakePagedHead(int total)
            {
                var body = total == 0 ? "[]" : "[{}]";
                var resp = new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
                };
                if (total > 1)
                {
                    resp.Headers.TryAddWithoutValidation("Link",
                        $"<https://api.github.com{path}?per_page=1&page=2>; rel=\"next\", " +
                        $"<https://api.github.com{path}?per_page=1&page={total}>; rel=\"last\"");
                }
                return resp;
            }

            if (path.EndsWith("/comments", StringComparison.Ordinal)) return Task.FromResult(MakePagedHead(Comments));
            if (path.EndsWith("/reviews", StringComparison.Ordinal)) return Task.FromResult(MakePagedHead(Reviews));
            // pulls/{n}
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(PullBody, System.Text.Encoding.UTF8, "application/json"),
            });
        }
    }

    [Fact]
    public async Task PollActivePrAsync_returns_head_sha_state_and_link_last_counts()
    {
        var sut = NewService(new PollHandler { Comments = 17, Reviews = 4 });

        var snap = await sut.PollActivePrAsync(new PrReference("o", "r", 1), CancellationToken.None);

        snap.HeadSha.Should().Be("head-1");
        snap.PrState.Should().Be("open");
        snap.Mergeability.Should().Be("clean");
        snap.CommentCount.Should().Be(17);
        snap.ReviewCount.Should().Be(4);
    }

    [Fact]
    public async Task PollActivePrAsync_treats_missing_link_header_as_count_of_one_or_zero()
    {
        // No Link header on a 1-item page → count is 1 (the array length).
        // Empty array → count is 0.
        var sut = NewService(new PollHandler { Comments = 1, Reviews = 0 });

        var snap = await sut.PollActivePrAsync(new PrReference("o", "r", 1), CancellationToken.None);

        snap.CommentCount.Should().Be(1);
        snap.ReviewCount.Should().Be(0);
    }
}
