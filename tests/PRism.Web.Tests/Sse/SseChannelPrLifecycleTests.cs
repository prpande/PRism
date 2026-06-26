using System.IO;
using System.Text.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Http;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.Json;
using PRism.Core.PrDetail;
using PRism.Web.Sse;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Sse;

// #566 — SseChannel subscribes to PrLifecycleChanged and fans it out per-PR as
// `pr-lifecycle-changed`. The projection test verifies the wire record and event name;
// the fan-out test verifies the delivery log; the Dispose test guards the security finding
// that the new subscription must be released on channel teardown.
public class SseChannelPrLifecycleTests
{
    // Projection contract test (no channel needed).
    [Fact]
    public void PrLifecycleChanged_projects_to_pr_lifecycle_changed_with_string_pr_ref()
    {
        var evt = new PrLifecycleChanged(new PrReference("acme", "api", 123));
        var (eventName, payload) = SseEventProjection.Project(evt);
        var json = JsonSerializer.Serialize(payload, JsonSerializerOptionsFactory.Api);
        eventName.Should().Be("pr-lifecycle-changed");
        json.Should().Contain("\"prRef\":\"acme/api/123\"");
    }

    [Fact]
    public async Task PrLifecycleChanged_fans_out_to_subscribed_pr()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var logger = new CapturingLogger(5);
        using var channel = new SseChannel(bus, subs, registry, logger);

        var ctx = new DefaultHttpContext { Response = { Body = new MemoryStream() } };
        using var cts = new CancellationTokenSource();
        var subscriberTask = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: "c1", cts.Token);

        await TestPoll.UntilAsync(() => subs.Current == 1, TimeSpan.FromSeconds(5));
        var subscriberId = channel.LatestSubscriberIdForCookieSession("c1")!;
        var prRef = new PrReference("o", "r", 1);
        registry.Add(subscriberId, prRef);

        bus.Publish(new PrLifecycleChanged(prRef));

        await TestPoll.UntilAsync(() => !logger.Messages.IsEmpty, TimeSpan.FromSeconds(5));
        var line = logger.Messages.Single();
        line.Should().Contain("PrLifecycleChanged");
        line.Should().Contain("success=True");

        await cts.CancelAsync();
        try { await subscriberTask; } catch (OperationCanceledException) { } catch (IOException) { }
    }

    [Fact]
    public async Task Dispose_releases_the_PrLifecycleChanged_subscription()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var logger = new CapturingLogger(5);
        var channel = new SseChannel(bus, subs, registry, logger);

        var ctx = new DefaultHttpContext { Response = { Body = new MemoryStream() } };
        using var cts = new CancellationTokenSource();
        var subscriberTask = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: "c1", cts.Token);
        await TestPoll.UntilAsync(() => subs.Current == 1, TimeSpan.FromSeconds(5));
        var subscriberId = channel.LatestSubscriberIdForCookieSession("c1")!;
        var prRef = new PrReference("o", "r", 1);
        registry.Add(subscriberId, prRef);

        channel.Dispose();
        bus.Publish(new PrLifecycleChanged(prRef));

        await Task.Delay(500);
        logger.Messages.Should().BeEmpty("Dispose must unsubscribe PrLifecycleChanged");

        await cts.CancelAsync();
        try { await subscriberTask; } catch (OperationCanceledException) { } catch (IOException) { }
    }
}
