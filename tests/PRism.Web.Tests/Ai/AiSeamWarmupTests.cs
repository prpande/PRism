using FluentAssertions;
using PRism.Core.Ai;
using PRism.Web.Ai;

namespace PRism.Web.Tests.Ai;

/// <summary>
/// Verifies <see cref="AiSeamWarmup"/> behavior at two levels:
///
/// <list type="number">
/// <item>
///   <b>Unit</b>: <c>StartAsync</c> calls <c>GetRequiredService&lt;IAiSeamSelector&gt;()</c>
///   exactly once — confirmed via a minimal stub <see cref="IServiceProvider"/> that records
///   the call. This is the most targeted test for the contract: the warm-up must force the
///   singleton factory to run, regardless of whether any other hosted service has done so.
/// </item>
/// <item>
///   <b>Integration (implicit)</b>: the <see cref="SummarizerRegistrationTests"/> and
///   <see cref="CapabilitiesConsentTests"/> suites exercise the full
///   <c>PRismWebApplicationFactory</c> host, which runs <c>AiSeamWarmup.StartAsync</c>
///   through the normal hosted-service pipeline. Those tests already assert <c>summary=true</c>
///   in Live + consented + probe-available mode — they pass only when <c>realSeams</c> is
///   correctly populated, which now depends on the warm-up running at startup.
/// </item>
/// </list>
/// </summary>
public sealed class AiSeamWarmupTests
{
    /// <summary>
    /// Minimal stub that records how many times IAiSeamSelector was requested.
    /// </summary>
    private sealed class TrackingServiceProvider : IServiceProvider
    {
        public int SelectorResolveCount { get; private set; }

        // Stub IAiSeamSelector that satisfies GetRequiredService's non-null contract.
        private readonly IAiSeamSelector _stubSelector = new StubAiSeamSelector();

        public object? GetService(Type serviceType)
        {
            if (serviceType == typeof(IAiSeamSelector))
            {
                SelectorResolveCount++;
                return _stubSelector;
            }
            return null;
        }

        private sealed class StubAiSeamSelector : IAiSeamSelector
        {
            public T Resolve<T>() where T : class => throw new NotImplementedException("stub");
        }
    }

    [Fact]
    public async Task StartAsync_ResolvesIAiSeamSelector_ExactlyOnce()
    {
        // Arrange
        var provider = new TrackingServiceProvider();
        var warmup = new AiSeamWarmup(provider);

        // Act
        await warmup.StartAsync(CancellationToken.None);

        // Assert: the factory was triggered once — realSeams is populated on first resolution
        // and the singleton is already cached for subsequent calls; one forced resolution is enough.
        provider.SelectorResolveCount.Should().Be(1,
            because: "AiSeamWarmup.StartAsync must resolve IAiSeamSelector exactly once to " +
                     "trigger the DI factory that populates realSeams before any HTTP request " +
                     "can reach /api/capabilities (see AiSeamWarmup doc comment).");
    }

    [Fact]
    public async Task StopAsync_IsNoOp_AndDoesNotThrow()
    {
        var provider = new TrackingServiceProvider();
        var warmup = new AiSeamWarmup(provider);

        // Should complete without error and without touching the provider.
        await warmup.StopAsync(CancellationToken.None);

        provider.SelectorResolveCount.Should().Be(0);
    }

    [Fact]
    public void Constructor_ThrowsArgumentNullException_WhenServiceProviderIsNull()
    {
        var act = () => new AiSeamWarmup(null!);
        act.Should().Throw<ArgumentNullException>()
            .WithParameterName("serviceProvider");
    }
}
