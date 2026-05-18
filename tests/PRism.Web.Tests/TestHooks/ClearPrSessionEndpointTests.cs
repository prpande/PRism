using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using PRism.Core.State;
using Xunit;

namespace PRism.Web.Tests.TestHooks;

public class ClearPrSessionEndpointTests
{
    [Fact]
    public async Task ClearPrSession_NukesSession_AndRemovesSubscribers()
    {
        using var factory = new TestEnvAppFactory();
        using var scope = factory.Services.CreateScope();
        var stateStore = scope.ServiceProvider.GetRequiredService<IAppStateStore>();
        var registry = scope.ServiceProvider.GetRequiredService<ActivePrSubscriberRegistry>();

        // Pre-arrange: write a session for acme/api/123 with stamped LastViewedHeadSha, register a subscriber.
        var prRef = new PrReference("acme", "api", 123);
        await stateStore.UpdateAsync(state =>
        {
            var session = new ReviewSessionState(
                LastViewedHeadSha: "abc123",
                LastSeenCommentId: null,
                PendingReviewId: "PRR_x",
                PendingReviewCommitOid: "abc123",
                ViewedFiles: new Dictionary<string, string>(),
                DraftComments: new List<DraftComment>(),
                DraftReplies: new List<DraftReply>(),
                DraftSummaryMarkdown: null,
                DraftVerdict: null,
                DraftVerdictStatus: DraftVerdictStatus.Draft);
            var sessions = new Dictionary<string, ReviewSessionState> { ["acme/api/123"] = session };
            return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
        }, CancellationToken.None);
        registry.Add("test-subscriber-1", prRef);

        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("Origin", factory.Server.BaseAddress!.ToString().TrimEnd('/'));

        var resp = await client.PostAsJsonAsync("/test/clear-pr-session", new
        {
            owner = "acme",
            repo = "api",
            number = 123,
        });

        Assert.Equal(System.Net.HttpStatusCode.NoContent, resp.StatusCode);

        var after = await stateStore.LoadAsync(CancellationToken.None);
        Assert.False(after.Reviews.Sessions.ContainsKey("acme/api/123"));
        Assert.Empty(registry.SubscribersFor(prRef));
    }
}

// Minimal Test-environment WebApplicationFactory. We do NOT set PRISM_E2E_REAL_INJECT or
// PRISM_E2E_FAKE_REVIEW — /test/clear-pr-session is gated only on `IHostEnvironment.IsEnvironment("Test")`
// and depends on IAppStateStore + ActivePrSubscriberRegistry, both of which are registered in
// every PRism.Web composition (no fake-swap required).
//
// Per-test DataDir isolation: without `UseSetting("DataDir", …)` the host falls back to
// %LOCALAPPDATA%/PRism on the developer's machine and the test would mutate live state.json.
// Matches the established PRismWebApplicationFactory.cs pattern.
//
// NB: Uses the ConfigureWebHost(IWebHostBuilder) override (not the CreateHostBuilder
// pattern used by RealInjectAppFactory). With .NET 6+ minimal hosting in Program.cs, the
// default CreateHostBuilder() returns null and a `builder?.UseEnvironment("Test")` is a
// silent no-op — the endpoint then leaks into the SPA fallback at 405. ConfigureWebHost
// is the canonical extension point that always fires on WebApplicationFactory.
internal sealed class TestEnvAppFactory : WebApplicationFactory<Program>
{
    private readonly string _dataDir;

    public TestEnvAppFactory()
    {
        _dataDir = Path.Combine(Path.GetTempPath(), $"PRism-clear-prsess-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_dataDir);
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.UseEnvironment("Test");
        builder.UseSetting("DataDir", _dataDir);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
#pragma warning disable CA1031 // best-effort cleanup of temp dir; matches PRismWebApplicationFactory.Dispose
            try { Directory.Delete(_dataDir, recursive: true); } catch { }
#pragma warning restore CA1031
        }
        base.Dispose(disposing);
    }
}
