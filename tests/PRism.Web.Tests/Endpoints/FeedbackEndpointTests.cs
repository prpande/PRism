using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using PRism.Core.Feedback;
using PRism.Web.Endpoints;
using PRism.Web.Middleware;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class FeedbackEndpointTests
{
    private sealed class FakeFeedbackSubmitter : IFeedbackSubmitter
    {
        public FeedbackContent? Last { get; private set; }
        public FeedbackCreateResult Result { get; set; } = FeedbackCreateResult.Created(7, "https://x/7");
        public bool Throw { get; set; }
        public Task<FeedbackCreateResult> CreateFeedbackIssueAsync(FeedbackContent content, CancellationToken ct)
        {
            Last = content;
            if (Throw) throw new HttpRequestException("boom", null, HttpStatusCode.InternalServerError);
            return Task.FromResult(Result);
        }
    }

    // Creates a derived factory with the fake submitter substituted, plus an authed client.
    // WithWebHostBuilder returns a plain WebApplicationFactory<Program> that doesn't inherit
    // PRismWebApplicationFactory.ConfigureClient, so session credentials are injected manually
    // (same pattern as PrRootCommentEndpointTests / DiscardTestContext).
    private static (WebApplicationFactory<Program> f, FakeFeedbackSubmitter sub) NewApp()
    {
        var sub = new FakeFeedbackSubmitter();
        var f = new PRismWebApplicationFactory().WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IFeedbackSubmitter>();
            s.AddSingleton<IFeedbackSubmitter>(sub);
        }));
        _ = f.Services; // materialise DI
        return (f, sub);
    }

    private static HttpClient AuthedClient(WebApplicationFactory<Program> f)
    {
        var token = f.Services.GetRequiredService<SessionTokenProvider>().Current;
        var c = f.CreateClient();
        c.DefaultRequestHeaders.Add("X-PRism-Session", token);
        c.DefaultRequestHeaders.Add("Cookie", $"prism-session={token}");
        var origin = c.BaseAddress?.GetLeftPart(UriPartial.Authority);
        if (!string.IsNullOrEmpty(origin))
            c.DefaultRequestHeaders.Add("Origin", origin);
        return c;
    }

    private static object ValidBody() =>
        new { category = "Bug", summary = "It broke", details = "Steps", routePattern = "/inbox", platform = "browser" };

    [Fact]
    public async Task Created_returns_201_with_issue_number_and_stamps_version_and_timestamp()
    {
        var (f, sub) = NewApp();
        sub.Result = FeedbackCreateResult.Created(42, "https://github.com/prpande/PRism-feedback/issues/42");
        using var client = AuthedClient(f);
        var resp = await client.PostAsJsonAsync("/api/feedback", ValidBody());
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
        var dto = await resp.Content.ReadFromJsonAsync<FeedbackResponseDto>();
        dto!.IssueNumber.Should().Be(42);
        sub.Last!.Category.Should().Be("Bug");
        sub.Last!.Version.Should().StartWith("0.2.0");          // stamped server-side
        sub.Last!.SubmittedAt.Should().BeAfter(DateTimeOffset.MinValue); // stamped server-side
    }

    [Fact]
    public async Task CannotCreate_returns_422()
    {
        var (f, sub) = NewApp();
        sub.Result = FeedbackCreateResult.CannotCreate();
        using var client = AuthedClient(f);
        var resp = await client.PostAsJsonAsync("/api/feedback", ValidBody());
        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
    }

    [Fact]
    public async Task Submitter_throw_surfaces_as_500()
    {
        var (f, sub) = NewApp();
        sub.Throw = true;
        using var client = AuthedClient(f);
        var resp = await client.PostAsJsonAsync("/api/feedback", ValidBody());
        resp.StatusCode.Should().Be(HttpStatusCode.InternalServerError);
    }

    [Theory]
    [InlineData("Bug", "  ", "x", "/", "browser")]                    // blank summary
    [InlineData("Banana", "ok", "x", "/", "browser")]                 // bad category
    public async Task Invalid_input_returns_400(string cat, string sum, string det, string route, string plat)
    {
        var (f, _) = NewApp();
        using var client = AuthedClient(f);
        var resp = await client.PostAsJsonAsync("/api/feedback",
            new { category = cat, summary = sum, details = det, routePattern = route, platform = plat });
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // Fix 6 — a POST to /api/feedback without a session token must return 401, pinning
    // that the route is behind SessionTokenMiddleware.
    [Fact]
    public async Task Post_feedback_without_session_returns_401()
    {
        var (f, _) = NewApp();
        // Use Server.CreateClient() directly: CreateClient() on the derived
        // (WithWebHostBuilder) factory does NOT run PRismWebApplicationFactory.ConfigureClient,
        // so it yields a plain client with no X-PRism-Session / prism-session cookie.
        // Origin is required on POST by OriginCheckMiddleware; session header is absent.
        var client = f.Server.CreateClient();
        client.BaseAddress = f.ClientOptions.BaseAddress;
        var origin = client.BaseAddress?.GetLeftPart(UriPartial.Authority);
        if (!string.IsNullOrEmpty(origin))
            client.DefaultRequestHeaders.Add("Origin", origin);
        var resp = await client.PostAsJsonAsync("/api/feedback", ValidBody());
        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // Comment 4: empty htmlUrl must NOT emit a Location header — Results.Created("", …)
    // produces an invalid Location: "" which clients trip on.
    [Fact]
    public async Task Created_with_empty_htmlUrl_returns_201_with_no_Location_header()
    {
        var (f, sub) = NewApp();
        sub.Result = FeedbackCreateResult.Created(99, ""); // htmlUrl intentionally empty
        using var client = AuthedClient(f);
        var resp = await client.PostAsJsonAsync("/api/feedback", ValidBody());
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
        var dto = await resp.Content.ReadFromJsonAsync<FeedbackResponseDto>();
        dto!.IssueNumber.Should().Be(99);
        // No Location header (or null/empty) — invalid empty Location must not be emitted.
        var location = resp.Headers.Location;
        location.Should().BeNull();
    }

    [Fact]
    public async Task Oversize_fields_return_400()
    {
        var (f, _) = NewApp();
        using var client = AuthedClient(f);
        foreach (var body in new object[]
        {
            new { category = "Bug", summary = new string('x', 121), details = "d", routePattern = "/", platform = "b" },
            new { category = "Bug", summary = "ok", details = new string('x', 4001), routePattern = "/", platform = "b" },
            new { category = "Bug", summary = "ok", details = "d", routePattern = new string('x', 257), platform = "b" },
            new { category = "Bug", summary = "ok", details = "d", routePattern = "/", platform = new string('x', 129) },
        })
        {
            var resp = await client.PostAsJsonAsync("/api/feedback", body);
            resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        }
    }
}
