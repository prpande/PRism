using FluentAssertions;
using PRism.Core.Contracts;
using Xunit;

namespace PRism.Core.Tests.Contracts;

public sealed class MergeReadinessRuleTests
{
    // Terminal states win over every merge signal (the merged-PR fix, by construction).
    [Theory]
    [InlineData(PrState.Merged, "CONFLICTING", "DIRTY", "CHANGES_REQUESTED", MergeReadiness.Merged)]
    [InlineData(PrState.Merged, "MERGEABLE", "CLEAN", "APPROVED", MergeReadiness.Merged)]
    [InlineData(PrState.Closed, "CONFLICTING", "DIRTY", null, MergeReadiness.Closed)]
    public void Terminal_state_wins(PrState state, string? mergeable, string? mss, string? rd, MergeReadiness expected)
        => MergeReadinessRule.Derive(state, isDraft: false, mergeable, mss, rd).Should().Be(expected);

    // Draft -> None regardless of signals (badge renders nothing).
    [Theory]
    [InlineData(true, "CLEAN", "APPROVED")]
    [InlineData(false, "DRAFT", null)] // mergeStateStatus == DRAFT
    public void Draft_is_none(bool isDraft, string mss, string? rd)
        => MergeReadinessRule.Derive(PrState.Open, isDraft, "MERGEABLE", mss, rd).Should().Be(MergeReadiness.None);

    // Conflicts dominate every weaker mergeStateStatus (cross-axis matrix, spec §4/§10).
    [Theory]
    [InlineData("CONFLICTING", "BEHIND")]
    [InlineData("CONFLICTING", "BLOCKED")]
    [InlineData("CONFLICTING", "UNSTABLE")]
    [InlineData("CONFLICTING", "CLEAN")]
    [InlineData("CONFLICTING", "UNKNOWN")]
    [InlineData("MERGEABLE", "DIRTY")]
    public void Conflicts_dominate(string mergeable, string mss)
        => MergeReadinessRule.Derive(PrState.Open, false, mergeable, mss, null).Should().Be(MergeReadiness.Conflicts);

    [Fact]
    public void Behind_base()
        => MergeReadinessRule.Derive(PrState.Open, false, "MERGEABLE", "BEHIND", null).Should().Be(MergeReadiness.BehindBase);

    // BLOCKED granularity is the review/protection axis.
    [Theory]
    [InlineData("CHANGES_REQUESTED", MergeReadiness.ChangesRequested)]
    [InlineData("REVIEW_REQUIRED", MergeReadiness.ReviewRequired)]
    [InlineData("APPROVED", MergeReadiness.BlockedByProtection)]
    [InlineData(null, MergeReadiness.BlockedByProtection)]
    public void Blocked_splits_on_review_decision(string? rd, MergeReadiness expected)
        => MergeReadinessRule.Derive(PrState.Open, false, "MERGEABLE", "BLOCKED", rd).Should().Be(expected);

    [Fact]
    public void Unstable()
        => MergeReadinessRule.Derive(PrState.Open, false, "MERGEABLE", "UNSTABLE", null).Should().Be(MergeReadiness.Unstable);

    // Clean + a reviewer requested changes (protection doesn't require review) -> dimmed-green variant.
    [Theory]
    [InlineData("CLEAN")]
    [InlineData("HAS_HOOKS")]
    public void Ready_with_changes_requested(string mss)
        => MergeReadinessRule.Derive(PrState.Open, false, "MERGEABLE", mss, "CHANGES_REQUESTED")
            .Should().Be(MergeReadiness.ReadyWithChangesRequested);

    [Theory]
    [InlineData("CLEAN", "APPROVED")]
    [InlineData("CLEAN", null)]
    [InlineData("HAS_HOOKS", "REVIEW_REQUIRED")] // clean + no block -> Ready (review not required by protection)
    public void Ready(string mss, string? rd)
        => MergeReadinessRule.Derive(PrState.Open, false, "MERGEABLE", mss, rd).Should().Be(MergeReadiness.Ready);

    // Unknown / null / unrecognized -> None, never throw.
    [Theory]
    [InlineData("UNKNOWN", null)]
    [InlineData(null, null)]
    [InlineData("SOMETHING_NEW", "ALSO_NEW")]
    [InlineData("UNKNOWN", "UNKNOWN")]
    public void Unknown_is_none(string? mss, string? rd)
        => MergeReadinessRule.Derive(PrState.Open, false, "UNKNOWN", mss, rd).Should().Be(MergeReadiness.None);

    // Case-insensitivity (REST mergeable_state is lowercase).
    [Fact]
    public void Case_insensitive()
        => MergeReadinessRule.Derive(PrState.Open, false, "mergeable", "clean", "approved").Should().Be(MergeReadiness.Ready);

    // Kebab-case wire form via the global converter.
    [Theory]
    [InlineData(MergeReadiness.BehindBase, "\"behind-base\"")]
    [InlineData(MergeReadiness.ReadyWithChangesRequested, "\"ready-with-changes-requested\"")]
    [InlineData(MergeReadiness.None, "\"none\"")]
    public void Serializes_kebab_case(MergeReadiness value, string expectedJson)
        => System.Text.Json.JsonSerializer.Serialize(value, PRism.Core.Json.JsonSerializerOptionsFactory.Api)
            .Should().Be(expectedJson);
}
