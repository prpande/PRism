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

    // Owner B1 2026-06-19: the inbox Preview chip uses a generic, non-taxonomy sample word
    // ("Category") so it reads as a sample, distinct from the PR-detail summarizer's canonical
    // "Refactor" (which the summary card's taxonomy needs to render its chip). One enrichment is
    // emitted per input PR, keyed by PrId.
    [Fact]
    public async Task InboxItemEnricher_emits_generic_sample_category_per_item()
    {
        IInboxItemEnricher s = new PlaceholderInboxItemEnricher();
        var input = new[]
        {
            new PrInboxItem(
                Ref, "Title", "author", "acme/api",
                DateTimeOffset.UtcNow, DateTimeOffset.UtcNow,
                1, 0, 0, 0, "abc", CiStatus.None, null, null),
        };
        var result = await s.EnrichAsync(input, CancellationToken.None);
        result.Should().ContainSingle();
        result[0].PrId.Should().Be(Ref.PrId);
        result[0].CategoryChip.Should().Be("Category");
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

    [Fact]
    public async Task Summarizer_body_is_bulleted_markdown()
    {
        IPrSummarizer s = new PlaceholderPrSummarizer();
        var result = await s.SummarizeAsync(Ref, CancellationToken.None);
        // A bullet list line (lead sentence is its own paragraph above the bullets).
        result!.Body.Should().Contain("\n- ");
    }

    [Fact]
    public async Task FileFocus_rationale_is_synopsis_first_bulleted_markdown()
    {
        IFileFocusRanker s = new PlaceholderFileFocusRanker();
        var result = await s.RankAsync(Ref, CancellationToken.None);
        result.Entries.Should().NotBeEmpty();
        // Synopsis-first format: a headline line, then one or more "- " bullets.
        // The headline must not begin with a bullet; the body must contain bullets.
        result.Entries[0].Rationale.Should().NotStartWith("- ",
            because: "rationale must open with a synopsis headline, not a bullet (#520)");
        result.Entries[0].Rationale.Should().Contain("\n- ",
            because: "rationale body must carry at least one bullet after the synopsis (#520)");
    }

    [Fact]
    public async Task HunkAnnotation_body_is_bulleted_markdown_with_fenced_code()
    {
        IHunkAnnotator s = new PlaceholderHunkAnnotator();
        var result = await s.AnnotateAsync(Ref, string.Empty, 0, CancellationToken.None);
        result.Should().NotBeEmpty();
        result[0].Body.Should().StartWith("- ");
        result[0].Body.Should().Contain("```"); // exercises the popover fenced-code path
    }
}
