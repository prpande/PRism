using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Web.TestHooks;
using Xunit;

namespace PRism.Web.Tests.TestHooks;

public class FakeReviewBackingStoreTests
{
    [Theory]
    [InlineData("OPEN", PrState.Open)]
    [InlineData("open", PrState.Open)]
    [InlineData("CLOSED", PrState.Closed)]
    [InlineData("merged", PrState.Merged)]
    public void SetPrState_parses_case_insensitively_into_the_enum(string input, PrState expected)
    {
        var store = new FakeReviewBackingStore();
        store.SetPrState(input);
        store.PrState.Should().Be(expected);
    }

    [Fact]
    public void SetPrState_derives_bools_from_the_enum()
    {
        var store = new FakeReviewBackingStore();
        store.SetPrState("MERGED");
        store.IsMerged.Should().BeTrue();
        store.IsClosed.Should().BeFalse();   // merged is not "closed without merging"

        store.SetPrState("CLOSED");
        store.IsClosed.Should().BeTrue();
        store.IsMerged.Should().BeFalse();
    }

    [Theory]
    [InlineData("garbage")]
    [InlineData("1")]
    public void SetPrState_throws_on_unknown_state(string input)
    {
        var store = new FakeReviewBackingStore();
        var act = () => store.SetPrState(input);
        act.Should().Throw<ArgumentException>();
    }
}
