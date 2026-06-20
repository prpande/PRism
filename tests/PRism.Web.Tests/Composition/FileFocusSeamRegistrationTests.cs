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
/// Asserts the §1 atomic-ordering invariant for the fileFocus seam: with mode=live and
/// consent recorded, <see cref="IAiSeamSelector"/> resolves <see cref="IFileFocusRanker"/>
/// to <see cref="ClaudeCodeFileFocusRanker"/> — NOT the noop fallback.
///
/// <para>
/// Mirrors <c>SummarizerRegistrationTests</c>; swap seam type only.
/// </para>
/// </summary>
public sealed class FileFocusSeamRegistrationTests : IDisposable
{
    // Minimal stub: never actually called in a DI-resolution test — only its type
    // identity matters to ensure ILlmProvider resolves without spawning the real CLI.
    private sealed class StubLlmProvider : ILlmProvider
    {
        public Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken ct)
            => Task.FromResult(new LlmResult("stub", 0, 0, 0, 0, 0m));
    }

    private readonly PRismWebApplicationFactory _factory = new()
    {
        LlmProviderOverride = new StubLlmProvider(),
    };

    [Fact]
    public void Live_consented_resolves_ClaudeCodeFileFocusRanker()
    {
        // Arrange: switch to Live mode and record consent.
        _factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Live;
        _factory.Services.GetRequiredService<AiConsentState>()
            .Set(new AiConsentConfig(AiProviderIds.Claude, AiDisclosure.CurrentVersion, DateTimeOffset.UtcNow));

        // Act: resolve through the selector — this is what the /ai/file-focus endpoint does.
        var selector = _factory.Services.GetRequiredService<IAiSeamSelector>();
        var ranker = selector.Resolve<IFileFocusRanker>();

        // Assert: the real seam must light up (not the noop fallback).
        ranker.Should().BeOfType<ClaudeCodeFileFocusRanker>(
            because: "AddPrismAi must register ClaudeCodeFileFocusRanker in realSeams[typeof(IFileFocusRanker)] " +
                     "so the selector resolves the live impl when mode=live + consent recorded (spec §1).");
    }

    public void Dispose() => _factory.Dispose();
}
