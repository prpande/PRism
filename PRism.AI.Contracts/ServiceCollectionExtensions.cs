using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Provider;

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

    /// <summary>
    /// Registers the dark-default streaming LLM provider (<see cref="NoopStreamingLlmProvider"/>) as
    /// the <see cref="IStreamingLlmProvider"/> singleton. This is the P0-1b Slice-1 seam: no consumer
    /// resolves it yet, but the seam is resolvable and test-doublable, and Slice 2's real Claude Code
    /// streaming provider takes over with no change here.
    /// <para>Uses <c>TryAdd</c> (default-if-absent), so it is immune to registration-ordering: when
    /// Slice 2 registers the real provider earlier (in <c>AddPrismClaudeCode</c>, which runs before
    /// <c>AddPrismAi</c> in <c>Program.cs</c>), this <c>TryAdd</c> no-ops and the real provider wins.
    /// A plain <c>AddSingleton</c> here would instead let the Noop shadow the real provider
    /// (last-registration-wins).</para>
    /// </summary>
    public static IServiceCollection AddStreamingProviderDefault(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.TryAddSingleton<IStreamingLlmProvider, NoopStreamingLlmProvider>();
        return services;
    }
}
