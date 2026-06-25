using System.Net;
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

public class ChecksEndpointTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly WebApplicationFactory<Program> _factory;

    public ChecksEndpointTests(PRismWebApplicationFactory baseFactory)
    {
        // Swap in the fake reader (the validation tests below don't reach it, but the
        // happy-path test does). Mirrors AiFileFocusTestContext's WithWebHostBuilder swap.
        _factory = baseFactory.WithWebHostBuilder(b =>
            b.ConfigureServices(s =>
            {
                s.RemoveAll<IPrChecksReader>();
                s.AddSingleton<IPrChecksReader>(new FakePrChecksReader());
            }));
    }

    private const string Sha = "0123456789abcdef0123456789abcdef01234567";

    [Fact]
    public async Task Returns_checks_for_valid_request()
    {
        var client = _factory.CreateAuthenticatedClient();
        var resp = await client.GetAsync(new Uri($"/api/pr/octo/repo/1/checks?sha={Sha}", UriKind.Relative));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var dto = await resp.Content.ReadFromJsonAsync<ChecksResponseDto>(PRism.Core.Json.JsonSerializerOptionsFactory.Api);
        Assert.Equal(Sha, dto!.HeadSha);
        Assert.NotEmpty(dto.Checks); // FakePrChecksReader returns a fixed mixed list for any ref
    }

    [Fact]
    public async Task Missing_sha_is_422()
    {
        var client = _factory.CreateAuthenticatedClient();
        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/checks", UriKind.Relative));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
    }

    [Fact]
    public async Task Invalid_sha_is_422()
    {
        var client = _factory.CreateAuthenticatedClient();
        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/checks?sha=not-a-sha", UriKind.Relative));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
    }

    [Fact]
    public async Task Invalid_owner_is_422()
    {
        var client = _factory.CreateAuthenticatedClient();
        var resp = await client.GetAsync(new Uri("/api/pr/bad%20owner/repo/1/checks?sha=" + Sha, UriKind.Relative));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
    }
}
