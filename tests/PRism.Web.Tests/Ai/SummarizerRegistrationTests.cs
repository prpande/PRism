using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.AI.Contracts.Provider;
using PRism.AI.Contracts.Seams;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Web.Ai;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Ai;

/// <summary>
/// Asserts the §1 atomic-ordering invariant: with mode=live, consent recorded, and an
/// <see cref="ILlmProvider"/> stub registered, <see cref="IAiSeamSelector"/> resolves
/// <see cref="IPrSummarizer"/> to <see cref="ClaudeCodeSummarizer"/> — NOT the noop fallback.
///
/// <para>
/// This is the §1 "first real Live AI seam" test. The consent gate (Task 5) and the
/// DiffResolver registration (Task 9) light up together in <c>AddPrismAi</c>.
/// </para>
/// </summary>
public sealed class SummarizerRegistrationTests : IDisposable
{
    // Minimal stub: never actually called in a DI-resolution test — only its type
    // identity matters to ensure ILlmProvider resolves without spawning the real CLI.
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
    public void Live_consented_selector_resolves_ClaudeCodeSummarizer()
    {
        // Arrange: switch to Live mode and record consent (§T5 gate).
        _factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Live;
        _factory.Services.GetRequiredService<AiConsentState>()
            .Set(new AiConsentConfig(AiProviderIds.Claude, AiDisclosure.CurrentVersion, DateTimeOffset.UtcNow));

        // Act: resolve through the selector — this is what the /ai/summary endpoint does.
        var selector = _factory.Services.GetRequiredService<IAiSeamSelector>();
        var summarizer = selector.Resolve<IPrSummarizer>();

        // Assert: §1 — the first real seam must light up (not the noop fallback).
        summarizer.Should().BeOfType<ClaudeCodeSummarizer>(
            because: "AddPrismAi must register ClaudeCodeSummarizer in realSeams[typeof(IPrSummarizer)] " +
                     "so the selector resolves the live impl when mode=live + consent recorded (spec §1).");
    }

    public void Dispose() => _factory.Dispose();
}
