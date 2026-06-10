using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Auth;
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
}
