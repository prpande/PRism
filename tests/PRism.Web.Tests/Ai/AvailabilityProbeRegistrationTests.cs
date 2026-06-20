using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.AI.Contracts.Provider;
using PRism.Web.Ai;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Ai;

/// <summary>
/// Asserts the production DI end-state for <see cref="ILlmAvailabilityProbe"/>:
/// after the full composition (<c>AddPrismClaudeCode</c> + <c>AddPrismAi</c>) runs,
/// the interface must resolve to <see cref="CachedLlmAvailabilityProbe"/> — NOT
/// directly to <see cref="PRism.AI.ClaudeCode.ClaudeCodeAvailabilityProbe"/>.
///
/// <para>
/// This test closes the gap documented in the T6b code review: the isolated-layer test
/// in <c>PRism.AI.ClaudeCode.Tests/ServiceRegistrationTests.cs</c> verifies
/// <c>AddPrismClaudeCode</c> alone and correctly asserts <c>ClaudeCodeAvailabilityProbe</c>;
/// it cannot see the decorator added by <c>AddPrismAi</c>, which runs after it.
/// This test uses <see cref="PRismWebApplicationFactory"/> so the provider is built from
/// the identical extension-method calls as the production host (Program.cs lines ~69-81).
/// </para>
/// </summary>
public sealed class AvailabilityProbeRegistrationTests : IDisposable
{
    private readonly PRismWebApplicationFactory _factory = new();

    [Fact]
    public void ILlmAvailabilityProbe_ResolvesToCachedDecorator_InFullComposition()
    {
        // GetRequiredService triggers real BuildServiceProvider resolution.
        // CachedLlmAvailabilityProbe.ProbeAsync is NOT called here — only the
        // type identity is asserted, so no claude subprocess is spawned.
        var probe = _factory.Services.GetRequiredService<ILlmAvailabilityProbe>();

        probe.Should().BeOfType<CachedLlmAvailabilityProbe>(
            because: "AddPrismAi wraps the ClaudeCodeAvailabilityProbe registered by " +
                     "AddPrismClaudeCode with a short-TTL CachedLlmAvailabilityProbe " +
                     "(KTD-6 / T6b). The isolated-layer assertion in " +
                     "PRism.AI.ClaudeCode.Tests/ServiceRegistrationTests.cs verifies " +
                     "AddPrismClaudeCode alone and correctly sees ClaudeCodeAvailabilityProbe; " +
                     "THIS test verifies the full-composition end-state.");
    }

    public void Dispose() => _factory.Dispose();
}
