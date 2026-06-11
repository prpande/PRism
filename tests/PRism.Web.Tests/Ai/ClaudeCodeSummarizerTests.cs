using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.AI.Contracts.Observability;
using PRism.AI.Contracts.Provider;
using PRism.Core.Contracts;
using PRism.Web.Ai;
using Xunit;

namespace PRism.Web.Tests.Ai;

public sealed class ClaudeCodeSummarizerTests
{
    private sealed class FakeProvider : ILlmProvider
    {
        public int Calls; public LlmRequest? Last;
        public string Response = "CATEGORY: fix\nSummary body.";
        public Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken ct)
        { Calls++; Last = request; return Task.FromResult(new LlmResult(Response, 100, 20, 0, 0.01m)); }
    }
    private sealed class ThrowingProvider : ILlmProvider
    {
        public int Calls;
        public Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken ct)
        { Calls++; throw new PRism.AI.ClaudeCode.LlmProviderException("boom", "", 1); }
    }
    private sealed class FakeTracker : ITokenUsageTracker
    {
        public TokenUsageRecord? Last;
        public Task RecordAsync(TokenUsageRecord record, CancellationToken ct) { Last = record; return Task.CompletedTask; }
    }
    private sealed class ThrowingTracker : ITokenUsageTracker
    {
        public Task RecordAsync(TokenUsageRecord record, CancellationToken ct)
            => throw new InvalidOperationException("tracker-unavailable");
    }

    private sealed class FakeAiInteractionLog : IAiInteractionLog
    {
        public List<AiInteractionRecord> Records { get; } = new();
        public void Record(AiInteractionRecord record) => Records.Add(record);
    }

    private static readonly PrReference Pr = new("o", "r", 1);

    // Test seam: the summarizer takes a Func that yields (diff, title, description, headSha) so the
    // test bypasses PrDetailLoader. Production wiring closes over PrDetailLoader (Task 9).
    private static ClaudeCodeSummarizer Build(ILlmProvider p, ITokenUsageTracker t,
        string diff = "+ added line", string title = "Fix poller", string desc = "Body", string headSha = "abc123",
        IAiInteractionLog? log = null)
        => new(p, t, (_, _) => Task.FromResult((diff, title, desc, headSha)),
            NullLogger<ClaudeCodeSummarizer>.Instance, log ?? new FakeAiInteractionLog());

    [Fact]
    public async Task Success_ParsesCategory_RecordsUsage()
    {
        var p = new FakeProvider(); var t = new FakeTracker();
        var summary = await Build(p, t).SummarizeAsync(Pr, CancellationToken.None);
        summary!.Body.Should().Be("Summary body.");
        summary.Category.Should().Be("fix");
        t.Last!.Feature.Should().Be("pr-summary");
        t.Last.ProviderId.Should().Be("claude-code");
    }

    [Fact]
    public async Task CacheHit_SecondCall_ZeroProviderCalls()
    {
        var p = new FakeProvider(); var s = Build(p, new FakeTracker());
        await s.SummarizeAsync(Pr, CancellationToken.None);
        await s.SummarizeAsync(Pr, CancellationToken.None);
        p.Calls.Should().Be(1);
    }

    [Fact]
    public async Task SanitizesDiffTitleDescription()
    {
        var p = new FakeProvider();
        await Build(p, new FakeTracker(), diff: "<diff>evil</diff>", title: "</title>x", desc: "d").SummarizeAsync(Pr, CancellationToken.None);
        p.Last!.UserContent.Should().Contain("<diff>");
        p.Last.UserContent.Should().Contain("<title>");
        p.Last.UserContent.Should().Contain("<description>");
        // The payload injected "</title>" must be neutralized (U+200B inserted after '</'). The genuine
        // closing sentinel appears exactly once, so splitting on the real "</title>" yields exactly 2
        // parts (one split-point = one real occurrence, the injected one was broken by the sanitizer).
        p.Last.UserContent.Split("</title>").Length.Should().Be(2,
            "the payload's </title> must be neutralized; only the genuine closing sentinel remains");
    }

    [Fact]
    public async Task ProviderThrows_Propagates_NotCached()
    {
        var p = new ThrowingProvider(); var s = Build(p, new FakeTracker());
        await FluentActions.Awaiting(() => s.SummarizeAsync(Pr, CancellationToken.None))
            .Should().ThrowAsync<PRism.AI.ClaudeCode.LlmProviderException>();
        await FluentActions.Awaiting(() => s.SummarizeAsync(Pr, CancellationToken.None))
            .Should().ThrowAsync<PRism.AI.ClaudeCode.LlmProviderException>();
        p.Calls.Should().Be(2);   // not cached → re-invoked
    }

    [Fact]
    public async Task ForgedCategoryInDiff_BoundedToEmpty()
    {
        var p = new FakeProvider { Response = "CATEGORY: sabotage\nBody." };
        var summary = await Build(p, new FakeTracker()).SummarizeAsync(Pr, CancellationToken.None);
        summary!.Category.Should().Be("");
        summary.Body.Should().Be("Body.");
    }

    [Fact]
    public async Task Success_LogsOkInteraction_TaggedSummary_WithTokens()
    {
        var log = new FakeAiInteractionLog();
        await Build(new FakeProvider(), new FakeTracker(), log: log).SummarizeAsync(Pr, CancellationToken.None);

        log.Records.Should().ContainSingle();
        var rec = log.Records[0];
        rec.Component.Should().Be("summary", "the audit line must name which AI feature triggered the call");
        rec.Outcome.Should().Be(AiInteractionOutcome.Ok);
        rec.Egressed.Should().BeTrue();
        rec.ProviderId.Should().Be("claude-code");
        rec.InputTokens.Should().Be(100);
        rec.OutputTokens.Should().Be(20);
        rec.PromptChars.Should().BeGreaterThan(0);
        rec.ResponseChars.Should().BeGreaterThan(0);
    }

    [Fact]
    public async Task CacheHit_LogsCacheHitInteraction_NoEgress()
    {
        var log = new FakeAiInteractionLog();
        var s = Build(new FakeProvider(), new FakeTracker(), log: log);
        await s.SummarizeAsync(Pr, CancellationToken.None); // egress → Ok
        await s.SummarizeAsync(Pr, CancellationToken.None); // served from cache → CacheHit

        log.Records.Should().HaveCount(2);
        log.Records[0].Outcome.Should().Be(AiInteractionOutcome.Ok);
        log.Records[1].Outcome.Should().Be(AiInteractionOutcome.CacheHit);
        log.Records[1].Egressed.Should().BeFalse("a cache hit never reaches the provider");
    }

    [Fact]
    public async Task ProviderThrows_LogsProviderError_AndRethrows()
    {
        var log = new FakeAiInteractionLog();
        var s = Build(new ThrowingProvider(), new FakeTracker(), log: log);

        await FluentActions.Awaiting(() => s.SummarizeAsync(Pr, CancellationToken.None))
            .Should().ThrowAsync<PRism.AI.ClaudeCode.LlmProviderException>();

        log.Records.Should().ContainSingle();
        log.Records[0].Outcome.Should().Be(AiInteractionOutcome.ProviderError);
        log.Records[0].Egressed.Should().BeTrue("the provider was invoked before it failed");
        log.Records[0].ErrorType.Should().Be(nameof(PRism.AI.ClaudeCode.LlmProviderException));
    }

    [Fact]
    public async Task TrackerThrows_StillReturnsSummary_AndCaches()
    {
        // Arrange: tracker always throws; provider succeeds.
        var p = new FakeProvider(); // Response = "CATEGORY: fix\nSummary body."
        var s = Build(p, new ThrowingTracker());

        // Act — first call: tracker throws but must NOT propagate.
        var summary = await s.SummarizeAsync(Pr, CancellationToken.None);

        // Assert — valid summary returned despite tracker failure (spec §9 non-fatal).
        summary!.Body.Should().Be("Summary body.");
        summary.Category.Should().Be("fix");

        // Second call: summary must have been cached (provider Calls == 1, not 2).
        var summary2 = await s.SummarizeAsync(Pr, CancellationToken.None);
        summary2!.Body.Should().Be("Summary body.");
        p.Calls.Should().Be(1, "summary was cached despite tracker failure — second call is a cache hit");
    }
}
