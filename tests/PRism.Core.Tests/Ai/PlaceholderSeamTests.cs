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

    // #464: the Preview summary must read as THIS PR's sample, not byte-identical canned text across
    // every PR. Identical bodies made a sample seen on one PR indistinguishable from another's, which
    // reads as a stale cross-PR leak. The body is PR-scoped (carries the PR ref) AND distinct per PR.
    [Fact]
    public async Task Summarizer_body_is_pr_specific_and_differs_across_prs()
    {
        IPrSummarizer s = new PlaceholderPrSummarizer();
        var a = new PrReference("acme", "api-server", 1842);
        var b = new PrReference("acme", "api-server", 99);

        var ra = await s.SummarizeAsync(a, CancellationToken.None);
        var rb = await s.SummarizeAsync(b, CancellationToken.None);

        ra!.Body.Should().Contain(a.PrId);
        rb!.Body.Should().Contain(b.PrId);
        ra.Body.Should().NotBe(rb.Body,
            because: "Preview samples must read as THIS PR's sample, not identical across PRs (#464)");
    }

    // Pins the CA1062 null guard added in #464: both public entry points reject a null PR.
    [Fact]
    public async Task Summarizer_throws_on_null_pr()
    {
        IPrSummarizer s = new PlaceholderPrSummarizer();

        Func<Task> summarize = () => s.SummarizeAsync(null!, CancellationToken.None);
        Func<Task> regenerate = () => s.RegenerateAsync(null!, CancellationToken.None);

        await summarize.Should().ThrowAsync<ArgumentNullException>();
        await regenerate.Should().ThrowAsync<ArgumentNullException>();
    }

    [Fact]
    public async Task FileFocusRanker_returns_at_least_one_file()
    {
        IFileFocusRanker s = new PlaceholderFileFocusRanker();
        var result = await s.RankAsync(Ref, CancellationToken.None);
        result.Entries.Should().NotBeEmpty();
        result.Fallback.Should().BeFalse();
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
