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
    public void Does_not_reference_ci_failing_pair()
    {
        // The ci-failing > authored-by-me pair was removed in #262. A legacy snapshot
        // that still carries a ci-failing key (version-skewed client) must NOT cause
        // authored-by-me to be demoted — there is no such pair anymore.
        var pr = new PrInboxItem(new PrReference("acme", "api", 1), "t", "a", "acme/api",
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 1, 0, 0, 0, "sha", CiStatus.Failing, null, null);
        var sections = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["authored-by-me"] = new[] { pr },
            ["ci-failing"]     = new[] { pr },   // legacy shape; must NOT be collapsed now
        };

        var result = _sut.Deduplicate(sections, deduplicate: true);

        result["authored-by-me"].Should().ContainSingle();   // not demoted away by a ci-failing winner
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
    public void Pr_in_review_requested_and_mentioned_and_authored_resolves_per_pair()
    {
        // PR 1 is in review-requested+mentioned (resolves to review-requested).
        // authored-by-me is NOT in any pair with review-requested, so it keeps the PR.
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = new[] { Pr(1) },
            ["authored-by-me"] = new[] { Pr(1) },
            ["mentioned"] = new[] { Pr(1) },
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        result["review-requested"].Should().ContainSingle();
        result["mentioned"].Should().BeEmpty();
        result["authored-by-me"].Should().ContainSingle(); // no pair removes it
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
        // Pins that input insertion order is preserved through the dedup pass.
        // This is NOT canonical UI order (which is the endpoint's SectionOrder job).
        // Do NOT remove the endpoint's OrderBy reasoning that this test makes it safe —
        // the deduplicator makes no ordering guarantees beyond echoing back what it received.
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = Array.Empty<PrInboxItem>(),
            ["awaiting-author"] = Array.Empty<PrInboxItem>(),
            ["authored-by-me"] = Array.Empty<PrInboxItem>(),
            ["mentioned"] = Array.Empty<PrInboxItem>(),
            ["recently-closed"] = Array.Empty<PrInboxItem>(),
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        result.Keys.Should().ContainInOrder(
            "review-requested", "awaiting-author", "authored-by-me", "mentioned", "recently-closed");
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
        // review-requested+mentioned share PR 1 → mentioned drops it.
        // authored-by-me and awaiting-author are not in any pair, so they keep their PRs.
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = new[] { Pr(1), Pr(2) },
            ["awaiting-author"] = new[] { Pr(3) },
            ["authored-by-me"] = new[] { Pr(4), Pr(5) },
            ["mentioned"] = new[] { Pr(1), Pr(6) },
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        // PR 1 is in review-requested (winner) and mentioned (loser — dropped).
        result["review-requested"].Should().Contain(p => p.Reference.Number == 1);
        result["mentioned"].Should().NotContain(p => p.Reference.Number == 1);
        result["mentioned"].Should().Contain(p => p.Reference.Number == 6);
    }
}
