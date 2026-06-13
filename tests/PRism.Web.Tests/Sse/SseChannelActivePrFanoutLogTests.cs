using FluentAssertions;
using Microsoft.Extensions.Logging;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.PrDetail;
using PRism.Web.Sse;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Sse;

// Asserts s_sseActivePrFanoutLog (EventId 4) emits per OnActivePrUpdated with
// SubscriberCount matching registry.SubscribersFor(prRef).Count at publish time.
public class SseChannelActivePrFanoutLogTests
{
    [Fact]
    public void T_INV_4_fanout_log_fires_per_ActivePrUpdated_publish_with_correct_subscriber_count()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var logger = new CapturingLogger(4);
        using var channel = new SseChannel(bus, subs, registry, logger);

        var prRef = new PrReference("o", "r", 1);
        registry.Add("sub-A", prRef);
        registry.Add("sub-B", prRef);

        bus.Publish(new ActivePrUpdated(prRef, HeadShaChanged: true, CommentCountChanged: false, NewHeadSha: "h2", CommentCountDelta: 0));

        logger.Messages.Should().ContainSingle();
        var line = logger.Messages.Single();
        line.Should().Contain("SSE fan-out");
        line.Should().Contain("ActivePrUpdated");
        line.Should().Contain("subscribers=2");
        line.Should().Contain("headShaChanged=True");
        line.Should().Contain("commentCountChanged=False");
    }

    [Fact]
    public void T_INV_5_fanout_log_with_zero_subscribers_emits_SubscriberCount_zero_without_throw()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var logger = new CapturingLogger(4);
        using var channel = new SseChannel(bus, subs, registry, logger);

        var prRef = new PrReference("o", "r", 42);
        // Intentionally no registry.Add — verify the log still fires with subscribers=0.

        var act = () => bus.Publish(new ActivePrUpdated(prRef, HeadShaChanged: true, CommentCountChanged: false, NewHeadSha: "h-orphan", CommentCountDelta: 0));

        act.Should().NotThrow();
        logger.Messages.Should().ContainSingle();
        var line = logger.Messages.Single();
        line.Should().Contain("subscribers=0");
        line.Should().Contain("ActivePrUpdated");
    }
}
