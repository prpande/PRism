using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Auth;
using PRism.Core.Time;
using PRism.GitHub;
using Xunit;

namespace PRism.GitHub.Tests;

public class ServiceRegistrationTests
{
    [Fact]
    public void RegistersCredentialHealthSingleton()
    {
        var services = new ServiceCollection();
        services.AddPrismGitHub();
        using var sp = services.BuildServiceProvider();

        var a = sp.GetRequiredService<IGitHubCredentialHealth>();
        var b = sp.GetRequiredService<IGitHubCredentialHealth>();
        Assert.Same(a, b); // singleton
        Assert.NotNull(sp.GetRequiredService<GitHubAuthHealthHandler>());
    }

    [Fact]
    public void Registers_IClock_as_SystemClock()
    {
        // Guards the CI-cache TTL wiring (#361): the ICiFailingDetector factory resolves
        // GetRequiredService<IClock>(), which throws unless TryAddSingleton<IClock, SystemClock>()
        // ran. The factory passing the clock to the ctor is compile-checked, so asserting the
        // registration is the minimal sufficient guard (no ITokenStore stub needed).
        var services = new ServiceCollection();
        services.AddPrismGitHub();
        using var sp = services.BuildServiceProvider();

        Assert.IsType<SystemClock>(sp.GetRequiredService<IClock>());
    }
}
