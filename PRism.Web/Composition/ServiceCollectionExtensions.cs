using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts;
using PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Observability;
using PRism.AI.Contracts.Provider;
using PRism.AI.Contracts.Seams;
using PRism.AI.Placeholder;
using PRism.Core.Ai;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Json;
using PRism.Core.PrDetail;
using PRism.Web.Ai;
using PRism.Web.Logging;
using PRism.Web.Sse;

namespace PRism.Web.Composition;

internal static class ServiceCollectionExtensions
{
    /// <summary>
    /// Composes PRism's AI seam machinery for the web host. Registers both Noop and
    /// Placeholder impl sets and the <see cref="IAiSeamSelector"/> that does tri-state per-feature
    /// resolution off <see cref="AiModeState"/> (Off→Noop, Preview→Placeholder,
    /// Live→real-iff-registered-and-available), which mirrors the live <c>ui.ai.mode</c> config
    /// value, hot-reloaded by <c>ConfigStore</c>.
    /// </summary>
    /// <remarks>
    /// The "AddPrismAi belongs in Web" carve-out is documented in
    /// <c>docs/specs/2026-05-06-architectural-readiness-design.md</c> § PR 2:
    /// the principle "each project owns its own <c>AddPrism*</c>" applies cleanly when a
    /// project has one canonical impl set. For AI, two parallel impl sets are selected at
    /// runtime by environment (config flag), not by contract — so composition lives in Web,
    /// and registration of each set lives in its own project (<see cref="AddNoopSeams"/> in
    /// <c>PRism.AI.Contracts</c>, <see cref="AddPlaceholderSeams"/> in
    /// <c>PRism.AI.Placeholder</c>).
    /// </remarks>
    public static IServiceCollection AddPrismAi(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddNoopSeams();
        services.AddPlaceholderSeams();

        // AI audit log (metadata only): one JSONL line per AI seam invocation, tagged with the
        // triggering component, written to a dedicated ai-interactions.log in the logs dir. TryAdd so
        // a test can substitute a fake. LogsPathInfo is registered in Program.cs before AddPrismAi, so
        // the sink derives its file path from the same logs dir as the structured app log.
        services.TryAddSingleton<IAiInteractionLog>(sp =>
            new JsonlAiInteractionLog(
                sp.GetRequiredService<LogsPathInfo>().Path,
                TimeProvider.System,
                sp.GetRequiredService<ILogger<JsonlAiInteractionLog>>()));

        // Wrap the ILlmAvailabilityProbe registered by AddPrismClaudeCode with a short-TTL
        // cache (KTD-6). Live mode is FE-reachable this slice; useCapabilities refetches on
        // every window focus — an uncached ~10 s probe would spawn a claude subprocess per
        // focus. The concrete type is resolvable because AddPrismClaudeCode registers it by
        // both ClaudeCodeAvailabilityProbe AND ILlmAvailabilityProbe.
        // Note: PRismWebApplicationFactory.AvailabilityProbeOverride calls RemoveAll<ILlmAvailabilityProbe>
        // and re-adds a stub — this registration is also removed by that RemoveAll, keeping tests clean.
        services.AddSingleton<ILlmAvailabilityProbe>(sp =>
            new CachedLlmAvailabilityProbe(
                sp.GetRequiredService<ClaudeCodeAvailabilityProbe>(),
                TimeProvider.System,
                TimeSpan.FromSeconds(30)));

        // §1 atomic-ordering point (P1 / spec §1): register the first real seam — ClaudeCodeSummarizer —
        // and add it to realSeams so both the capability resolver and the selector light up together.
        // The DiffResolver closes over PrDetailLoader: cold path loads the snapshot first (so
        // GetOrFetchDiffAsync is never called with empty SHAs from a not-yet-loaded detail view).
        services.AddSingleton<ClaudeCodeSummarizer>(sp =>
        {
            var loader = sp.GetRequiredService<PrDetailLoader>();
            ClaudeCodeSummarizer.DiffResolver resolve = async (pr, ct) =>
            {
                // Cold path: if the detail view hasn't populated the snapshot yet, LOAD it.
                // Do NOT call GetOrFetchDiffAsync with empty SHAs — that would forward empty
                // base/head to the GitHub adapter (PR #T9 design constraint).
                //
                // Fix: use LoadAsync's return value directly. LoadAsync may return a NON-NULL
                // snapshot WITHOUT caching it when a generation flush races the load (see
                // PrDetailLoader.cs lines 148-151: if Volatile.Read(_generation) != generation
                // at the end of LoadAsync, the snapshot is returned uncached). Re-calling
                // TryGetCachedSnapshot after LoadAsync would return null in that race, causing a
                // spurious InvalidOperationException even though fresh data is available.
                var snapshot = loader.TryGetCachedSnapshot(pr)
                    ?? await loader.LoadAsync(pr, ct).ConfigureAwait(false)
                    ?? throw new InvalidOperationException($"PR detail unavailable for {pr}");
                var baseSha = snapshot.Detail.Pr.BaseSha;
                var headSha = snapshot.Detail.Pr.HeadSha;
                var diffDto = await loader.GetOrFetchDiffAsync(pr, new DiffRangeRequest(baseSha, headSha), ct).ConfigureAwait(false);
                var diffText = PrDiffText.Render(diffDto);
                return (diffText, snapshot.Detail.Pr.Title, snapshot.Detail.Pr.Body, baseSha, headSha);
            };
            return new ClaudeCodeSummarizer(
                sp.GetRequiredService<ILlmProvider>(),
                sp.GetRequiredService<ITokenUsageTracker>(),
                resolve,
                sp.GetRequiredService<ILogger<ClaudeCodeSummarizer>>(),
                sp.GetRequiredService<IAiInteractionLog>(),
                sp.GetRequiredService<IReviewEventBus>(),
                sp.GetRequiredService<IActivePrCache>());
        });

        // Net-new STRUCTURED resolver for the file-focus seam: returns DiffDto (not a flattened
        // string) + the SHAs. Mirrors the summarizer's cold-path guard: TryGetCachedSnapshot first,
        // then LoadAsync so GetOrFetchDiffAsync is never called with empty SHAs.
        services.AddSingleton<ClaudeCodeFileFocusRanker>(sp =>
        {
            var loader = sp.GetRequiredService<PrDetailLoader>();
            ClaudeCodeFileFocusRanker.DiffResolver resolve = async (pr, ct) =>
            {
                var snapshot = loader.TryGetCachedSnapshot(pr)
                    ?? await loader.LoadAsync(pr, ct).ConfigureAwait(false)
                    ?? throw new InvalidOperationException($"PR detail unavailable for {pr}");
                var baseSha = snapshot.Detail.Pr.BaseSha;
                var headSha = snapshot.Detail.Pr.HeadSha;
                var diffDto = await loader.GetOrFetchDiffAsync(pr, new DiffRangeRequest(baseSha, headSha), ct)
                                          .ConfigureAwait(false);
                return (diffDto, baseSha, headSha);
            };
            return new ClaudeCodeFileFocusRanker(
                sp.GetRequiredService<ILlmProvider>(),
                sp.GetRequiredService<ITokenUsageTracker>(),
                resolve,
                sp.GetRequiredService<ILogger<ClaudeCodeFileFocusRanker>>(),
                sp.GetRequiredService<IAiInteractionLog>(),
                sp.GetRequiredService<IReviewEventBus>(),
                sp.GetRequiredService<IActivePrCache>());
        });

        var realSeams = new Dictionary<Type, object>();   // P1: populated below with the first real impl
        // Pass the live dictionary BY REFERENCE (not a .Keys snapshot) — the resolver and the selector
        // (real: realSeams below) must read the same instance so P1's first real impl lights up both
        // the capability flag and the resolved seam together (PR #250 review).
        services.AddSingleton(sp => new AiCapabilityResolver(realSeams, sp.GetRequiredService<AiFeatureState>()));
        services.AddSingleton<IAiSeamSelector>(sp =>
        {
            // §1: populate realSeams before constructing the selector so both the capability
            // resolver and the seam selector see the same live entry.
            realSeams[typeof(IPrSummarizer)] = sp.GetRequiredService<ClaudeCodeSummarizer>();
            realSeams[typeof(IFileFocusRanker)] = sp.GetRequiredService<ClaudeCodeFileFocusRanker>();
            return new AiSeamSelector(
            sp.GetRequiredService<AiModeState>(),
            noop: new Dictionary<Type, object>
            {
                [typeof(IPrSummarizer)] = sp.GetRequiredService<NoopPrSummarizer>(),
                [typeof(IFileFocusRanker)] = sp.GetRequiredService<NoopFileFocusRanker>(),
                [typeof(IHunkAnnotator)] = sp.GetRequiredService<NoopHunkAnnotator>(),
                [typeof(IPreSubmitValidator)] = sp.GetRequiredService<NoopPreSubmitValidator>(),
                [typeof(IComposerAssistant)] = sp.GetRequiredService<NoopComposerAssistant>(),
                [typeof(IDraftSuggester)] = sp.GetRequiredService<NoopDraftSuggester>(),
                [typeof(IDraftReconciliator)] = sp.GetRequiredService<NoopDraftReconciliator>(),
                [typeof(IInboxItemEnricher)] = sp.GetRequiredService<NoopInboxItemEnricher>(),
                [typeof(IInboxRanker)] = sp.GetRequiredService<NoopInboxRanker>(),
            },
            placeholder: new Dictionary<Type, object>
            {
                [typeof(IPrSummarizer)] = sp.GetRequiredService<PlaceholderPrSummarizer>(),
                [typeof(IFileFocusRanker)] = sp.GetRequiredService<PlaceholderFileFocusRanker>(),
                [typeof(IHunkAnnotator)] = sp.GetRequiredService<PlaceholderHunkAnnotator>(),
                [typeof(IPreSubmitValidator)] = sp.GetRequiredService<PlaceholderPreSubmitValidator>(),
                [typeof(IComposerAssistant)] = sp.GetRequiredService<PlaceholderComposerAssistant>(),
                [typeof(IDraftSuggester)] = sp.GetRequiredService<PlaceholderDraftSuggester>(),
                [typeof(IDraftReconciliator)] = sp.GetRequiredService<PlaceholderDraftReconciliator>(),
                [typeof(IInboxItemEnricher)] = sp.GetRequiredService<PlaceholderInboxItemEnricher>(),
                [typeof(IInboxRanker)] = sp.GetRequiredService<PlaceholderInboxRanker>(),
            },
            real: realSeams,
            consent: sp.GetRequiredService<AiConsentState>(),
            features: sp.GetRequiredService<AiFeatureState>());
        });

        // Explicitly warm up IAiSeamSelector at host startup so realSeams is populated
        // before /api/capabilities can be served. Without this, realSeams is populated
        // lazily inside the IAiSeamSelector factory, and the first /api/capabilities call
        // in Live mode could report summary=false if something else hasn't already resolved
        // the selector (e.g. in tests that don't exercise the InboxPoller startup chain).
        // AiSeamWarmup.StartAsync resolves IAiSeamSelector once, forcing the factory to run.
        // IHostedService.StartAsync runs in registration order (after ViewerLoginHydrator
        // and InboxPoller, which are registered in AddPrismCore) — that's fine; we just
        // need the selector resolved before request handling begins, which StartAsync guarantees.
        services.AddHostedService<AiSeamWarmup>();

        return services;
    }

