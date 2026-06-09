using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
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

    private static readonly PrReference Pr = new("o", "r", 1);

    // Test seam: the summarizer takes a Func that yields (diff, title, description, headSha) so the
    // test bypasses PrDetailLoader. Production wiring closes over PrDetailLoader (Task 9).
    private static ClaudeCodeSummarizer Build(ILlmProvider p, ITokenUsageTracker t,
        string diff = "+ added line", string title = "Fix poller", string desc = "Body", string headSha = "abc123")
        => new(p, t, (_, _) => Task.FromResult((diff, title, desc, headSha)));

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
}
