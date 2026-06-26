using System;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Web.TestHooks;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class ChecksRerunEndpointTests : IClassFixture<PRismWebApplicationFactory>
{
    private const string Sha = "0123456789abcdef0123456789abcdef01234567";
    private readonly PRismWebApplicationFactory _base;

    public ChecksRerunEndpointTests(PRismWebApplicationFactory baseFactory) => _base = baseFactory;

    private WebApplicationFactory<Program> FactoryWith(RerunOutcome outcome) =>
        _base.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IPrChecksRerunner>();
            s.AddSingleton<IPrChecksRerunner>(new FakePrChecksRerunner { Outcome = outcome });
        }));

    [Fact]
    public async Task Accepted_outcome_returns_200_with_kebab_body()
    {
        var client = FactoryWith(RerunOutcome.Accepted).CreateAuthenticatedClient();
        var resp = await client.PostAsync(
            new Uri($"/api/pr/octo/repo/1/checks/555/rerun?sha={Sha}", UriKind.Relative), null);

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var dto = await resp.Content.ReadFromJsonAsync<RerunResultDto>(
            PRism.Core.Json.JsonSerializerOptionsFactory.Api);
        Assert.Equal(RerunOutcome.Accepted, dto!.Outcome);

        // kebab wire check — a multi-word outcome serializes hyphenated.
        var raw = await (await FactoryWith(RerunOutcome.NotRerunnable).CreateAuthenticatedClient()
            .PostAsync(new Uri($"/api/pr/octo/repo/1/checks/555/rerun?sha={Sha}", UriKind.Relative), null))
            .Content.ReadAsStringAsync();
        Assert.Contains("not-rerunnable", raw, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-a-sha")]
    public async Task Invalid_sha_returns_422(string sha)
    {
        var client = FactoryWith(RerunOutcome.Accepted).CreateAuthenticatedClient();
        var resp = await client.PostAsync(
            new Uri($"/api/pr/octo/repo/1/checks/555/rerun?sha={sha}", UriKind.Relative), null);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
    }

    [Fact]
    public async Task Invalid_owner_returns_422()
    {
        // A space is outside SharedRegexes.OwnerRepo() (^[A-Za-z0-9_.-]{1,100}$); mirrors the
        // read-path ChecksEndpointTests case. (Dots ARE allowed, so "bad..owner" would NOT 422.)
        var client = FactoryWith(RerunOutcome.Accepted).CreateAuthenticatedClient();
        var resp = await client.PostAsync(
            new Uri($"/api/pr/bad%20owner/repo/1/checks/555/rerun?sha={Sha}", UriKind.Relative), null);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
    }

    [Fact]
    public async Task Unauthenticated_request_is_401()
    {
        // B2 access-control: no session token → SessionTokenMiddleware rejects the write before
        // it reaches the rerunner. A same-origin Origin is supplied so OriginCheckMiddleware passes
        // and the 401 isolates the auth requirement (not a 403 from the Origin gate).
        var client = _base.CreateUnauthenticatedClient();
        using var req = new HttpRequestMessage(
            HttpMethod.Post, $"/api/pr/octo/repo/1/checks/555/rerun?sha={Sha}");
        req.Headers.Add("Origin", client.BaseAddress!.GetLeftPart(UriPartial.Authority));
        var resp = await client.SendAsync(req);
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }
}
