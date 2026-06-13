using System.IO;
using FluentAssertions;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.PrDetail;
using PRism.Web.Sse;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Sse;

// #392 — SseChannel subscribes to DraftSubmitted and fans it out per-PR as the
// `draft-submitted` SSE event (the post-submit PR-detail reload trigger). The delivery
// log (EventId 5) carries the event type name, so we assert against it the same way the
// ActivePrUpdated delivery-log tests do. The Dispose test guards the security-review
// finding that the new subscription must be released on channel teardown.
public class SseChannelDraftSubmittedTests
{
    [Fact]
    public async Task DraftSubmitted_fans_out_to_subscribed_pr()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var logger = new CapturingLogger(5);
        using var channel = new SseChannel(bus, subs, registry, logger);

        var ctx = new DefaultHttpContext { Response = { Body = new MemoryStream() } };
        using var cts = new CancellationTokenSource();
        var subscriberTask = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: "c1", cts.Token);

        await WaitFor(() => subs.Current == 1, TimeSpan.FromSeconds(5));

        var subscriberId = channel.LatestSubscriberIdForCookieSession("c1")!;
        var prRef = new PrReference("o", "r", 1);
        registry.Add(subscriberId, prRef);

        bus.Publish(new DraftSubmitted(prRef));

        await WaitFor(() => !logger.Messages.IsEmpty, TimeSpan.FromSeconds(5));

        var line = logger.Messages.Single();
        line.Should().Contain("SSE delivery");
        line.Should().Contain("DraftSubmitted");
        line.Should().Contain($"subscriber={subscriberId}");
        line.Should().Contain("success=True");

        await cts.CancelAsync();
        try { await subscriberTask; } catch (OperationCanceledException) { } catch (IOException) { }
    }

    [Fact]
    public async Task Dispose_releases_the_DraftSubmitted_subscription()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var logger = new CapturingLogger(5);
        var channel = new SseChannel(bus, subs, registry, logger);

        var ctx = new DefaultHttpContext { Response = { Body = new MemoryStream() } };
        using var cts = new CancellationTokenSource();
        var subscriberTask = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: "c1", cts.Token);

        await WaitFor(() => subs.Current == 1, TimeSpan.FromSeconds(5));
        var subscriberId = channel.LatestSubscriberIdForCookieSession("c1")!;
        var prRef = new PrReference("o", "r", 1);
        registry.Add(subscriberId, prRef);

        // Dispose must release the DraftSubmitted subscription. A post-Dispose publish must
        // not reach the channel's fanout — otherwise the bus retains a handler against a
        // torn-down channel (the SseChannel.Dispose() omission the security review flagged).
        channel.Dispose();

        bus.Publish(new DraftSubmitted(prRef));

        await Task.Delay(500);
        logger.Messages.Should().BeEmpty("Dispose must unsubscribe DraftSubmitted so a post-teardown publish is not fanned out");

        await cts.CancelAsync();
        try { await subscriberTask; } catch (OperationCanceledException) { } catch (IOException) { }
    }

    private static async Task WaitFor(Func<bool> predicate, TimeSpan timeout)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (sw.Elapsed < timeout)
        {
            if (predicate()) return;
            await Task.Delay(20);
        }
        throw new TimeoutException($"WaitFor predicate did not become true within {timeout.TotalSeconds:F1}s");
    }
}
