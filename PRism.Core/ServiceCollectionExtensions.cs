using System.Diagnostics.CodeAnalysis;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using PRism.Core.Ai;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.Iterations;
using PRism.Core.PrDetail;
using PRism.Core.State;

namespace PRism.Core;

public static class ServiceCollectionExtensions
{
    /// <summary>
    /// Registers the PRism.Core services that are independent of the GitHub adapter and the AI
    /// seam selection: persistent stores (config, app state, tokens), the inbox refresh
    /// pipeline (orchestrator, deduplicator, subscriber-count, poller), the review event bus,
    /// the viewer-login cache and its hydrator, and <see cref="AiModeState"/> (which mirrors
    /// the live <c>ui.ai.mode</c> config value for the selector to read).
    /// </summary>
    /// <remarks>
    /// <para>
    /// Registration order is load-bearing: <see cref="ViewerLoginHydrator"/> must be added as
    /// an <see cref="Microsoft.Extensions.Hosting.IHostedService"/> BEFORE <see cref="InboxPoller"/>
    /// because <c>StartAsync</c> runs in registration order and the poller's first refresh tick
    /// needs the viewer-login cache populated. The same invariant held in the original
    /// inline-DI shape in <c>Program.cs</c>.
    /// </para>
    /// <para>
    /// <b>Required companion calls.</b> <see cref="IInboxRefreshOrchestrator"/> and
    /// <see cref="ViewerLoginHydrator"/> are registered here via factory lambdas that close
    /// over <see cref="IServiceProvider"/> and resolve services registered by other
    /// <c>AddPrism*</c> extensions: <c>IReviewAuth</c>, <c>ISectionQueryRunner</c>,
    /// <c>IPrEnricher</c>, <c>IAwaitingAuthorFilter</c>, <c>ICiFailingDetector</c> (all from
    /// <c>AddPrismGitHub</c>) and <c>IAiSeamSelector</c> (from <c>AddPrismAi</c>). DI
    /// factories are lazy, so the cross-method dependencies only resolve at first use after
    /// <c>Build()</c>; the missing dependency would surface as an <see cref="InvalidOperationException"/>
    /// at host startup, not at <c>AddPrismCore</c> call time. <b>Callers must invoke
    /// <c>AddPrismGitHub</c> and <c>AddPrismAi</c> before <c>Build()</c>.</b>
    /// </para>
    /// </remarks>
    public static IServiceCollection AddPrismCore(
        this IServiceCollection services,
        string dataDir,
        bool useUnprotectedTokenCache = false)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentException.ThrowIfNullOrEmpty(dataDir);

        services.AddSingleton<IConfigStore>(_ => CreateConfigStore(dataDir));
        services.AddSingleton<AiModeState>(sp =>
        {
            var config = sp.GetRequiredService<IConfigStore>();
            var state = new AiModeState { Mode = config.Current.Ui.Ai.Mode };
            config.Changed += (_, args) => state.Mode = args.Config.Ui.Ai.Mode;
            return state;
        });
        services.AddSingleton<AiConsentState>(sp =>
        {
            var config = sp.GetRequiredService<IConfigStore>();
            var state = new AiConsentState();
            state.Set(config.Current.Ui.Ai.Consent);
            config.Changed += (_, args) => state.Set(args.Config.Ui.Ai.Consent);
            return state;
        });
        services.AddSingleton<AiFeatureState>(sp =>
        {
            var config = sp.GetRequiredService<IConfigStore>();
            var state = new AiFeatureState(config.Current.Ui.Ai.Features);
            config.Changed += (_, args) => state.Set(args.Config.Ui.Ai.Features);
            return state;
        });
        services.AddSingleton<IAppStateStore>(_ => new AppStateStore(dataDir));
        // In the e2e Test backend, persist tokens to an unprotected file instead
        // of the OS keyring. The browser e2e runs in a headless Linux container
        // which has no D-Bus/X11, so MSAL's Linux keyring throws "Cannot
        // autolaunch D-Bus without X11 $DISPLAY" and every auth-dependent spec
        // times out. The e2e DataDir is ephemeral, so plaintext is fine.
        //
        // The decision is made by the caller (Program.cs composition root, where
        // IHostEnvironment is available) and gated on Test env AND a PRISM_E2E_*
        // var — the same condition Program.cs uses for UseStaticWebAssets and the
        // fake/real-inject seams. Defaulting to false here means production (and
        // any caller that doesn't opt in) always gets the encrypted OS keychain,
        // even if a PRISM_E2E_* var is set outside a Test environment.
        services.AddSingleton<ITokenStore>(_ => new TokenStore(dataDir, useUnprotectedTokenCache));
        services.AddSingleton<IViewerLoginProvider, ViewerLoginProvider>();

