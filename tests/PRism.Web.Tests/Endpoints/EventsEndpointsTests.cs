using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using FluentAssertions;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.PrDetail;
using PRism.Web.Sse;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class EventsEndpointsTests
{
    [Fact]
    public async Task Sse_endpoint_returns_text_event_stream_content_type()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        using var resp = await client.GetAsync(
            new Uri("/api/events", UriKind.Relative),
            HttpCompletionOption.ResponseHeadersRead,
            cts.Token);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        resp.Content.Headers.ContentType!.MediaType.Should().Be("text/event-stream");
    }

    [Fact]
    public async Task Sse_endpoint_writes_subscriber_assigned_as_first_event()
    {
        // Spec § 6.2: the first SSE message after connect is `event: subscriber-assigned`
        // carrying a 128-bit subscriber id (Guid.NewGuid as 32-char hex). This replaces
        // the prior `:heartbeat` SSE comment — comments are invisible to browser
        // EventSource onmessage and cannot drive the frontend silence-watcher.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        using var resp = await client.GetAsync(
            new Uri("/api/events", UriKind.Relative),
            HttpCompletionOption.ResponseHeadersRead,
            cts.Token);

        using var stream = await resp.Content.ReadAsStreamAsync(cts.Token);
        using var reader = new StreamReader(stream, Encoding.UTF8);

        var eventLine = await reader.ReadLineAsync(cts.Token);
        var dataLine = await reader.ReadLineAsync(cts.Token);

        eventLine.Should().Be("event: subscriber-assigned");
        dataLine.Should().StartWith("data: ");
        dataLine.Should().Contain("\"subscriberId\":\"");
    }

    [Fact]
    public async Task Sse_endpoint_increments_subscriber_count_on_connect()
    {
        using var factory = new PRismWebApplicationFactory();
        var subs = factory.Services.GetRequiredService<InboxSubscriberCount>();

        subs.Current.Should().Be(0);

        var client = factory.CreateClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        using var resp = await client.GetAsync(
            new Uri("/api/events", UriKind.Relative),
            HttpCompletionOption.ResponseHeadersRead,
            cts.Token);

        // Read the initial subscriber-assigned event to confirm the subscription is established.
        using var stream = await resp.Content.ReadAsStreamAsync(cts.Token);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        await reader.ReadLineAsync(cts.Token); // "event: subscriber-assigned"

        subs.Current.Should().Be(1);
    }

    [Fact]
    public async Task Sse_endpoint_close_decrements_subscriber_count()
    {
        using var factory = new PRismWebApplicationFactory();
        var subs = factory.Services.GetRequiredService<InboxSubscriberCount>();

        var client = factory.CreateClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        using var resp = await client.GetAsync(
            new Uri("/api/events", UriKind.Relative),
            HttpCompletionOption.ResponseHeadersRead,
            cts.Token);

        using var stream = await resp.Content.ReadAsStreamAsync(cts.Token);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        await reader.ReadLineAsync(cts.Token); // "event: subscriber-assigned" → subscription established

        subs.Current.Should().Be(1);

        // Dispose the response to close the connection.
        resp.Dispose();
        stream.Dispose();

        // Give the server a moment to process the disconnect.
        await Task.Delay(200, CancellationToken.None);

        subs.Current.Should().Be(0);
    }

    [Fact]
    public async Task Sse_endpoint_writes_inbox_updated_event_when_published()
    {
        using var factory = new PRismWebApplicationFactory();
        var bus = factory.Services.GetRequiredService<IReviewEventBus>();

        var client = factory.CreateClient();
        // 15s deadline (was 5s) — when the full solution test pool is hot, the
        // SSE write→read round-trip after bus.Publish can take longer than 5s under
        // CPU contention. The test logic itself is sub-second, so a longer ceiling
        // costs nothing on a fast run and prevents flakes under load.
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));

        using var resp = await client.GetAsync(
            new Uri("/api/events", UriKind.Relative),
            HttpCompletionOption.ResponseHeadersRead,
            cts.Token);

        using var stream = await resp.Content.ReadAsStreamAsync(cts.Token);
        using var reader = new StreamReader(stream, Encoding.UTF8);

        // Consume the subscriber-assigned event first (3 lines: event, data, blank).
        await reader.ReadLineAsync(cts.Token); // "event: subscriber-assigned"
        await reader.ReadLineAsync(cts.Token); // "data: { ... }"
        await reader.ReadLineAsync(cts.Token); // "" (blank line terminating the frame)

        // Publish an event from the bus.
        bus.Publish(new InboxUpdated(new[] { "review-requested" }, 1));

        // Read the event frame lines.
        var eventLine = await reader.ReadLineAsync(cts.Token);
        var dataLine = await reader.ReadLineAsync(cts.Token);

        eventLine.Should().Be("event: inbox-updated");
        dataLine.Should().Contain("\"changedSectionIds\":[\"review-requested\"]");
        dataLine.Should().Contain("\"newOrUpdatedPrCount\":1");
        dataLine.Should().StartWith("data: ");
    }

    [Fact]
    public async Task Sse_subscriber_writes_are_serialized_per_subscriber()
    {
        // Regression test: PR #4 review feedback. The heartbeat write path and the
        // OnInboxUpdated fire-and-forget event-write path can both target the same
        // HttpResponse.Body (PipeWriter, NOT thread-safe). Without per-subscriber
        // serialization (e.g. a SemaphoreSlim), concurrent writes interleave and
        // corrupt the SSE framing.
        //
        // This test wraps the response body with a stream that records the maximum
        // number of writes that are in-flight at any one time, with a small per-write
        // delay to widen the race window. With per-subscriber serialization,
        // max-concurrent must be exactly 1.
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        using var channel = new SseChannel(bus, subs, registry, NullLogger<SseChannel>.Instance);

        var trackingBody = new ConcurrencyTrackingStream(perWriteDelayMs: 25);
        var ctx = new DefaultHttpContext { Response = { Body = trackingBody } };

        using var ctsRun = new CancellationTokenSource();
        // Start the subscriber loop. The initial heartbeat write happens inside this Task.
        var runTask = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: null, ctsRun.Token);

        // Wait until the subscriber is registered so events will reach it.
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (subs.Current == 0 && DateTime.UtcNow < deadline)
            await Task.Delay(5, CancellationToken.None);
        subs.Current.Should().Be(1, "subscriber should be registered before we publish events");

        // Hammer the bus with many events while the initial heartbeat write is still
        // in-flight (the tracking stream's per-write delay keeps it alive long enough
        // for events to race).
        for (var i = 0; i < 32; i++)
            bus.Publish(new InboxUpdated(new[] { "review-requested" }, i));

        // Wait for all writes to drain. There are 1 heartbeat + 32 events = 33 expected
        // frames, each producing one WriteAsync + one FlushAsync = 66 stream operations.
        deadline = DateTime.UtcNow.AddSeconds(10);
        while (trackingBody.CompletedOps < 66 && DateTime.UtcNow < deadline)
            await Task.Delay(20, CancellationToken.None);

        // Stop the subscriber loop cleanly.
        await ctsRun.CancelAsync();
        try { await runTask; } catch (OperationCanceledException) { }

        trackingBody.MaxConcurrent.Should().Be(1,
            "all writes to the same SSE subscriber must be serialized to avoid corrupting SSE framing");

        // Sanity: all bytes written form well-formed SSE frames (each terminated by "\n\n").
        var written = Encoding.UTF8.GetString(trackingBody.GetWrittenBytes());
        written.Should().EndWith("\n\n");
    }

    [Fact]
    public async Task Sse_event_write_uses_request_aborted_token()
    {
        // Regression test: PR #4 follow-up review feedback. Event-write path inside
        // OnInboxUpdated previously called WriteAsync with CancellationToken.None,
        // so a stalled (but not yet TCP-reset) client would block fire-and-forget
        // write tasks indefinitely, accumulating memory/CPU. The fix stores the
        // request-aborted token on SseSubscriber at construction and threads it
        // into the publisher's WriteAsync call.
        //
        // Strategy: capture whichever CancellationToken the response stream sees
        // on the event-write path, then assert it can be cancelled by cancelling
        // the request-aborted token we passed into RunSubscriberAsync.
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        using var channel = new SseChannel(bus, subs, registry, NullLogger<SseChannel>.Instance);

        var capturingBody = new TokenCapturingStream();
        var ctx = new DefaultHttpContext { Response = { Body = capturingBody } };

        using var ctsRun = new CancellationTokenSource();
        var runTask = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: null, ctsRun.Token);

        // Wait until the subscriber is registered (initial heartbeat completed).
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (subs.Current == 0 && DateTime.UtcNow < deadline)
            await Task.Delay(5, CancellationToken.None);
        subs.Current.Should().Be(1, "subscriber should be registered before publishing");

        // Reset the capture so we observe only the event-write token (not the
        // initial heartbeat which uses the same token by a different code path).
        capturingBody.Reset();

        // Publish — this triggers OnInboxUpdated → WriteAndEvictOnFailureAsync →
        // SseSubscriber.WriteAsync(frame, RequestAborted) → response stream WriteAsync.
        bus.Publish(new InboxUpdated(new[] { "review-requested" }, 1));

        // Wait for the event-write to reach the stream.
        deadline = DateTime.UtcNow.AddSeconds(5);
        while (capturingBody.LastWriteToken is null && DateTime.UtcNow < deadline)
            await Task.Delay(5, CancellationToken.None);

        capturingBody.LastWriteToken.Should().NotBeNull(
            "event-write must reach the response stream");
        capturingBody.LastWriteToken!.Value.CanBeCanceled.Should().BeTrue(
            "publisher path must thread a cancellable token, not CancellationToken.None — " +
            "the linked CTS in WriteAndEvictOnFailureAsync wraps RequestAborted with a 5s " +
            "write timeout (spec § 6.2), so stalled clients evict either when RequestAborted " +
            "fires or when the 5s budget elapses");

        await ctsRun.CancelAsync();
        try { await runTask; } catch (OperationCanceledException) { } catch (IOException) { }
    }

    [Fact]
    public async Task Sse_subscriber_failed_write_evicts_from_writers_and_decrements_subs()
    {
        // Regression test: PR #4 follow-up review feedback. The OnInboxUpdated handler
        // dispatches writes fire-and-forget. If the underlying response stream throws
        // (e.g. client TCP reset) the exception was previously unobserved AND the
        // dead subscriber was never evicted, so the publisher kept hammering it on
        // every subsequent event. The fix observes the task's exception and, on
        // failure, evicts the subscriber from _writers and decrements _subs.
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        using var channel = new SseChannel(bus, subs, registry, NullLogger<SseChannel>.Instance);

        // Stream that succeeds on the initial heartbeat write but throws on the
        // first event-write triggered by OnInboxUpdated. We allow the heartbeat
        // through so the subscriber is fully registered before we induce the failure.
        var failingBody = new FailOnNthWriteStream(failOnWriteOrdinal: 2);
        var ctx = new DefaultHttpContext { Response = { Body = failingBody } };

        using var ctsRun = new CancellationTokenSource();
        var runTask = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: null, ctsRun.Token);

        // Wait until the subscriber is registered (initial heartbeat completed).
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (subs.Current == 0 && DateTime.UtcNow < deadline)
            await Task.Delay(5, CancellationToken.None);
        subs.Current.Should().Be(1, "subscriber should be registered before publishing");

        // Publish an event — this triggers a write that will throw inside the
        // fire-and-forget task. The eviction-helper must observe the exception and
        // remove the subscriber.
        bus.Publish(new InboxUpdated(new[] { "review-requested" }, 1));

        // Wait for the eviction to complete (the helper races the publisher thread).
        deadline = DateTime.UtcNow.AddSeconds(5);
        while (subs.Current != 0 && DateTime.UtcNow < deadline)
            await Task.Delay(10, CancellationToken.None);

        subs.Current.Should().Be(0, "failed write must evict the subscriber and decrement _subs");

        // Publish another event. With the subscriber evicted no further writes should
        // be attempted on the dead stream — the publisher must not double-decrement
        // and must not throw.
        bus.Publish(new InboxUpdated(new[] { "review-requested" }, 2));
        await Task.Delay(50, CancellationToken.None);
        subs.Current.Should().Be(0, "subsequent publishes must not double-decrement");

        // Stop the subscriber loop cleanly. The heartbeat loop in RunSubscriberAsync
        // is independent of the eviction; cancelling it lets the test tear down.
        await ctsRun.CancelAsync();
        try { await runTask; } catch (OperationCanceledException) { } catch (IOException) { }
    }

    [Fact]
    public async Task Sse_publisher_eviction_signals_heartbeat_loop_to_exit_cleanly()
    {
        // Regression test (rewritten in S3 PR5): the previous bug was that the
        // publisher path could dispose the SseSubscriber while the heartbeat loop
        // in RunSubscriberAsync was still running, throwing ObjectDisposedException
        // on the next heartbeat write. The PR5 fix uses a per-subscriber lifecycle
        // CancellationTokenSource: EvictSubscriber calls RequestEviction (which
        // cancels the lifecycle CTS), the heartbeat loop's `Task.Delay(25s, lifecycleToken)`
        // observes cancellation, the loop exits via OperationCanceledException, and
        // RunSubscriberAsync's finally runs as the single disposal site. The race
        // is now structurally impossible — the heartbeat cannot fire post-eviction
        // because lifecycle cancellation propagates synchronously to its in-flight
        // await.
        //
        // Test shape: simulate a publisher-side write failure (FailOnNthWriteStream
        // throws on the 2nd write — the 1st write is the subscriber-assigned
        // handshake), assert that runTask completes promptly afterwards (within a
        // few seconds, NOT the full 25s heartbeat interval), and assert no
        // ObjectDisposedException leaks through to the awaiter.
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        using var channel = new SseChannel(bus, subs, registry, NullLogger<SseChannel>.Instance);

        // Write 1 (subscriber-assigned handshake) succeeds; write 2 (the publisher's
        // inbox-updated frame) throws. With the new code, handshake-before-register
        // means the failed publish triggers eviction → lifecycle cancel → heartbeat
        // exits → finally disposes.
        var failingBody = new FailOnNthWriteStream(failOnWriteOrdinal: 2);
        var ctx = new DefaultHttpContext { Response = { Body = failingBody } };

        using var ctsRun = new CancellationTokenSource();
        var runTask = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: null, ctsRun.Token);

        // Wait until the subscriber is registered (handshake completed and
        // _subs.Increment has run).
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (subs.Current == 0 && DateTime.UtcNow < deadline)
            await Task.Delay(5, CancellationToken.None);
        subs.Current.Should().Be(1, "subscriber should be registered before publishing");

        bus.Publish(new InboxUpdated(new[] { "review-requested" }, 1));

        // The eviction signal cancels the lifecycle token, which makes the heartbeat
        // loop's `Task.Delay(..., lifecycleToken)` observe cancellation immediately
        // and the loop exit via OCE → finally → dispose. runTask should complete
        // within a few seconds (NOT the 25s heartbeat interval, which is the proof
        // that the lifecycle cancellation actually propagated).
        var completed = await Task.WhenAny(runTask, Task.Delay(TimeSpan.FromSeconds(10)));
        completed.Should().BeSameAs(runTask,
            "publisher eviction must signal the heartbeat loop to exit promptly via lifecycle CTS — " +
            "if this times out, the lifecycle-cancellation plumbing has regressed and a stalled " +
            "publisher-evicted subscriber would leak its request thread until Kestrel tears it down");

        // Awaiting runTask must not throw ObjectDisposedException (the original bug);
        // OCE / IOException are the expected normal-disconnect throw types and are
        // caught inside RunSubscriberAsync.
        Func<Task> awaitRun = async () => await runTask;
        await awaitRun.Should().NotThrowAsync<ObjectDisposedException>(
            "the lifecycle-CTS-driven heartbeat exit must not race with disposal — finally is the " +
            "single disposal site and runs after the heartbeat loop has fully unwound");

        subs.Current.Should().Be(0, "eviction's Decrement must take subs to 0; finally's TryRemove returns false (already removed) so no double-decrement");
    }

    /// <summary>
    /// Stream wrapper that records the CancellationToken observed by the most recent
    /// WriteAsync call. Used to assert that the publisher's event-write path threads
    /// the request-aborted token (and not CancellationToken.None) through to the
    /// underlying response body.
    /// </summary>
    private sealed class TokenCapturingStream : Stream
    {
        private CancellationToken? _lastWriteToken;
        public CancellationToken? LastWriteToken => _lastWriteToken;

        public void Reset() => _lastWriteToken = null;

        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { /* no-op */ }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) { /* no-op */ }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            _lastWriteToken = cancellationToken;
            return Task.CompletedTask;
        }

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            _lastWriteToken = cancellationToken;
            return ValueTask.CompletedTask;
        }

        public override Task FlushAsync(CancellationToken cancellationToken)
        {
            _lastWriteToken = cancellationToken;
            return Task.CompletedTask;
        }
    }

    /// <summary>
    /// Stream wrapper that succeeds for the first (failOnWriteOrdinal - 1) WriteAsync
    /// calls and throws on the Nth and every subsequent write. Used to simulate a
    /// dead client connection mid-stream.
    /// </summary>
    private sealed class FailOnNthWriteStream : Stream
    {
        private readonly int _failOnWriteOrdinal;
        private int _writeCount;

        public FailOnNthWriteStream(int failOnWriteOrdinal) { _failOnWriteOrdinal = failOnWriteOrdinal; }

        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { /* no-op */ }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => MaybeThrow();

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            MaybeThrow();
            return Task.CompletedTask;
        }

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            MaybeThrow();
            return ValueTask.CompletedTask;
        }

        public override Task FlushAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        private void MaybeThrow()
        {
            var n = Interlocked.Increment(ref _writeCount);
            if (n >= _failOnWriteOrdinal)
                throw new IOException($"simulated stream failure on write #{n}");
        }
    }

    /// <summary>
    /// Stream wrapper that records the maximum number of WriteAsync/FlushAsync calls
    /// in flight at any one moment, with an artificial per-call delay to widen any race.
    /// </summary>
    private sealed class ConcurrencyTrackingStream : Stream
    {
        private readonly MemoryStream _buffer = new();
        private readonly object _bufGate = new();
        private readonly int _perWriteDelayMs;
        private int _inFlight;
        private int _maxConcurrent;
        private int _completedOps;

        public ConcurrencyTrackingStream(int perWriteDelayMs)
        {
            _perWriteDelayMs = perWriteDelayMs;
        }

        public int MaxConcurrent => Volatile.Read(ref _maxConcurrent);
        public int CompletedOps => Volatile.Read(ref _completedOps);

        public byte[] GetWrittenBytes()
        {
            lock (_bufGate) return _buffer.ToArray();
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
            EnterTrack();
            try
            {
                Thread.Sleep(_perWriteDelayMs);
                lock (_bufGate) _buffer.Write(buffer, offset, count);
            }
            finally { ExitTrack(); }
        }

        public override async Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            EnterTrack();
            try
            {
                await Task.Delay(_perWriteDelayMs, cancellationToken).ConfigureAwait(false);
                lock (_bufGate) _buffer.Write(buffer, offset, count);
            }
            finally { ExitTrack(); }
        }

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            EnterTrack();
            try
            {
                await Task.Delay(_perWriteDelayMs, cancellationToken).ConfigureAwait(false);
                lock (_bufGate) _buffer.Write(buffer.Span);
            }
            finally { ExitTrack(); }
        }

        public override async Task FlushAsync(CancellationToken cancellationToken)
        {
            EnterTrack();
            try
            {
                await Task.Delay(_perWriteDelayMs, cancellationToken).ConfigureAwait(false);
            }
            finally { ExitTrack(); }
        }

        private void EnterTrack()
        {
            var n = Interlocked.Increment(ref _inFlight);
            // Update max-concurrent atomically.
            int observed;
            do
            {
                observed = Volatile.Read(ref _maxConcurrent);
                if (n <= observed) break;
            }
            while (Interlocked.CompareExchange(ref _maxConcurrent, n, observed) != observed);
        }

        private void ExitTrack()
        {
            Interlocked.Decrement(ref _inFlight);
            Interlocked.Increment(ref _completedOps);
        }
    }
}
