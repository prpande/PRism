using System.Net;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

// #321 PR2 security AC: GitHubGraphQL.PostAsync must route through GitHubHttp.SendAsync so the
// same-host PAT guard (GitHubHttp.ApplyHeaders) stays in the call chain — the Bearer token is
// attached on the trusted host and refused on an off-host absolute endpoint. The verification
// grep proves no bare http.SendAsync exists; this test proves the resulting behaviour.
public class GitHubGraphQLAuthHeaderTests
{
    private sealed class CapturingHandler : HttpMessageHandler
    {
        public HttpRequestMessage? Last;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Last = request;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            { Content = new StringContent("""{"data":{}}""") });
        }
    }

    [Fact]
    public async Task PostAsync_AttachesBearerToken_OnTrustedHost()
    {
        var handler = new CapturingHandler();
        var http = new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")).CreateClient("github");

        await GitHubGraphQL.PostAsync(http, "ghp_test", "https://github.com",
            NullLogger.Instance, "query{viewer{login}}", new { }, CancellationToken.None);

        handler.Last!.Headers.Authorization!.Parameter.Should().Be("ghp_test");
        handler.Last.RequestUri!.ToString().Should().Be("https://api.github.com/graphql");
    }

    [Fact]
    public async Task PostAsync_RefusesToken_WhenHostResolvesOffBaseAddress()
    {
        // BaseAddress is api.github.com, but GraphQlEndpoint("https://evil.example.com") resolves to
        // https://evil.example.com/api/graphql — host does NOT match the trusted BaseAddress, so the
        // guard must throw rather than leak the PAT to the off-host endpoint.
        var handler = new CapturingHandler();
        var http = new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")).CreateClient("github");

        Func<Task> act = () => GitHubGraphQL.PostAsync(http, "ghp_test", "https://evil.example.com",
            NullLogger.Instance, "query{viewer{login}}", new { }, CancellationToken.None);

        await act.Should().ThrowAsync<HttpRequestException>();
        // The guard throws inside GitHubHttp.ApplyHeaders, before http.SendAsync — so no request
        // ever reaches the handler. Assert handler.Last is null (no PAT escaped) rather than the
        // vacuous handler.Last?.…Authorization which short-circuits to satisfied when Last is null.
        handler.Last.Should().BeNull();
    }
}
