using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using Xunit;

namespace PRism.Core.Tests.PrDetail;

public class ActivePrSubscriberRegistryRemoveAllTests
{
    [Fact]
    public void RemoveAll_ClearsBothMaps()
    {
        var reg = new ActivePrSubscriberRegistry();
        var pr1 = new PrReference("o", "r", 1);
        var pr2 = new PrReference("o", "r", 2);
        reg.Add("sub-a", pr1);
        reg.Add("sub-b", pr1);
        reg.Add("sub-b", pr2);

        reg.RemoveAll();

        reg.SubscribersFor(pr1).Should().BeEmpty();
        reg.SubscribersFor(pr2).Should().BeEmpty();
        reg.UniquePrRefs().Should().BeEmpty();
    }
}
