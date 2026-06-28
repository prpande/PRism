using System.Collections.Concurrent;
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
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Sse;

// Task 5 — SseChannel re-emits a targeted pr-updated on subscribe when the cache already
// holds a non-None readiness, and wakes the poller immediately on subscribe + on new-head fanout.
public class SseChannelMergeabilityTests
{
    // ---------------------------------------------------------------------------------
    // Test 1: re-emit is sent to the subscribing client when cache has non-None readiness
    // ---------------------------------------------------------------------------------
    [Fact]
    public async Task Subscribe_reemits_targeted_pr_updated_when_cached_readiness_non_none()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var cache = new FakeActivePrCache();
        var prRef = new PrReference("o", "r", 1);
        cache.Update(prRef, new ActivePrSnapshot("sha1", null, DateTimeOffset.UtcNow, MergeReadiness: MergeReadiness.Ready));
        using var channel = new SseChannel(bus, subs, registry, NullLogger<SseChannel>.Instance, cache);

        var bodyA = new CapturingStream(); // the subscribing client
        var bodyB = new CapturingStream(); // a bystander that must NOT receive the targeted re-emit
        var ctxA = new DefaultHttpContext { Response = { Body = bodyA } };
        var ctxB = new DefaultHttpContext { Response = { Body = bodyB } };
        using var ctsA = new CancellationTokenSource();
        using var ctsB = new CancellationTokenSource();

        var taskA = channel.RunSubscriberAsync(ctxA.Response, cookieSessionId: "c1", ctsA.Token);
        var taskB = channel.RunSubscriberAsync(ctxB.Response, cookieSessionId: "c2", ctsB.Token);
        await TestPoll.UntilAsync(() => subs.Current == 2, TimeSpan.FromSeconds(5));

        // B is connected but never calls TrySubscribe — it must not get the targeted re-emit.
        channel.TrySubscribe("c1", prRef);

        await TestPoll.UntilAsync(
            () => bodyA.WrittenString.Contains("event: pr-updated", StringComparison.Ordinal),
            TimeSpan.FromSeconds(5),
            "re-emit must arrive on the subscribing connection within 5s");

        bodyA.WrittenString.Should().Contain("event: pr-updated");
        bodyA.WrittenString.Should().Contain("\"mergeReadinessChanged\":true");
        bodyA.WrittenString.Should().Contain("\"mergeReadiness\":\"ready\"");
        bodyB.WrittenString.Should().NotContain("event: pr-updated",
            "the re-emit is targeted to the subscribing connection only, not broadcast to B");

