using PRism.AI.Contracts.Seams;
using PRism.AI.Placeholder;
using PRism.Core.Contracts;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Ai;

public class PlaceholderSeamTests
{
    private static readonly PrReference Ref = new("acme", "api-server", 1842);

    [Fact]
    public async Task Summarizer_returns_canned_summary_with_category()
    {
        IPrSummarizer s = new PlaceholderPrSummarizer();
        var result = await s.SummarizeAsync(Ref, CancellationToken.None);
        result.Should().NotBeNull();
        result!.Body.Should().NotBeNullOrWhiteSpace();
        result.Category.Should().BeOneOf("Refactor", "Feature", "Perf", "Bug", "Experiment");
    }

    [Fact]
    public async Task FileFocusRanker_returns_at_least_one_file()
    {
        IFileFocusRanker s = new PlaceholderFileFocusRanker();
        var result = await s.RankAsync(Ref, CancellationToken.None);
        result.Should().NotBeEmpty();
    }

    [Fact]
    public async Task PreSubmitValidator_returns_at_least_one_finding()
    {
        IPreSubmitValidator s = new PlaceholderPreSubmitValidator();
        var result = await s.ValidateAsync(Ref, CancellationToken.None);
        result.Findings.Should().NotBeEmpty();
    }

    [Fact]
    public async Task InboxRanker_preserves_input_set_but_may_reorder()
    {
        IInboxRanker s = new PlaceholderInboxRanker();
        var input = new[] { Ref, new PrReference("acme", "api-server", 2), new PrReference("acme", "api-server", 3) };
        var result = await s.RankAsync(input, CancellationToken.None);
        result.Should().HaveCount(3);
        result.Should().BeEquivalentTo(input);
    }
}
