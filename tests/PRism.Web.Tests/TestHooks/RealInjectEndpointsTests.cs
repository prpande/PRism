using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using PRism.Web.TestHooks;
using Xunit;

namespace PRism.Web.Tests.TestHooks;

// [Collection] MUST be on the test class, not on RealInjectAppFactory below — xUnit only
// honours [Collection] on classes it discovers as test classes (those with [Fact]/[Theory]).
// Placing it on the fixture is silent no-op, leaving the env-var race with ProgramMutexCheckTests
// unaddressed despite the comment in the factory claiming serialization.
[Collection("EnvVarMutating")]
public class RealInjectEndpointsTests : IClassFixture<RealInjectAppFactory>
{
    private readonly RealInjectAppFactory _factory;
    public RealInjectEndpointsTests(RealInjectAppFactory factory) => _factory = factory;

    [Fact]
    public async Task PostInjectFailure_WhenGateEngaged_ArmsInjector()
    {
        using var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("Origin", _factory.Server.BaseAddress!.ToString().TrimEnd('/'));

        var resp = await client.PostAsJsonAsync("/test/real-inject/inject-failure", new
        {
            graphQLFieldName = "addPullRequestReviewThread",
            afterEffect = true,
            message = "simulated post-effect",
        });

        Assert.True(resp.IsSuccessStatusCode, $"status={resp.StatusCode} body={await resp.Content.ReadAsStringAsync()}");

        var injector = _factory.Services.GetRequiredService<RealTransportFailureInjector>();
        Assert.True(injector.TryConsume("addPullRequestReviewThread", afterEffectWanted: true, out _));
    }

    [Fact]
    public async Task PostInjectFailure_WhenFieldNameMissing_Returns400()
    {
        using var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("Origin", _factory.Server.BaseAddress!.ToString().TrimEnd('/'));

        var resp = await client.PostAsJsonAsync("/test/real-inject/inject-failure", new
        {
            afterEffect = true,
            message = "simulated",
        });
        Assert.Equal(System.Net.HttpStatusCode.BadRequest, resp.StatusCode);
    }
}

// WebApplicationFactory that turns ON Test env + REAL_INJECT for these tests. The env-var-driven
// gate in Program.cs reads at startup, so we set the var BEFORE the factory creates the host.
//
// CRITICAL: per-test DataDir isolation. Without UseSetting("DataDir", …) the host falls back to
// %LOCALAPPDATA%/PRism on the developer's machine and the test mutates the developer's live
// state.json. See the existing PRismWebApplicationFactory.cs for the established pattern.
//
// Env-var mutation is process-wide; xUnit parallelizes test classes by default. The
// EnvVarMutating collection (see Collections.cs) serializes the env-touching tests so they
// don't race with one another. [Collection("EnvVarMutating")] is set on the TEST CLASS above
// (RealInjectEndpointsTests) — xUnit's collection attribute is a no-op on fixture classes.
public sealed class RealInjectAppFactory : WebApplicationFactory<Program>
{
    private readonly string _dataDir;

    public RealInjectAppFactory()
    {
        _dataDir = Path.Combine(Path.GetTempPath(), $"PRism-real-inject-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_dataDir);
        Environment.SetEnvironmentVariable("PRISM_E2E_REAL_INJECT", "1");
    }

    protected override IHostBuilder? CreateHostBuilder()
    {
        var builder = base.CreateHostBuilder();
        builder?.UseEnvironment("Test");
        builder?.ConfigureWebHost(b => b.UseSetting("DataDir", _dataDir));
        return builder;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            Environment.SetEnvironmentVariable("PRISM_E2E_REAL_INJECT", null);
#pragma warning disable CA1031 // best-effort cleanup of temp dir; matches PRismWebApplicationFactory.Dispose
            try { Directory.Delete(_dataDir, recursive: true); } catch { }
#pragma warning restore CA1031
        }
        base.Dispose(disposing);
    }
}
