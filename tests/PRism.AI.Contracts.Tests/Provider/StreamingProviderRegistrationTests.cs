using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.AI.Contracts;
using PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.Contracts.Tests.Provider;

public sealed class StreamingProviderRegistrationTests
{
    [Fact]
    public void AddStreamingProviderDefault_registers_the_noop_provider()
    {
        var services = new ServiceCollection();

        services.AddStreamingProviderDefault();

        using var sp = services.BuildServiceProvider(validateScopes: true);
        sp.GetService<IStreamingLlmProvider>().Should().BeOfType<NoopStreamingLlmProvider>();
    }

    [Fact]
    public void Streaming_provider_default_is_a_singleton()
    {
        var services = new ServiceCollection();
        services.AddStreamingProviderDefault();
        using var sp = services.BuildServiceProvider();

        sp.GetRequiredService<IStreamingLlmProvider>()
            .Should().BeSameAs(sp.GetRequiredService<IStreamingLlmProvider>());
    }

    [Fact]
    public void A_real_provider_registered_first_wins_over_the_noop_default()
    {
        // Pins the ordering-trap immunity the dark default relies on: Slice 2 registers the real
        // provider earlier (in AddPrismClaudeCode, which runs before AddPrismAi); the TryAdd default
        // then no-ops and the real provider survives.
        var services = new ServiceCollection();

        services.AddSingleton<IStreamingLlmProvider>(_ => new FakeStreamingLlmProvider());
        services.AddStreamingProviderDefault();

        using var sp = services.BuildServiceProvider();
        sp.GetService<IStreamingLlmProvider>().Should().BeOfType<FakeStreamingLlmProvider>();
    }

    private sealed class FakeStreamingLlmProvider : IStreamingLlmProvider
    {
        public IStreamingLlmSession StartSession(StreamingSessionOptions options) =>
            throw new NotSupportedException();
    }
}