    /// <summary>
    /// Registers Web-internal singletons that aren't part of any other project: the SSE channel,
    /// the JSON serializer policy plumbed into <see cref="ConfigureHttpJsonOptions"/>, and
    /// ProblemDetails customization.
    /// </summary>
    public static IServiceCollection AddPrismWeb(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddSingleton<SseChannel>();
        services.AddSingleton<PRism.Web.Submit.SubmitLockRegistry>();
        services.AddSingleton<PRism.Web.Submit.SubmitCancellationRegistry>();

        services.ConfigureHttpJsonOptions(o =>
        {
            var api = JsonSerializerOptionsFactory.Api;
            o.SerializerOptions.PropertyNamingPolicy = api.PropertyNamingPolicy;
            o.SerializerOptions.DictionaryKeyPolicy = api.DictionaryKeyPolicy;
            foreach (var c in api.Converters) o.SerializerOptions.Converters.Add(c);
        });

        services.AddProblemDetails(o =>
        {
            o.CustomizeProblemDetails = ctx =>
            {
                var requestId = ctx.HttpContext.Items["RequestId"] as string;
                if (!string.IsNullOrEmpty(requestId))
                    ctx.ProblemDetails.Extensions["traceId"] = requestId;
            };
        });

        return services;
    }
}
