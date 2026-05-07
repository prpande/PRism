using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;

namespace PRism.Core.Tests.PrDetail;

public class ActivePrSubscriberRegistryTests
{
    private static PrReference Pr(string owner, string repo, int number) => new(owner, repo, number);

    [Fact]
    public void Add_registers_pr_for_subscriber()
    {
        var r = new ActivePrSubscriberRegistry();
        r.Add("sub1", Pr("o", "r", 1));
        r.UniquePrRefs().Should().ContainSingle();
    }

    [Fact]
    public void Add_is_idempotent_for_same_subscriber_pr_pair()
    {
        var r = new ActivePrSubscriberRegistry();
        r.Add("sub1", Pr("o", "r", 1));
        r.Add("sub1", Pr("o", "r", 1));
        r.SubscribersFor(Pr("o", "r", 1)).Should().ContainSingle();
    }

    [Fact]
    public void Multiple_subscribers_to_same_pr_dedup_at_pr_level()
    {
        var r = new ActivePrSubscriberRegistry();
        r.Add("sub1", Pr("o", "r", 1));
        r.Add("sub2", Pr("o", "r", 1));
        r.UniquePrRefs().Should().ContainSingle();
        r.SubscribersFor(Pr("o", "r", 1)).Should().HaveCount(2);
    }

    [Fact]
    public void Remove_unsubscribes_pr_from_subscriber()
    {
        var r = new ActivePrSubscriberRegistry();
        r.Add("sub1", Pr("o", "r", 1));
        r.Remove("sub1", Pr("o", "r", 1));
        r.SubscribersFor(Pr("o", "r", 1)).Should().BeEmpty();
    }

    [Fact]
    public void RemoveSubscriber_clears_all_pr_subscriptions_for_that_subscriber()
    {
        var r = new ActivePrSubscriberRegistry();
        r.Add("sub1", Pr("o", "r", 1));
        r.Add("sub1", Pr("o", "r", 2));
        r.RemoveSubscriber("sub1");
        r.UniquePrRefs().Should().BeEmpty();
    }

    [Fact]
    public void Remove_unknown_pair_is_a_noop()
    {
        var r = new ActivePrSubscriberRegistry();
        var act = () => r.Remove("nosuch", Pr("o", "r", 1));
        act.Should().NotThrow();
    }
}
