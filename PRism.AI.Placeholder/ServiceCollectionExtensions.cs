using Microsoft.Extensions.DependencyInjection;

namespace PRism.AI.Placeholder;

public static class ServiceCollectionExtensions
{
    /// <summary>
    /// Registers the nine PoC Placeholder AI seam implementations as singletons. The Placeholder
    /// set surfaces canned data lifted from the design handoff; <see cref="PRism.Web"/>'s
    /// composition root selects this set when <c>ui.aiPreview</c> is on. See
    /// <c>docs/roadmap.md</c> § "AI placeholder behavior".
    /// </summary>
    public static IServiceCollection AddPlaceholderSeams(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton<PlaceholderPrSummarizer>();
        services.AddSingleton<PlaceholderFileFocusRanker>();
        services.AddSingleton<PlaceholderHunkAnnotator>();
        services.AddSingleton<PlaceholderPreSubmitValidator>();
        services.AddSingleton<PlaceholderComposerAssistant>();
        services.AddSingleton<PlaceholderDraftSuggester>();
        services.AddSingleton<PlaceholderDraftReconciliator>();
        services.AddSingleton<PlaceholderInboxItemEnricher>();
        services.AddSingleton<PlaceholderInboxRanker>();
        return services;
    }
}
