using System.IO;
using System.Text;
using FluentAssertions;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.PrDetail;
using PRism.Web.Sse;

namespace PRism.Web.Tests.Endpoints;

// Direct-construction tests for the SseChannel changes added in S3 PR5: cookie-session
// multimap, per-PR ActivePrUpdated fanout, and named heartbeat. SSE is exercised via a
// captured-buffer Stream so tests don't depend on real HTTP.
public class SseChannelMultimapTests
{
    [Fact]
    public void LatestSubscriberIdForCookieSession_returns_null_for_unknown_cookie()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        using var channel = new SseChannel(bus, subs, registry, NullLogger<SseChannel>.Instance);

        channel.LatestSubscriberIdForCookieSession("nosuch-cookie").Should().BeNull();
        channel.LatestSubscriberIdForCookieSession(null).Should().BeNull();
        channel.LatestSubscriberIdForCookieSession(string.Empty).Should().BeNull();
    }

    [Fact]
    public async Task LatestSubscriberIdForCookieSession_returns_latest_when_multiple_connections_share_cookie()
    {
        // Multimap shape: two simultaneous SSE connections with the same cookie value
        // (multi-tab dogfood). POST/DELETE resolve to the most recent subscriberId.
        // See deferrals sidecar [Skip] entry for why this beats last-SSE-wins or reject-second.
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        using var channel = new SseChannel(bus, subs, registry, NullLogger<SseChannel>.Instance);

        var ctx1 = new DefaultHttpContext { Response = { Body = new MemoryStream() } };
        var ctx2 = new DefaultHttpContext { Response = { Body = new MemoryStream() } };

        using var cts1 = new CancellationTokenSource();
        using var cts2 = new CancellationTokenSource();
        var task1 = channel.RunSubscriberAsync(ctx1.Response, cookieSessionId: "shared-cookie", cts1.Token);

        await WaitFor(() => subs.Current == 1, TimeSpan.FromSeconds(5));
        var firstId = channel.LatestSubscriberIdForCookieSession("shared-cookie");
        firstId.Should().NotBeNullOrEmpty();

        var task2 = channel.RunSubscriberAsync(ctx2.Response, cookieSessionId: "shared-cookie", cts2.Token);
        await WaitFor(() => subs.Current == 2, TimeSpan.FromSeconds(5));

        var latestId = channel.LatestSubscriberIdForCookieSession("shared-cookie");
        latestId.Should().NotBeNullOrEmpty();
        latestId.Should().NotBe(firstId, "second connection should be at the tail of the cookie's subscriber list");

        // Closing the second connection makes the first the latest again — proves the
        // multimap actually unhooks closed connections rather than leaking them.
        await cts2.CancelAsync();
        try { await task2; } catch (OperationCanceledException) { } catch (IOException) { }
        await WaitFor(() => subs.Current == 1, TimeSpan.FromSeconds(5));
        channel.LatestSubscriberIdForCookieSession("shared-cookie").Should().Be(firstId);

        await cts1.CancelAsync();
        try { await task1; } catch (OperationCanceledException) { } catch (IOException) { }
    }

    [Fact]
    public async Task ActivePrUpdated_publishes_only_to_subscribers_registered_for_that_pr()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        using var channel = new SseChannel(bus, subs, registry, NullLogger<SseChannel>.Instance);

        var bodyA = new CapturingStream();
        var bodyB = new CapturingStream();
        var ctxA = new DefaultHttpContext { Response = { Body = bodyA } };
        var ctxB = new DefaultHttpContext { Response = { Body = bodyB } };

        using var ctsA = new CancellationTokenSource();
        using var ctsB = new CancellationTokenSource();
        var taskA = channel.RunSubscriberAsync(ctxA.Response, cookieSessionId: "cookie-A", ctsA.Token);
        var taskB = channel.RunSubscriberAsync(ctxB.Response, cookieSessionId: "cookie-B", ctsB.Token);
        await WaitFor(() => subs.Current == 2, TimeSpan.FromSeconds(5));

        var subA = channel.LatestSubscriberIdForCookieSession("cookie-A")!;
        var subB = channel.LatestSubscriberIdForCookieSession("cookie-B")!;
        var prX = new PrReference("o", "r", 1);
        var prY = new PrReference("o", "r", 2);
        registry.Add(subA, prX);  // A subscribes to PR X only
        registry.Add(subB, prY);  // B subscribes to PR Y only

        // Publish a PR X update — only A should receive it.
        bus.Publish(new ActivePrUpdated(prX, HeadShaChanged: true, CommentCountChanged: false, NewHeadSha: "h-new", NewCommentCount: null));
        await WaitFor(() => bodyA.WrittenString.Contains("event: pr-updated", StringComparison.Ordinal), TimeSpan.FromSeconds(5));

        bodyA.WrittenString.Should().Contain("event: pr-updated");
        bodyA.WrittenString.Should().Contain("h-new");
        bodyB.WrittenString.Should().NotContain("event: pr-updated",
            "subscriber B did not register for PR X and must NOT receive its update");

        await ctsA.CancelAsync();
        await ctsB.CancelAsync();
        try { await taskA; } catch (OperationCanceledException) { } catch (IOException) { }
        try { await taskB; } catch (OperationCanceledException) { } catch (IOException) { }
    }

    [Fact]
    public async Task SseSubscriber_disconnect_removes_subscriberId_from_registry()
    {
        // When the SSE connection closes, the registry must be cleared so the poller
        // stops polling PRs whose only subscriber is gone.
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        using var channel = new SseChannel(bus, subs, registry, NullLogger<SseChannel>.Instance);

        var body = new CapturingStream();
        var ctx = new DefaultHttpContext { Response = { Body = body } };
        using var cts = new CancellationTokenSource();
        var task = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: "c1", cts.Token);
        await WaitFor(() => subs.Current == 1, TimeSpan.FromSeconds(5));

        var subId = channel.LatestSubscriberIdForCookieSession("c1")!;
        registry.Add(subId, new PrReference("o", "r", 1));
        registry.UniquePrRefs().Should().HaveCount(1);

        await cts.CancelAsync();
        try { await task; } catch (OperationCanceledException) { } catch (IOException) { }

        registry.UniquePrRefs().Should().BeEmpty(
            "SseChannel.RunSubscriberAsync's finally must call registry.RemoveSubscriber so the poller drops empty PRs");
    }

    private static async Task WaitFor(Func<bool> predicate, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (!predicate() && DateTime.UtcNow < deadline)
            await Task.Delay(10, CancellationToken.None);
    }

    // Minimal write-capturing stream for assertions on SSE frame content. Threadsafe via lock.
    private sealed class CapturingStream : Stream
    {
        private readonly MemoryStream _buf = new();
        private readonly object _gate = new();

        public string WrittenString
        {
            get { lock (_gate) return Encoding.UTF8.GetString(_buf.ToArray()); }
        }

        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { /* no-op */ }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count)
        {
            lock (_gate) _buf.Write(buffer, offset, count);
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            lock (_gate) _buf.Write(buffer, offset, count);
            return Task.CompletedTask;
        }

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            lock (_gate) _buf.Write(buffer.Span);
            return ValueTask.CompletedTask;
        }

        public override Task FlushAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }
}
