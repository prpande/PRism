using Microsoft.Extensions.DependencyInjection;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode;

/// <summary>
/// Registers the Claude Code CLI provider, its process runner, availability probe, and the
/// token-usage tracker as singletons. Dark in P0 — no feature seam resolves these until a later PR.
/// </summary>
public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddPrismClaudeCode(
        this IServiceCollection services, ClaudeCodeProviderOptions options, string usageDir)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentException.ThrowIfNullOrEmpty(usageDir);

        services.AddSingleton(options);
        services.AddSingleton<ICliProcessRunner, SystemCliProcessRunner>();
        services.AddSingleton<ILlmProvider, ClaudeCodeLlmProvider>();
        services.AddSingleton<ITokenUsageTracker>(_ => new JsonlTokenUsageTracker(usageDir));
        // Register the concrete type so Web's AddPrismAi can resolve it directly when
        // wrapping it with CachedLlmAvailabilityProbe. The interface forwarding below keeps
        // all other consumers (and test-factory RemoveAll<ILlmAvailabilityProbe>) unchanged.
        services.AddSingleton(sp => new ClaudeCodeAvailabilityProbe(
            sp.GetRequiredService<ICliProcessRunner>(),
            sp.GetRequiredService<ClaudeCodeProviderOptions>(),
            identityMatches: ClaudeIdentity.SameOsUserAsCredentialStore));
        services.AddSingleton<ILlmAvailabilityProbe>(
            sp => sp.GetRequiredService<ClaudeCodeAvailabilityProbe>());
        services.AddSingleton(ClaudeProviderDescriptor.Create());
        return services;
    }
}
