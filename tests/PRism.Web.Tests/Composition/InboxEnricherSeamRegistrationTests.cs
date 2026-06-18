using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.AI.Contracts.Provider;
using PRism.AI.Contracts.Seams;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Web.Ai;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Composition;

/// <summary>
/// Asserts the §1 atomic-ordering invariant for the inboxEnrichment seam: with mode=live and consent
/// recorded, <see cref="IAiSeamSelector"/> resolves <see cref="IInboxItemEnricher"/> to
/// <see cref="ClaudeCodeInboxItemEnricher"/> — NOT the noop fallback. Mirrors FileFocusSeamRegistrationTests.
/// </summary>
public sealed class InboxEnricherSeamRegistrationTests : IDisposable
{
    private sealed class StubLlmProvider : ILlmProvider
    {
        public Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken ct)
            => Task.FromResult(new LlmResult("stub", 0, 0, 0, 0m));
    }

    private readonly PRismWebApplicationFactory _factory = new()
    {
        LlmProviderOverride = new StubLlmProvider(),
    };

    [Fact]
    public void Live_consented_resolves_ClaudeCodeInboxItemEnricher()
    {
        _factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Live;
        _factory.Services.GetRequiredService<AiConsentState>()
            .Set(new AiConsentConfig(AiProviderIds.Claude, AiDisclosure.CurrentVersion, DateTimeOffset.UtcNow));

        var selector = _factory.Services.GetRequiredService<IAiSeamSelector>();
        var enricher = selector.Resolve<IInboxItemEnricher>();

        enricher.Should().BeOfType<ClaudeCodeInboxItemEnricher>(
            because: "AddPrismAi must register ClaudeCodeInboxItemEnricher in realSeams[typeof(IInboxItemEnricher)] " +
                     "so the selector resolves the live impl when mode=live + consent recorded (spec §1/#410).");
    }

    public void Dispose() => _factory.Dispose();
}
