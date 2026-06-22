using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
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
        // Delegate to the factory overload so there is ONE registration code path. The instance
        // overload protects the existing instance-overload test call sites, which do NOT register IConfigStore.
        return services.AddPrismClaudeCode(_ => options, usageDir);
    }

    // #496: factory overload. The composition root (PRism.Web/Program.cs) supplies a factory that
    // closes over IServiceProvider so ClaudeCodeProviderOptions.TimeoutProvider can resolve IConfigStore
    // (PRism.Core) and clamp via AiConfigBounds (PRism.Core) on each call — those symbols are NOT visible
    // here, which is why the closure lives in Program.cs.
    public static IServiceCollection AddPrismClaudeCode(
        this IServiceCollection services, Func<IServiceProvider, ClaudeCodeProviderOptions> optionsFactory, string usageDir)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(optionsFactory);
        ArgumentException.ThrowIfNullOrEmpty(usageDir);

        services.AddSingleton(optionsFactory);
        services.AddSingleton<ICliProcessRunner, SystemCliProcessRunner>();
        services.AddSingleton<ILoginShellEnvironmentReader, SystemLoginShellEnvironmentReader>();
        // Discovery-state file lives alongside usage under the per-user dataDir's AI area.
        services.AddSingleton(_ => new JsonClaudeCliStateStore(Path.Combine(usageDir, "cli-state")));
        services.AddSingleton<IClaudeCliLocator>(sp => new ClaudeCliLocator(
            sp.GetRequiredService<ILoginShellEnvironmentReader>(),
            sp.GetRequiredService<JsonClaudeCliStateStore>(),
            sp.GetRequiredService<ICliProcessRunner>(),
            sp.GetRequiredService<ClaudeCodeProviderOptions>(),
            identityMatches: ClaudeIdentity.SameOsUserAsCredentialStore,
            clock: TimeProvider.System));
        services.AddSingleton<ILlmProvider>(sp => new ClaudeCodeLlmProvider(
            sp.GetRequiredService<ICliProcessRunner>(),
            sp.GetRequiredService<ClaudeCodeProviderOptions>(),
            sp.GetRequiredService<IClaudeCliLocator>()));
        services.AddSingleton<IStreamingCliProcessFactory, SystemStreamingCliProcessFactory>();
        services.AddSingleton<IStreamingLlmProvider>(sp => new ClaudeCodeStreamingProvider(
            sp.GetRequiredService<IStreamingCliProcessFactory>(),
            sp.GetRequiredService<ClaudeCodeProviderOptions>(),
            sp.GetRequiredService<IClaudeCliLocator>(),
            sp.GetRequiredService<ILoggerFactory>()));   // inject a real logger so drift-guard warnings reach a sink
        services.AddSingleton<ITokenUsageTracker>(_ => new JsonlTokenUsageTracker(usageDir));
        // Register the concrete type so Web's AddPrismAi can resolve it directly when
        // wrapping it with CachedLlmAvailabilityProbe. The interface forwarding below keeps
        // all other consumers (and test-factory RemoveAll<ILlmAvailabilityProbe>) unchanged.
        services.AddSingleton(sp => new ClaudeCodeAvailabilityProbe(
            sp.GetRequiredService<ICliProcessRunner>(),
            sp.GetRequiredService<ClaudeCodeProviderOptions>(),
            sp.GetRequiredService<IClaudeCliLocator>()));
        services.AddSingleton<ILlmAvailabilityProbe>(
            sp => sp.GetRequiredService<ClaudeCodeAvailabilityProbe>());
        services.AddSingleton(ClaudeProviderDescriptor.Create());
        return services;
    }
}
