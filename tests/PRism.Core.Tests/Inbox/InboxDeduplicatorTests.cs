using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.Core.Tests.Inbox;

public sealed class InboxDeduplicatorTests
{
    private static PrInboxItem Pr(int n, string repo = "acme/api")
    {
        var parts = repo.Split('/');
        return new PrInboxItem(
            new PrReference(parts[0], parts[1], n),
            $"PR #{n}", "author", repo,
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow,
            1, 0, 0, 0, $"sha{n}", CiStatus.None, null, null);
    }

    private readonly IInboxDeduplicator _sut = new InboxDeduplicator();

    [Fact]
    public void When_dedupe_off_returns_input_unchanged()
    {
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = new[] { Pr(1) },
            ["mentioned"] = new[] { Pr(1) },
        };

        var result = _sut.Deduplicate(input, deduplicate: false);

        result["review-requested"].Should().HaveCount(1);
        result["mentioned"].Should().HaveCount(1);
    }

    [Fact]
    public void Pr_in_section_1_and_4_appears_only_in_section_1()
    {
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = new[] { Pr(1) },
            ["mentioned"] = new[] { Pr(1) },
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        result["review-requested"].Should().ContainSingle(p => p.Reference.Number == 1);
        result["mentioned"].Should().BeEmpty();
    }

    [Fact]
    public void Pr_in_section_3_and_5_appears_only_in_section_5()
    {
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["authored-by-me"] = new[] { Pr(1) },
            ["ci-failing"] = new[] { Pr(1) },
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        result["authored-by-me"].Should().BeEmpty();
        result["ci-failing"].Should().ContainSingle(p => p.Reference.Number == 1);
    }

    [Fact]
    public void Pr_in_unrelated_pair_is_not_deduplicated()
    {
        // section 1 + section 3 is NOT a dedupe pair
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = new[] { Pr(1) },
            ["authored-by-me"] = new[] { Pr(1) },
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        result["review-requested"].Should().HaveCount(1);
        result["authored-by-me"].Should().HaveCount(1);
    }

    [Fact]
    public void Pr_in_all_four_dedupe_groups_resolves_per_pair()
    {
        // PR 1 is in 1+4 (resolves to 1) AND in 3+5 (resolves to 5)
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = new[] { Pr(1) },
            ["authored-by-me"] = new[] { Pr(1) },
            ["mentioned"] = new[] { Pr(1) },
            ["ci-failing"] = new[] { Pr(1) },
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        result["review-requested"].Should().ContainSingle();
        result["mentioned"].Should().BeEmpty();
        result["authored-by-me"].Should().BeEmpty();
        result["ci-failing"].Should().ContainSingle();
    }

    [Fact]
    public void Empty_input_returns_empty()
    {
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>();
        var result = _sut.Deduplicate(input, deduplicate: true);
        result.Should().BeEmpty();
    }

    [Fact]
    public void Section_ordering_preserved()
    {
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = Array.Empty<PrInboxItem>(),
            ["awaiting-author"] = Array.Empty<PrInboxItem>(),
            ["authored-by-me"] = Array.Empty<PrInboxItem>(),
            ["mentioned"] = Array.Empty<PrInboxItem>(),
            ["ci-failing"] = Array.Empty<PrInboxItem>(),
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        result.Keys.Should().ContainInOrder(
            "review-requested", "awaiting-author", "authored-by-me", "mentioned", "ci-failing");
    }

    [Fact]
    public void Two_distinct_prs_unchanged_by_dedupe()
    {
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = new[] { Pr(1) },
            ["mentioned"] = new[] { Pr(2) },
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        result["review-requested"].Should().HaveCount(1);
        result["mentioned"].Should().HaveCount(1);
    }

    [Fact]
    public void Hidden_section_in_dedupe_pair_is_no_op()
    {
        // mentioned section is hidden => dropped from input. PR 1 stays in review-requested.
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = new[] { Pr(1) },
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        result["review-requested"].Should().HaveCount(1);
        result.ContainsKey("mentioned").Should().BeFalse();
    }

    [Fact]
    public void No_pr_appears_in_two_sections_after_dedupe()
    {
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = new[] { Pr(1), Pr(2) },
            ["awaiting-author"] = new[] { Pr(3) },
            ["authored-by-me"] = new[] { Pr(4), Pr(5) },
            ["mentioned"] = new[] { Pr(1), Pr(6) },
            ["ci-failing"] = new[] { Pr(4) },
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        var allRefs = result.Values.SelectMany(v => v).Select(p => p.Reference).ToList();
        allRefs.Should().OnlyHaveUniqueItems();
    }
}
