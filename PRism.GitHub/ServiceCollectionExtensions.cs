using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using PRism.Core;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.Feedback;
using PRism.Core.Inbox;
using PRism.GitHub.Feedback;
using PRism.GitHub.Inbox;

namespace PRism.GitHub;

public static class ServiceCollectionExtensions
{
    /// <summary>
    /// Registers PRism's GitHub adapter: the named <c>github</c> <see cref="HttpClient"/>
    /// (configured against <c>github.host</c>), <see cref="GitHubReviewService"/> bound to the
    /// four capability interfaces (<see cref="IReviewAuth"/>, <see cref="IPrDiscovery"/>,
    /// <see cref="IPrReader"/>, <see cref="IReviewSubmitter"/> — one shared singleton instance),
    /// and the four inbox-pipeline implementations under <c>PRism.GitHub/Inbox/</c>
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

        services.AddSingleton<IGitHubCredentialHealth, GitHubCredentialHealth>();
        services.AddTransient<GitHubAuthHealthHandler>();

        services.AddHttpClient("github", (sp, client) =>
        {
            var config = sp.GetRequiredService<IConfigStore>();
            client.BaseAddress = HostUrlResolver.ApiBase(config.Current.Github.Host);
        })
        .AddHttpMessageHandler<GitHubAuthHealthHandler>();

        // GitHubReviewService implements all four capability interfaces (ADR-S5-1). Register
        // the concrete type once and bind each interface to that shared singleton so a single
        // instance backs auth, discovery, read, and submit.
        services.AddSingleton<GitHubReviewService>(sp =>
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
        services.AddSingleton<IReviewAuth>(sp => sp.GetRequiredService<GitHubReviewService>());
        services.AddSingleton<IPrDiscovery>(sp => sp.GetRequiredService<GitHubReviewService>());
        services.AddSingleton<IPrReader>(sp => sp.GetRequiredService<GitHubReviewService>());
        services.AddSingleton<IReviewSubmitter>(sp => sp.GetRequiredService<GitHubReviewService>());

        services.AddSingleton<ISectionQueryRunner>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new GitHubSectionQueryRunner(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                () => DateTimeOffset.UtcNow,
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

        services.AddSingleton<PRism.Core.Activity.IReceivedEventsReader>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var viewerLogin = sp.GetRequiredService<IViewerLoginProvider>();   // live SSOT login cache
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new PRism.GitHub.Activity.GitHubReceivedEventsReader(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                () => Task.FromResult(viewerLogin.Get() is { Length: > 0 } l ? l : null));
        });

        // Feedback always targets github.com (the feedback repo lives there),
        // independent of the user's configured host (§4.1).
        services.AddHttpClient(GitHubFeedbackSubmitter.ClientName, client =>
        {
            client.BaseAddress = new Uri("https://api.github.com/");
        });

        services.AddSingleton<IFeedbackSubmitter>(sp =>
        {
            var config = sp.GetRequiredService<IConfigStore>();
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            // Late-bind the configured host (Func<string?>) so a live config change
            // (github.com → GHES) takes effect immediately without restart — matches
            // the late-binding pattern used for the token reader. A stale early-bound
            // host could let a GHES PAT reach api.github.com after a host change.
            return new GitHubFeedbackSubmitter(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                () => config.Current.Github.Host);
        });

        return services;
    }
}
