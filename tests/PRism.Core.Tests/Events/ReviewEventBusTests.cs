using FluentAssertions;
using PRism.Core.Events;

namespace PRism.Core.Tests.Events;

public sealed class ReviewEventBusTests
{
    private sealed record TestEvent(string Payload) : IReviewEvent;

    [Fact]
    public void ReviewEventBus_publish_with_no_subscribers_is_noop()
    {
        var bus = new ReviewEventBus();

        var act = () => bus.Publish(new TestEvent("hello"));

        act.Should().NotThrow();
    }

    [Fact]
    public void ReviewEventBus_publish_invokes_subscriber()
    {
        var bus = new ReviewEventBus();
        TestEvent? received = null;
        bus.Subscribe<TestEvent>(e => received = e);

        bus.Publish(new TestEvent("hello"));

        received.Should().NotBeNull();
        received!.Payload.Should().Be("hello");
    }

    [Fact]
    public void ReviewEventBus_dispose_subscription_unsubscribes()
    {
        var bus = new ReviewEventBus();
        var callCount = 0;
        var sub = bus.Subscribe<TestEvent>(_ => callCount++);

        sub.Dispose();
        bus.Publish(new TestEvent("after-dispose"));

        callCount.Should().Be(0);
    }

    [Fact]
    public void ReviewEventBus_throwing_subscriber_does_not_block_other_subscribers_or_publisher()
    {
        var bus = new ReviewEventBus();
        var secondReceived = false;
        bus.Subscribe<TestEvent>(_ => throw new InvalidOperationException("subscriber boom"));
        bus.Subscribe<TestEvent>(_ => secondReceived = true);

        var act = () => bus.Publish(new TestEvent("hello"));

        act.Should().NotThrow();
        secondReceived.Should().BeTrue("a faulting subscriber must not abort dispatch to the rest");
    }

    [Fact]
    public void ReviewEventBus_subscriber_OperationCanceledException_propagates()
    {
        var bus = new ReviewEventBus();
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        bus.Subscribe<TestEvent>(_ => cts.Token.ThrowIfCancellationRequested());

        var act = () => bus.Publish(new TestEvent("hello"));

        act.Should().Throw<OperationCanceledException>("cooperative cancellation is not swallowed by fault isolation");
    }
}
