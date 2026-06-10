using FluentAssertions;
using PRism.Core.Activity;
using Xunit;

namespace PRism.Core.Tests.Activity;

public sealed class NotificationReasonMapTests
{
    [Theory]
    [InlineData("review_requested", ActivityVerb.ReviewRequested)]
    [InlineData("mention", ActivityVerb.Mentioned)]
    [InlineData("team_mention", ActivityVerb.Mentioned)]
    [InlineData("comment", ActivityVerb.Commented)]
    [InlineData("subscribed", ActivityVerb.Other)]
    [InlineData("state_change", ActivityVerb.Other)]
    [InlineData("ci_activity", ActivityVerb.Other)]
    [InlineData("", ActivityVerb.Other)]
    [InlineData("totally-unknown", ActivityVerb.Other)]
    public void Maps_reason_to_verb(string reason, ActivityVerb expected)
        => NotificationReasonMap.ToVerb(reason).Should().Be(expected);

    [Theory]
    [InlineData(ActivityVerb.ReviewRequested, true)]
    [InlineData(ActivityVerb.Mentioned, true)]
    [InlineData(ActivityVerb.Commented, false)]
    [InlineData(ActivityVerb.Other, false)]
    public void Flags_you_relevant_verbs(ActivityVerb v, bool expected)
        => NotificationReasonMap.IsYouRelevant(v).Should().Be(expected);
}
