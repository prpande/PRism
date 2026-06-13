using System.Net;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Auth;
using PRism.GitHub;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceValidateSkipTests
{
    [Fact]
    public async Task Validate_WithSkip_DoesNotLatch()
    {
        var (svc, health) = Build(HttpStatusCode.Unauthorized, token: "ghp_bad");
        await svc.ValidateCredentialsAsync(CancellationToken.None, skipCredentialHealth: true);
        await svc.ValidateCredentialsAsync(CancellationToken.None, skipCredentialHealth: true);
        Assert.False(health.IsInvalid);
    }

    [Fact]
    public async Task Validate_WithoutSkip_LatchesAfterTwo()
    {
        var (svc, health) = Build(HttpStatusCode.Unauthorized, token: "ghp_bad");
        await svc.ValidateCredentialsAsync(CancellationToken.None, skipCredentialHealth: false);
        await svc.ValidateCredentialsAsync(CancellationToken.None, skipCredentialHealth: false);
        Assert.True(health.IsInvalid);
    }

    private static (GitHubAuthValidator, IGitHubCredentialHealth) Build(HttpStatusCode status, string token)
    {
        var health = new GitHubCredentialHealth();
        var services = new ServiceCollection();
        services.AddSingleton<IGitHubCredentialHealth>(health);
        services.AddTransient<GitHubAuthHealthHandler>();
        services.AddHttpClient("github", c => c.BaseAddress = new Uri("https://api.github.com/"))
            .AddHttpMessageHandler<GitHubAuthHealthHandler>()
            .AddHttpMessageHandler(() => new FixedStatusHandler(status));
        var sp = services.BuildServiceProvider();
        var factory = sp.GetRequiredService<IHttpClientFactory>();
        var svc = new GitHubAuthValidator(factory, () => Task.FromResult<string?>(token), "github.com");
        return (svc, health);
    }

    private sealed class FixedStatusHandler : DelegatingHandler
    {
        private readonly HttpStatusCode _status;
        public FixedStatusHandler(HttpStatusCode status) => _status = status;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct)
            => Task.FromResult(new HttpResponseMessage(_status));
    }
}
