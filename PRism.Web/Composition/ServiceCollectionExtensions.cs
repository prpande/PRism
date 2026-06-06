using System.Linq;
using Microsoft.Extensions.DependencyInjection;
using PRism.AI.Contracts;
using PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Seams;
using PRism.AI.Placeholder;
using PRism.Core.Ai;
using PRism.Core.Json;
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

        var realSeams = new Dictionary<Type, object>();   // P0: empty; P1 adds the first real impl here
        services.AddSingleton(new AiCapabilityResolver(realSeams.Keys.ToHashSet()));
        services.AddSingleton<IAiSeamSelector>(sp => new AiSeamSelector(
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
            liveAvailable: () => false));            // P0: no live features; P1 wires the cached probe-availability

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