        await ctsA.CancelAsync();
        await ctsB.CancelAsync();
        try { await taskA; } catch (OperationCanceledException) { } catch (IOException) { }
        try { await taskB; } catch (OperationCanceledException) { } catch (IOException) { }
    }

    // ---------------------------------------------------------------------------------
    // Test 2: no re-emit when the cache holds None (or has no entry)
    // ---------------------------------------------------------------------------------
    [Fact]
    public async Task Subscribe_emits_no_pr_updated_when_cached_readiness_is_none()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var cache = new FakeActivePrCache(); // no entries → GetCurrent returns null → readiness defaults to None
        using var channel = new SseChannel(bus, subs, registry, NullLogger<SseChannel>.Instance, cache);

        var body = new CapturingStream();
        var ctx = new DefaultHttpContext { Response = { Body = body } };
        using var cts = new CancellationTokenSource();
        var task = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: "c1", cts.Token);
        await TestPoll.UntilAsync(() => subs.Current == 1, TimeSpan.FromSeconds(5));

        channel.TrySubscribe("c1", new PrReference("o", "r", 1));

        // Give the fire-and-forget write path a generous window to write if it were incorrectly fired.
        await Task.Delay(500);
        body.WrittenString.Should().NotContain("event: pr-updated",
            "no re-emit when the cache has None readiness or no entry for the PR");

        await cts.CancelAsync();
        try { await task; } catch (OperationCanceledException) { } catch (IOException) { }
    }

    // ---------------------------------------------------------------------------------
    // Test 3: TrySubscribe wakes the poller immediately
    // ---------------------------------------------------------------------------------
    [Fact]
    public async Task Subscribe_requests_immediate_poll()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var poller = new FakeImmediateRefresh();
        using var channel = new SseChannel(bus, subs, registry, NullLogger<SseChannel>.Instance, poller: poller);

        var body = new CapturingStream();
        var ctx = new DefaultHttpContext { Response = { Body = body } };
        using var cts = new CancellationTokenSource();
        var task = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: "c1", cts.Token);
        await TestPoll.UntilAsync(() => subs.Current == 1, TimeSpan.FromSeconds(5));

        channel.TrySubscribe("c1", new PrReference("o", "r", 1));

        poller.WakeCount.Should().Be(1, "TrySubscribe must call RequestImmediateRefresh exactly once");

        await cts.CancelAsync();
        try { await task; } catch (OperationCanceledException) { } catch (IOException) { }
    }

    // ---------------------------------------------------------------------------------
    // Test 4: OnActivePrUpdated wakes the poller only when HeadShaChanged is true
    // ---------------------------------------------------------------------------------
    [Fact]
    public async Task HeadShaChanged_fanout_wakes_the_poller_non_headsha_does_not()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var poller = new FakeImmediateRefresh();
        using var channel = new SseChannel(bus, subs, registry, NullLogger<SseChannel>.Instance, poller: poller);

        var body = new CapturingStream();
        var ctx = new DefaultHttpContext { Response = { Body = body } };
        using var cts = new CancellationTokenSource();
        var task = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: "c1", cts.Token);
        await TestPoll.UntilAsync(() => subs.Current == 1, TimeSpan.FromSeconds(5));

        var prRef = new PrReference("o", "r", 1);
        channel.TrySubscribe("c1", prRef); // wake #1 from subscribe

        // HeadShaChanged=true → wake #2
        bus.Publish(new ActivePrUpdated(prRef, HeadShaChanged: true, CommentCountChanged: false, NewHeadSha: "h2", CommentCountDelta: 0));
        poller.WakeCount.Should().Be(2, "a HeadShaChanged=true fanout must wake the poller");

        // HeadShaChanged=false → no additional wake
        bus.Publish(new ActivePrUpdated(prRef, HeadShaChanged: false, CommentCountChanged: true, NewHeadSha: null, CommentCountDelta: 1));
        poller.WakeCount.Should().Be(2, "a HeadShaChanged=false fanout must NOT wake the poller");

        await cts.CancelAsync();
        try { await task; } catch (OperationCanceledException) { } catch (IOException) { }
    }

    // ---------------------------------------------------------------------------------
    // Test 5: subscribe re-emit must NOT carry explicit null for approver/count fields
    //         (an explicit null clobbers the frontend's snapshot() full-load values — #655)
    // ---------------------------------------------------------------------------------
    [Fact]
    public async Task Subscribe_reemit_omits_null_approver_and_count_fields()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var cache = new FakeActivePrCache();
        var prRef = new PrReference("o", "r", 1);
        cache.Update(prRef, new ActivePrSnapshot("sha1", null, DateTimeOffset.UtcNow, MergeReadiness: MergeReadiness.Ready));
        using var channel = new SseChannel(bus, subs, registry, NullLogger<SseChannel>.Instance, cache);

        var bodyA = new CapturingStream();
        var ctxA = new DefaultHttpContext { Response = { Body = bodyA } };
        using var ctsA = new CancellationTokenSource();
        var taskA = channel.RunSubscriberAsync(ctxA.Response, cookieSessionId: "c1", ctsA.Token);
        await TestPoll.UntilAsync(() => subs.Current == 1, TimeSpan.FromSeconds(5));

        channel.TrySubscribe("c1", prRef);

        await TestPoll.UntilAsync(
            () => bodyA.WrittenString.Contains("event: pr-updated", StringComparison.Ordinal),
            TimeSpan.FromSeconds(5),
            "re-emit must arrive within 5s");

        bodyA.WrittenString.Should().Contain("event: pr-updated");
        bodyA.WrittenString.Should().Contain("\"mergeReadiness\":\"ready\"");
        // The sparse re-emit must NOT carry approver/count fields as explicit null — an explicit
        // null would clobber the full-load approval count + reviewer popover via snapshot() (#621).
        bodyA.WrittenString.Should().NotContain("\"approvers\":null");
        bodyA.WrittenString.Should().NotContain("\"approvals\":null");
        bodyA.WrittenString.Should().NotContain("\"changesRequested\":null");
        bodyA.WrittenString.Should().NotContain("\"changesRequestedBy\":null");
        bodyA.WrittenString.Should().NotContain("\"awaitingReviewers\":null");

        await ctsA.CancelAsync();
        try { await taskA; } catch (OperationCanceledException) { } catch (IOException) { }
    }

    // ---------------------------------------------------------------------------------
    // Shared fakes
    // ---------------------------------------------------------------------------------

    private sealed class FakeActivePrCache : IActivePrCache
    {
        private readonly ConcurrentDictionary<PrReference, ActivePrSnapshot> _store = new();

        public bool IsSubscribed(PrReference prRef) => false;

        public ActivePrSnapshot? GetCurrent(PrReference prRef) =>
            _store.TryGetValue(prRef, out var snap) ? snap : null;

        public void Update(PrReference prRef, ActivePrSnapshot snapshot) =>
            _store[prRef] = snapshot;

        public void Clear() => _store.Clear();
    }

    private sealed class FakeImmediateRefresh : IImmediateRefresh
    {
        private int _wakeCount;
        public int WakeCount => Volatile.Read(ref _wakeCount);
        public void RequestImmediateRefresh() => Interlocked.Increment(ref _wakeCount);
    }

    // Thread-safe write-capturing stream for SSE frame assertions (mirrors SseChannelMultimapTests).
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
        public override void Flush() { }
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
