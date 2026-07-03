using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using PRism.Core;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.Feedback;
using PRism.Core.Inbox;
using PRism.Core.Time;
using PRism.GitHub.Feedback;
using PRism.GitHub.Inbox;

namespace PRism.GitHub;

public static class ServiceCollectionExtensions
{
    /// <summary>
    /// Registers PRism's GitHub adapter: the named <c>github</c> <see cref="HttpClient"/>
    /// (configured against <c>github.host</c>), <see cref="GitHubAuthValidator"/> bound to
    /// <see cref="IReviewAuth"/>, <see cref="GitHubReviewService"/> bound to the Reader+Discovery
    /// pairing (<see cref="IPrDiscovery"/>, <see cref="IPrReader"/> — one shared singleton),
    /// <see cref="GitHubReviewSubmitter"/> bound to <see cref="IReviewSubmitter"/> (#321 PR2 split),
    /// and the three inbox-pipeline implementations under <c>PRism.GitHub/Inbox/</c>
    /// (<see cref="ISectionQueryRunner"/>, <see cref="IPrBatchReader"/>,
    /// <see cref="ICiFailingDetector"/>).
    /// </summary>
    /// <remarks>
    /// Every component takes a <c>Func&lt;Task&lt;string?&gt;&gt;</c> token reader so that
    /// callers do not capture a stale token at construction time — the closure resolves
    /// against <see cref="ITokenStore"/> on each request.
    /// </remarks>
    public static IServiceCollection AddPrismGitHub(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        // The wall-clock seam for the CI cache TTL (#361). TryAdd so a future composition-root
        // registration of IClock (e.g. for the active-PR poller) does not collide.
        services.TryAddSingleton<IClock, SystemClock>();

        services.AddSingleton<IGitHubCredentialHealth, GitHubCredentialHealth>();
        services.AddTransient<GitHubAuthHealthHandler>();

        services.AddHttpClient("github", (sp, client) =>
        {
            var config = sp.GetRequiredService<IConfigStore>();
            client.BaseAddress = HostUrlResolver.ApiBase(config.Current.Github.Host);
        })
        .AddHttpMessageHandler<GitHubAuthHealthHandler>();

        // GitHubReviewService is the Reader+Discovery pairing (ADR-S5-1; IReviewAuth was split out
        // to GitHubAuthValidator in #321 PR1, IReviewSubmitter to GitHubReviewSubmitter in #321 PR2).
        // Register the concrete type once and alias IPrDiscovery + IPrReader to that shared singleton
        // so one instance backs both discovery and read.
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
        // IReviewAuth is backed by its own GitHubAuthValidator (split out of GitHubReviewService
        // in #321 PR1) — the auth/scope path shares no state with the read/submit paths.
        services.AddSingleton<IReviewAuth>(sp =>
        {
            var config = sp.GetRequiredService<IConfigStore>();
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new GitHubAuthValidator(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                config.Current.Github.Host);
        });
        services.AddSingleton<IPrDiscovery>(sp => sp.GetRequiredService<GitHubReviewService>());
        services.AddSingleton<IPrReader>(sp => sp.GetRequiredService<GitHubReviewService>());
        // IReviewSubmitter is backed by its own GitHubReviewSubmitter (split out of
        // GitHubReviewService in #321 PR2) — single-capability class. Same late-bound host + token
        // closure as the reader registration; the submit path shares no mutable state with read.
        services.AddSingleton<IReviewSubmitter>(sp =>
        {
            var config = sp.GetRequiredService<IConfigStore>();
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new GitHubReviewSubmitter(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                config.Current.Github.Host,
                sp.GetRequiredService<ILogger<GitHubReviewSubmitter>>());
        });

        // #566 — IPrLifecycleWriter (close/reopen/draft toggles). Host captured eagerly at registration
        // (matches GitHubReviewSubmitter precedent); token is late-bound via the () => tokens.ReadAsync(...) closure.
        services.AddSingleton<IPrLifecycleWriter>(sp =>
        {
            var config = sp.GetRequiredService<IConfigStore>();
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new GitHubPrLifecycleWriter(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                config.Current.Github.Host,
                sp.GetRequiredService<ILogger<GitHubPrLifecycleWriter>>());
        });

        // #571 — IReviewThreadWriter (resolve/unresolve review threads). GraphQL-only; host captured
        // eagerly, token late-bound — matches the IPrLifecycleWriter precedent above.
        services.AddSingleton<IReviewThreadWriter>(sp =>
        {
            var config = sp.GetRequiredService<IConfigStore>();
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new GitHubReviewThreadWriter(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                config.Current.Github.Host,
                sp.GetRequiredService<ILogger<GitHubReviewThreadWriter>>());
        });

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

        // Batched GraphQL inbox hydration + awaiting-author reviews (#532). Late-bound host
        // (Func<string>) to build the absolute GraphQL endpoint, exactly like the timeline reader.
        services.AddSingleton<IPrBatchReader>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            var config = sp.GetRequiredService<IConfigStore>();
            return new GitHubPrBatchReader(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                () => config.Current.Github.Host,
                sp.GetRequiredService<ILogger<GitHubPrBatchReader>>());
        });

        // Batched GraphQL active-PR poll reader (#598 Slice B). Interface in PRism.Core.PrDetail;
        // implementation in PRism.GitHub.ActivePr. The host closure reads config.Current at call
        // time (hot-reloadable host) — matches the IPrBatchReader registration above.
        services.AddSingleton<PRism.Core.PrDetail.IActivePrBatchReader>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            var config = sp.GetRequiredService<IConfigStore>();
            return new PRism.GitHub.ActivePr.GitHubActivePrBatchReader(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                () => config.Current.Github.Host,
                sp.GetRequiredService<ILogger<PRism.GitHub.ActivePr.GitHubActivePrBatchReader>>());
        });

        services.AddSingleton<ICiFailingDetector>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new GitHubCiFailingDetector(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                sp.GetRequiredService<IClock>());
        });

        services.AddSingleton<IPrChecksReader>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new GitHubPrChecksReader(
                factory,
                () => tokens.ReadAsync(CancellationToken.None));
        });

        // Write path for the Checks-tab Re-run action (#636). Same token-closure shape as the
        // reader above; owns its status→RerunOutcome map (do NOT reuse the reader's DegradedFor).
        services.AddSingleton<IPrChecksRerunner>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new GitHubPrChecksRerunner(
                factory,
                () => tokens.ReadAsync(CancellationToken.None));
        });

        services.AddSingleton<PRism.Core.Activity.IReceivedEventsReader>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var viewerLogin = sp.GetRequiredService<IViewerLoginProvider>();   // live SSOT login cache
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new PRism.GitHub.Activity.GitHubReceivedEventsReader(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                () => Task.FromResult(viewerLogin.Get() is { Length: > 0 } l ? l : null),
                sp.GetService<ILogger<PRism.GitHub.Activity.GitHubReceivedEventsReader>>());
        });

        // P2 activity readers. Both endpoints (notifications, user/subscriptions) are
        // self-scoped to the authenticated viewer, so — unlike GitHubReceivedEventsReader
        // — they need no readLogin Func: just the named "github" client + the late-bound
        // token reader, mirroring the received-events registration above.
        services.AddSingleton<PRism.Core.Activity.INotificationsReader>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new PRism.GitHub.Activity.GitHubNotificationsReader(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                sp.GetService<ILogger<PRism.GitHub.Activity.GitHubNotificationsReader>>());
        });

        services.AddSingleton<PRism.Core.Activity.IWatchedReposReader>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new PRism.GitHub.Activity.GitHubWatchedReposReader(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                sp.GetService<ILogger<PRism.GitHub.Activity.GitHubWatchedReposReader>>());
        });

        // Activity-rail enrichment: batched GraphQL timeline reader. Needs the host late-bound
        // (Func<string>) to build the absolute GraphQL endpoint — same late-binding rationale as
        // the feedback submitter, so a github.com → GHES host change takes effect without restart.
        services.AddSingleton<PRism.Core.Activity.IPrTimelineReader>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            var config = sp.GetRequiredService<IConfigStore>();
            return new PRism.GitHub.Activity.GitHubPrTimelineReader(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                () => config.Current.Github.Host);
        });

        // PR-detail full activity feed (#620): single-PR paginated timeline reader. Same
        // late-bound token/host seam as the activity-rail reader above, so a github.com → GHES
        // host change takes effect without restart.
        services.AddSingleton<PRism.Core.Activity.IPrTimelineFeedReader>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            var config = sp.GetRequiredService<IConfigStore>();
            return new PRism.GitHub.Activity.GitHubPrTimelineFeedReader(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                () => config.Current.Github.Host);
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
