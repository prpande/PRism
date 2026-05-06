using Microsoft.Extensions.DependencyInjection;
using PRism.AI.Contracts.Noop;

namespace PRism.AI.Contracts;

public static class ServiceCollectionExtensions
{
    /// <summary>
    /// Registers the nine PoC Noop AI seam implementations as singletons. The Noop set is the
    /// PoC default when <c>ui.aiPreview</c> is off; <see cref="PRism.Web"/>'s composition root
    /// wires both this set and the Placeholder set into <c>IAiSeamSelector</c> and chooses
    /// between them at request time based on the flag.
    /// </summary>
    public static IServiceCollection AddNoopSeams(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton<NoopPrSummarizer>();
        services.AddSingleton<NoopFileFocusRanker>();
        services.AddSingleton<NoopHunkAnnotator>();
        services.AddSingleton<NoopPreSubmitValidator>();
        services.AddSingleton<NoopComposerAssistant>();
        services.AddSingleton<NoopDraftSuggester>();
        services.AddSingleton<NoopDraftReconciliator>();
        services.AddSingleton<NoopInboxItemEnricher>();
        services.AddSingleton<NoopInboxRanker>();
        return services;
    }
}
