using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class StreamingServiceRegistrationTests : IDisposable
{
    private readonly string _usageDir = Path.Combine(Path.GetTempPath(), "prism-streg-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public void AddPrismClaudeCode_registers_real_streaming_provider_as_singleton()
    {
        var services = new ServiceCollection();
        services.AddSingleton<ILoggerFactory>(NullLoggerFactory.Instance);   // mirrors the Web host: logging is always registered before AddPrismClaudeCode
        services.AddPrismClaudeCode(new ClaudeCodeProviderOptions { WorkingDirectory = Path.GetTempPath() }, _usageDir);
        using var sp = services.BuildServiceProvider(validateScopes: true);

        sp.GetService<IStreamingLlmProvider>().Should().BeOfType<ClaudeCodeStreamingProvider>();
        sp.GetRequiredService<IStreamingLlmProvider>().Should().BeSameAs(sp.GetRequiredService<IStreamingLlmProvider>());
    }

    [Fact]
    public void Real_streaming_provider_wins_over_the_slice1_noop_default()
    {
        // AddPrismClaudeCode runs before AddPrismAi in Program.cs; the TryAdd Noop default then no-ops.
        var services = new ServiceCollection();
        services.AddSingleton<ILoggerFactory>(NullLoggerFactory.Instance);   // mirrors the Web host: logging is always registered before AddPrismClaudeCode
        services.AddPrismClaudeCode(new ClaudeCodeProviderOptions { WorkingDirectory = Path.GetTempPath() }, _usageDir);
        services.AddStreamingProviderDefault();   // simulates AddPrismAi running afterwards

        using var sp = services.BuildServiceProvider();
        sp.GetService<IStreamingLlmProvider>().Should().BeOfType<ClaudeCodeStreamingProvider>();
    }

    public void Dispose()
    {
        if (Directory.Exists(_usageDir)) Directory.Delete(_usageDir, recursive: true);
        GC.SuppressFinalize(this);
    }
}
