using System.Collections.Concurrent;
using System.IO;
using FluentAssertions;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.PrDetail;
using PRism.Web.Sse;

namespace PRism.Web.Tests.Sse;

// Asserts s_sseActivePrDeliveryLog (EventId 5) emits per per-subscriber
// WriteAsync attempt — Success=true on completion, Success=false on eviction.
public class SseChannelActivePrDeliveryLogTests
{
    private sealed class CapturingLogger : ILogger<SseChannel>
    {
        public ConcurrentBag<string> Messages { get; } = new();
        public IDisposable BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            ArgumentNullException.ThrowIfNull(formatter);
            if (eventId.Id == 5) Messages.Add(formatter(state, exception));
        }
        private sealed class NullScope : IDisposable { public static readonly NullScope Instance = new(); public void Dispose() { } }
    }

    // Succeeds on the first write call family (handshake), faults on all subsequent writes.
    // This allows RunSubscriberAsync to register the subscriber before the delivery
    // attempt fails, so LatestSubscriberIdForCookieSession returns a non-null value.
    // Both Write and WriteAsync paths are counted so the threshold is independent of
    // which Stream.Write overload the ASP.NET Core response pipeline selects.
    private sealed class FaultingStream : Stream
    {
        private int _writeCount;
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => 0;
        public override long Position { get => 0; set { } }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => 0;
        public override long Seek(long offset, SeekOrigin origin) => 0;
        public override void SetLength(long value) { }

        private bool ShouldFault() => Interlocked.Increment(ref _writeCount) > 1;

        public override void Write(byte[] buffer, int offset, int count)
        {
            if (ShouldFault()) throw new IOException("simulated socket failure");
        }

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (ShouldFault()) throw new IOException("simulated socket failure");
            return ValueTask.CompletedTask;
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            if (ShouldFault()) throw new IOException("simulated socket failure");
            return Task.CompletedTask;
        }
    }

    [Fact]
    public async Task T_INV_6_delivery_log_emits_Success_true_on_successful_write()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var logger = new CapturingLogger();
        using var channel = new SseChannel(bus, subs, registry, logger);

        var ctx = new DefaultHttpContext { Response = { Body = new MemoryStream() } };
        using var cts = new CancellationTokenSource();
        var subscriberTask = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: "c1", cts.Token);

        await WaitFor(() => subs.Current == 1, TimeSpan.FromSeconds(5));

        var subscriberId = channel.LatestSubscriberIdForCookieSession("c1")!;
        var prRef = new PrReference("o", "r", 1);
        registry.Add(subscriberId, prRef);

        bus.Publish(new ActivePrUpdated(prRef, HeadShaChanged: true, CommentCountChanged: false, NewHeadSha: "h2", NewCommentCount: null));

        await WaitFor(() => !logger.Messages.IsEmpty, TimeSpan.FromSeconds(5));

        logger.Messages.Should().ContainSingle();
        var line = logger.Messages.Single();
        line.Should().Contain("SSE delivery");
        line.Should().Contain("ActivePrUpdated");
        line.Should().Contain($"subscriber={subscriberId}");
        line.Should().Contain("success=True");

        await cts.CancelAsync();
        try { await subscriberTask; } catch (OperationCanceledException) { } catch (IOException) { }
    }

    [Fact]
    public async Task T_INV_6b_delivery_log_emits_Success_false_on_eviction_path()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var logger = new CapturingLogger();
        using var channel = new SseChannel(bus, subs, registry, logger);

        var ctx = new DefaultHttpContext { Response = { Body = new FaultingStream() } };
        using var cts = new CancellationTokenSource();
        var subscriberTask = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: "c1", cts.Token);

        await WaitFor(() => subs.Current == 1, TimeSpan.FromSeconds(5));
        var subscriberId = channel.LatestSubscriberIdForCookieSession("c1")!;
        var prRef = new PrReference("o", "r", 1);
        registry.Add(subscriberId, prRef);

        bus.Publish(new ActivePrUpdated(prRef, HeadShaChanged: true, CommentCountChanged: false, NewHeadSha: "h2", NewCommentCount: null));

        await WaitFor(() => logger.Messages.Any(m => m.Contains("success=False", StringComparison.Ordinal)), TimeSpan.FromSeconds(5));

        var failureLine = logger.Messages.Single(m => m.Contains("success=False", StringComparison.Ordinal));
        failureLine.Should().Contain("SSE delivery");
        failureLine.Should().Contain($"subscriber={subscriberId}");
        failureLine.Should().Contain("success=False");

        try { await subscriberTask; } catch (OperationCanceledException) { } catch (IOException) { }
    }

    [Fact]
    public async Task T_INV_6c_delivery_log_does_NOT_emit_for_inbox_broadcast_events()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var logger = new CapturingLogger();
        using var channel = new SseChannel(bus, subs, registry, logger);

        var ctx = new DefaultHttpContext { Response = { Body = new MemoryStream() } };
        using var cts = new CancellationTokenSource();
        var subscriberTask = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: "c1", cts.Token);

        await WaitFor(() => subs.Current == 1, TimeSpan.FromSeconds(5));

        // No registry.Add — inbox events are broadcast, not per-PR-scoped.
        bus.Publish(new InboxUpdated(new[] { "review-requested" }, 1));

        // Give the fire-and-forget delivery task a window to run if it were going to log.
        // The capturing logger filters on EventId 5; if the null-guard works, no message lands.
        // 1s ceiling is the trade-off for a negative-shape test: long enough to absorb
        // thread-pool scheduling latency on loaded CI (where 200ms wasn't always sufficient
        // to make the test diagnostic rather than vacuous), short enough that a 100-run
        // suite doesn't pay a significant cost. A truly deterministic sync would require
        // observing the InboxUpdated broadcast write to the response body — deferred as
        // an over-engineering risk for a single negative assertion.
        await Task.Delay(1000);

        logger.Messages.Should().BeEmpty("InboxUpdated events pass (null, null) to WriteAndEvictOnFailureAsync; the EventId-5 delivery log's null-guard must skip them");

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
        // Throw so an assertion failure that originates here surfaces the timeout reason
        // ("predicate not met within Ns") instead of the downstream symptom
        // ("collection was empty"). Without this throw, a missed subscriber registration
        // or a missing log line looks like a flaky assertion on otherwise-correct code.
        throw new TimeoutException($"WaitFor predicate did not become true within {timeout.TotalSeconds:F1}s");
    }
}
