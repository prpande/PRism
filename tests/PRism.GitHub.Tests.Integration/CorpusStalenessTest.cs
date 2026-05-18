using FluentAssertions;
using Xunit;

namespace PRism.GitHub.Tests.Integration;

// Non-Integration: deliberately NO [Trait("Category", "Integration")]. This test must run on
// every `dotnet test` invocation so the build breaks loudly when the corpus ages out.
// Spec § 10 enforced staleness trigger.
public class CorpusStalenessTest
{
    [Fact]
    public void Corpus_has_at_least_one_pr_merged_within_18_months()
    {
        var threshold = DateTimeOffset.UtcNow.AddMonths(-18);
        var mostRecent = FrozenPrCorpus.All().Max(e => e.MergedAt);
        mostRecent.Should().BeAfter(threshold,
            $"The most recent corpus PR was merged at {mostRecent:O}, more than 18 months ago. " +
            "Add a ≤6-month-old PR on the same shape-criteria per docs/contract-tests.md § 5; " +
            "optionally retire the oldest PR if its shape category is still represented.");
    }
}
