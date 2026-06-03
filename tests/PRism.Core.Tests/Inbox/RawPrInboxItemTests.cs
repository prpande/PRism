using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.Core.Tests.Inbox;

public sealed class RawPrInboxItemTests
{
    [Fact]
    public void CloseState_DefaultsToNull_OnOpenRows()
    {
        var raw = new RawPrInboxItem(
            new PrReference("acme", "api", 1), "t", "a", "acme/api",
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0, 0, 0, "sha", 1);

        raw.MergedAt.Should().BeNull();
        raw.ClosedAt.Should().BeNull();
    }

    [Fact]
    public void CloseState_RoundTripsThroughWith()
    {
        var merged = DateTimeOffset.UtcNow;
        var raw = new RawPrInboxItem(
            new PrReference("acme", "api", 1), "t", "a", "acme/api",
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0, 0, 0, "sha", 1)
            with { MergedAt = merged, ClosedAt = merged };

        raw.MergedAt.Should().Be(merged);
        raw.ClosedAt.Should().Be(merged);
    }
}
