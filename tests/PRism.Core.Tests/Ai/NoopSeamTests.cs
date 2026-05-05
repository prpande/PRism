using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Ai;

public class NoopSeamTests
{
    private static readonly PrReference Ref = new("acme", "api-server", 1);

    [Fact]
    public async Task NoopPrSummarizer_returns_null()
    {
        IPrSummarizer s = new NoopPrSummarizer();
        var result = await s.SummarizeAsync(Ref, CancellationToken.None);
        result.Should().BeNull();
    }

    [Fact]
    public async Task NoopFileFocusRanker_returns_empty()
    {
        IFileFocusRanker s = new NoopFileFocusRanker();
        var result = await s.RankAsync(Ref, CancellationToken.None);
        result.Should().BeEmpty();
    }

    [Fact]
    public async Task NoopHunkAnnotator_returns_empty()
    {
        IHunkAnnotator s = new NoopHunkAnnotator();
        var result = await s.AnnotateAsync(Ref, "path", 0, CancellationToken.None);
        result.Should().BeEmpty();
    }

    [Fact]
    public async Task NoopPreSubmitValidator_returns_no_findings()
    {
        IPreSubmitValidator s = new NoopPreSubmitValidator();
        var result = await s.ValidateAsync(Ref, CancellationToken.None);
        result.Findings.Should().BeEmpty();
    }

    [Fact]
    public async Task NoopComposerAssistant_returns_null()
    {
        IComposerAssistant s = new NoopComposerAssistant();
        var result = await s.SuggestAsync(Ref, "draft body", CancellationToken.None);
        result.Should().BeNull();
    }

    [Fact]
    public async Task NoopDraftSuggester_returns_empty()
    {
        IDraftSuggester s = new NoopDraftSuggester();
        var result = await s.SuggestAsync(Ref, CancellationToken.None);
        result.Should().BeEmpty();
    }

    [Fact]
    public async Task NoopDraftReconciliator_returns_empty()
    {
        IDraftReconciliator s = new NoopDraftReconciliator();
        var result = await s.ReconcileAsync(Ref, Array.Empty<DraftComment>(), CancellationToken.None);
        result.Should().BeEmpty();
    }

    [Fact]
    public async Task NoopInboxEnricher_returns_null()
    {
        IInboxEnricher s = new NoopInboxEnricher();
        var result = await s.EnrichAsync(Ref, CancellationToken.None);
        result.Should().BeNull();
    }

    [Fact]
    public async Task NoopInboxRanker_returns_input_order_unchanged()
    {
        IInboxRanker s = new NoopInboxRanker();
        var input = new[] { Ref, new PrReference("acme", "api-server", 2) };
        var result = await s.RankAsync(input, CancellationToken.None);
        result.Should().Equal(input);
    }
}