        services.AddSingleton<IReviewEventBus, ReviewEventBus>();
        services.AddSingleton<InboxSubscriberCount>();
        services.AddSingleton<IInboxDeduplicator, InboxDeduplicator>();
        services.AddSingleton<IInboxRefreshOrchestrator>(sp =>
        {
            var loginCache = sp.GetRequiredService<IViewerLoginProvider>();
            return new InboxRefreshOrchestrator(
                sp.GetRequiredService<IConfigStore>(),
                sp.GetRequiredService<ISectionQueryRunner>(),
                sp.GetRequiredService<IPrEnricher>(),
                sp.GetRequiredService<IAwaitingAuthorFilter>(),
                sp.GetRequiredService<ICiFailingDetector>(),
                sp.GetRequiredService<IInboxDeduplicator>(),
                sp.GetRequiredService<IAiSeamSelector>(),
                sp.GetRequiredService<IReviewEventBus>(),
                sp.GetRequiredService<IAppStateStore>(),
                loginCache.Get,
                sp.GetRequiredService<ILogger<InboxRefreshOrchestrator>>());
        });

        // Hydrate viewer-login from a previously stored token before InboxPoller starts.
        // IHostedService.StartAsync runs in registration order — this MUST come before the poller.
        services.AddHostedService<ViewerLoginHydrator>(sp =>
            new ViewerLoginHydrator(
                sp.GetRequiredService<ITokenStore>(),
                sp.GetRequiredService<IReviewAuth>(),
                sp.GetRequiredService<IViewerLoginProvider>(),
                sp.GetRequiredService<IConfigStore>(),
                sp.GetRequiredService<ILogger<ViewerLoginHydrator>>()));

        // Register InboxPoller as a concrete singleton AND as the IHostedService that
        // ASP.NET starts. The /api/auth/replace endpoint (S6 PR2) resolves the concrete
        // type to call RequestImmediateRefresh(); without this two-line pattern,
        // resolving InboxPoller from the container would throw at request time.
        services.AddSingleton<InboxPoller>(sp =>
            new InboxPoller(
                sp.GetRequiredService<IInboxRefreshOrchestrator>(),
                sp.GetRequiredService<InboxSubscriberCount>(),
                sp.GetRequiredService<IConfigStore>(),
                sp.GetRequiredService<ILogger<InboxPoller>>()));
        services.AddHostedService(sp => sp.GetRequiredService<InboxPoller>());

        // S3 PR4 — iteration clustering + PrDetailLoader. Coefficients default to the values
        // recorded in IterationClusteringCoefficients's record-init defaults. Calibration
        // hot-reload via config is post-PoC scope; today the coefficients are constant
        // per process lifetime.
        services.AddSingleton<IDistanceMultiplier, FileJaccardMultiplier>();
        services.AddSingleton<IDistanceMultiplier, ForcePushMultiplier>();
        services.AddSingleton<IIterationClusteringStrategy>(sp =>
            new WeightedDistanceClusteringStrategy(sp.GetServices<IDistanceMultiplier>()));
        services.AddSingleton(new IterationClusteringCoefficients());
        services.AddSingleton<PrDetailLoader>();

        // S3 PR5 — active-PR subscription registry + per-PR poller. Registry is a
        // simple in-memory map; the poller is a BackgroundService that ticks every 30s
        // and publishes ActivePrUpdated to the bus when head SHA or comment count
        // changes. Per-PR backoff isolates flaky PRs from healthy ones (spec § 6.2).
        services.AddSingleton<ActivePrSubscriberRegistry>();
        services.AddSingleton<IActivePrCache, ActivePrCache>();
        services.AddHostedService<ActivePrPoller>();

        return services;
    }

    [SuppressMessage("Performance", "CA1849:Call async methods when in an async method",
        Justification = "DI factory delegates are synchronous; ConfigStore.InitAsync is awaited via GetAwaiter().GetResult() at host startup, which is the documented pattern for one-time async initialization inside a sync DI factory. Replacement with IHostedService is gated to ADR-P0-3 in the architectural-readiness spec.")]
    private static ConfigStore CreateConfigStore(string dataDir)
    {
        var store = new ConfigStore(dataDir);
        store.InitAsync(CancellationToken.None).GetAwaiter().GetResult();
        return store;
    }
}
