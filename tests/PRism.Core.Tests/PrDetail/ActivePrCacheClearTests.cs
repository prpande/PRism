using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using Xunit;

namespace PRism.Core.Tests.PrDetail;

public class ActivePrCacheClearTests
{
    [Fact]
    public void Clear_RemovesAllEntries()
    {
        var cache = new ActivePrCache(new ActivePrSubscriberRegistry());
        var pr1 = new PrReference("octocat", "Hello-World", 1);
        var pr2 = new PrReference("octocat", "Hello-World", 2);
        cache.Update(pr1, new ActivePrSnapshot("sha-a", null, DateTimeOffset.UtcNow));
        cache.Update(pr2, new ActivePrSnapshot("sha-b", null, DateTimeOffset.UtcNow));

        cache.Clear();

        cache.GetCurrent(pr1).Should().BeNull();
        cache.GetCurrent(pr2).Should().BeNull();
    }

    [Fact]
    public void Clear_EmptyCache_DoesNotThrow()
    {
        var act = () => new ActivePrCache(new ActivePrSubscriberRegistry()).Clear();
        act.Should().NotThrow();
    }
}
