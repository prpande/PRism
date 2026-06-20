using FluentAssertions;
using PRism.Web.Ai;
using Xunit;

namespace PRism.Web.Tests.Ai;

public sealed class InboxCategoryTests
{
    [Theory]
    [InlineData("Feature", "Feature")]
    [InlineData("feature", "Feature")]
    [InlineData("Bug fix", "Bug fix")]
    [InlineData("bugfix", "Bug fix")]
    [InlineData("fix", "Bug fix")]
    [InlineData("refactoring", "Refactor")]
    [InlineData("documentation", "Docs")]
    [InlineData("docs", "Docs")]
    [InlineData("test-only", "Test-only")]
    [InlineData("tests", "Test-only")]
    [InlineData("chore", "Chore")]
    public void Normalize_maps_known_and_near_miss_labels(string raw, string expected)
        => InboxCategory.Normalize(raw).Should().Be(expected);

    [Theory]
    [InlineData("Other")]
    [InlineData("other")]
    [InlineData("banana")]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("   ")]
    public void Normalize_returns_null_for_other_unknown_or_empty(string? raw)
        => InboxCategory.Normalize(raw).Should().BeNull();

    [Fact]
    public void PromptLabels_are_the_seven_canonical_labels()
        => InboxCategory.PromptLabels.Should().Equal(
            "Feature", "Bug fix", "Refactor", "Docs", "Test-only", "Chore", "Other");
}
