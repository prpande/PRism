using FluentAssertions;
using PRism.Core.Inbox;
using Xunit;

namespace PRism.Core.Tests.Inbox;

public sealed class AwaitingAuthorRuleTests
{
    [Fact]
    public void Awaiting_when_last_review_sha_differs_from_head()
        => AwaitingAuthorRule.IsAwaitingAuthor("oldsha", "newsha").Should().BeTrue();

    [Fact]
    public void Not_awaiting_when_last_review_sha_equals_head()
        => AwaitingAuthorRule.IsAwaitingAuthor("samesha", "samesha").Should().BeFalse();

    [Fact]
    public void Not_awaiting_when_no_comparable_review()
        => AwaitingAuthorRule.IsAwaitingAuthor(null, "newsha").Should().BeFalse();
}
