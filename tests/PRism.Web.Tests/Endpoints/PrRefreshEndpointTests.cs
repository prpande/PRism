using System.Net;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class PrRefreshEndpointTests
{
    private static readonly PrReference Pr1 = new("owner", "repo", 7);

    private static PrDetailDto MakeDetail(string headSha) =>
        new(
            Pr: new Pr(Pr1, "Test PR", "body", "alice", "OPEN", headSha, "base1",
                "feat/x", "main", "MERGEABLE", "passing", false, false, DateTimeOffset.UtcNow, null),
            ClusteringQuality: ClusteringQuality.Ok, Iterations: null, Commits: Array.Empty<CommitDto>(),
            RootComments: Array.Empty<IssueCommentDto>(), ReviewComments: Array.Empty<ReviewThreadDto>(),
            TimelineCapHit: false);

    private static async Task<HttpResponseMessage> PostRefresh(HttpClient client, PrReference pr)
    {
        var uri = new Uri($"/api/pr/{pr.Owner}/{pr.Repo}/{pr.Number}/refresh", UriKind.Relative);
        using var req = new HttpRequestMessage(HttpMethod.Post, uri);
        req.Headers.Add("Origin", client.BaseAddress!.GetLeftPart(UriPartial.Authority));
        return await client.SendAsync(req);
    }

    [Fact]
    public async Task Post_refresh_returns_200_on_success()
    {
        var fake = new PrDetailFakeReviewService { DefaultDetailResponse = MakeDetail("h1") };
        using var factory = new PRismWebApplicationFactory { ReviewServiceOverride = fake };
        var client = factory.CreateClient();

        var resp = await PostRefresh(client, Pr1);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Post_refresh_returns_404_when_pr_gone()
    {
        var fake = new PrDetailFakeReviewService { DefaultDetailResponse = null };
        using var factory = new PRismWebApplicationFactory { ReviewServiceOverride = fake };
        var client = factory.CreateClient();

        var resp = await PostRefresh(client, Pr1);

        resp.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Post_refresh_returns_503_when_throws_and_view_did_not_advance()
    {
        var fake = new PrDetailFakeReviewService
        {
            DefaultDetailResponse = MakeDetail("h1"),
            GetPrDetailAsyncOverride = (_, _) =>
                throw new HttpRequestException("rate limited", null, HttpStatusCode.TooManyRequests),
        };
        using var factory = new PRismWebApplicationFactory { ReviewServiceOverride = fake };
        var client = factory.CreateClient();

        var resp = await PostRefresh(client, Pr1);

        resp.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/pr/refresh-failed");
    }

    [Fact]
    public async Task Post_refresh_returns_200_when_throws_but_view_advanced()
    {
        // Honest-completion: the refresh's GetPrDetail throws, but a concurrent commit advanced
        // the cached snapshot first, so the committed view is fresh => 200 (not 503). The
        // lock-free loader makes the re-entrant RefreshAsync below safe (a _writerLock would deadlock).
        var fake = new PrDetailFakeReviewService { DefaultDetailResponse = MakeDetail("h1") };
        using var factory = new PRismWebApplicationFactory { ReviewServiceOverride = fake };
        var client = factory.CreateClient();
        var loader = factory.Services.GetRequiredService<PrDetailLoader>();

        // Prime the cache: `before` = snapshot at h1.
        await loader.LoadAsync(Pr1, default);

        var calls = 0;
        fake.GetPrDetailAsyncOverride = async (prRef, ct) =>
        {
            calls++;
            if (calls == 1)
            {
                // Simulate a concurrent actor committing a fresh snapshot at a new head, then throw.
                fake.DefaultDetailResponse = MakeDetail("h2");
                await loader.RefreshAsync(prRef, ct);   // re-enters override (calls==2) → commits h2
                throw new HttpRequestException("rate limited", null, HttpStatusCode.TooManyRequests);
            }
            return fake.DefaultDetailResponse;          // calls>=2: normal return → commit
        };

        var resp = await PostRefresh(client, Pr1);

        resp.StatusCode.Should().Be(HttpStatusCode.OK, "the committed view advanced past `before`");
    }
}
