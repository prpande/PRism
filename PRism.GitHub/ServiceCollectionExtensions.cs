using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using PRism.Core;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.Inbox;
using PRism.GitHub.Inbox;

namespace PRism.GitHub;

public static class ServiceCollectionExtensions
{
    /// <summary>
    /// Registers PRism's GitHub adapter: the named <c>github</c> <see cref="HttpClient"/>
    /// (configured against <c>github.host</c>), <see cref="IReviewService"/>, and the four
    /// inbox-pipeline implementations under <c>PRism.GitHub/Inbox/</c>
    /// (<see cref="ISectionQueryRunner"/>, <see cref="IPrEnricher"/>,
    /// <see cref="IAwaitingAuthorFilter"/>, <see cref="ICiFailingDetector"/>).
    /// </summary>
    /// <remarks>
    /// Every component takes a <c>Func&lt;Task&lt;string?&gt;&gt;</c> token reader so that
    /// callers do not capture a stale token at construction time — the closure resolves
    /// against <see cref="ITokenStore"/> on each request.
    /// </remarks>
    public static IServiceCollection AddPrismGitHub(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddHttpClient("github", (sp, client) =>
        {
            var config = sp.GetRequiredService<IConfigStore>();
            client.BaseAddress = HostUrlResolver.ApiBase(config.Current.Github.Host);
        });

        services.AddSingleton<IReviewService>(sp =>
        {
            var config = sp.GetRequiredService<IConfigStore>();
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new GitHubReviewService(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                config.Current.Github.Host,
                sp.GetRequiredService<ILogger<GitHubReviewService>>());
        });

        services.AddSingleton<ISectionQueryRunner>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new GitHubSectionQueryRunner(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                sp.GetRequiredService<ILogger<GitHubSectionQueryRunner>>());
        });

        services.AddSingleton<IPrEnricher>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new GitHubPrEnricher(factory, () => tokens.ReadAsync(CancellationToken.None));
        });

        services.AddSingleton<IAwaitingAuthorFilter>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new GitHubAwaitingAuthorFilter(factory, () => tokens.ReadAsync(CancellationToken.None));
        });

        services.AddSingleton<ICiFailingDetector>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new GitHubCiFailingDetector(factory, () => tokens.ReadAsync(CancellationToken.None));
        });

        return services;
    }
}
