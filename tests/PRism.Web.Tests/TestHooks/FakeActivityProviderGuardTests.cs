using System.IO;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Activity;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.TestHooks;

// Guards that FakeActivityProvider is never injected in Production.
// The positive side (FakeActivityProvider served under Test+PRISM_E2E_FAKE_REVIEW=1)
// is exercised by the frontend Playwright suite; this xUnit test only guards the
// critical negative: the real ActivityProvider resolves in Production.
public sealed class FakeActivityProviderGuardTests
{
    [Fact]
    public void Production_resolves_real_ActivityProvider_not_fake()
    {
        // Each test run needs a private DataDir so the LockfileManager (which runs in
        // non-Test environments) writes to an isolated path and never collides with a
        // running dev server or a parallel test.
        var dataDir = TempDataDir.Create("PRism-prod-guard");
        Directory.CreateDirectory(dataDir);
        try
        {
            using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
            {
                b.UseEnvironment("Production");
                b.UseSetting("DataDir", dataDir);
            });
            using var scope = factory.Services.CreateScope();
            var provider = scope.ServiceProvider.GetRequiredService<IActivityProvider>();
            provider.Should().BeOfType<ActivityProvider>();
        }
        finally
        {
#pragma warning disable CA1031 // best-effort cleanup of temp dir
            try { Directory.Delete(dataDir, recursive: true); } catch { }
#pragma warning restore CA1031
        }
    }
}
