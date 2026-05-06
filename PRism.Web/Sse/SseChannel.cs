using System.Text.Json;
using Microsoft.Extensions.Logging;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.Json;

namespace PRism.Web.Sse;

internal sealed class SseChannel : IDisposable
{
    private readonly InboxSubscriberCount _subs;
    private readonly ILogger<SseChannel> _log;
    private readonly List<SseSubscriber> _writers = new();
    private readonly object _gate = new();
    private readonly IDisposable _busSub;

    public SseChannel(IReviewEventBus bus, InboxSubscriberCount subs, ILogger<SseChannel> log)
    {
        ArgumentNullException.ThrowIfNull(bus);
        _subs = subs;
        _log = log;
        _busSub = bus.Subscribe<InboxUpdated>(OnInboxUpdated);
    }

    public async Task RunSubscriberAsync(HttpResponse response, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(response);

        response.Headers["Content-Type"] = "text/event-stream";
        response.Headers["Cache-Control"] = "no-store";
        response.Headers["Connection"] = "keep-alive";

        var sub = new SseSubscriber(response, ct);
        lock (_gate) _writers.Add(sub);
        _subs.Increment();

        try
        {
            // Write an initial heartbeat to flush headers and confirm the stream is live.
            await sub.WriteAsync(":heartbeat\n\n", ct).ConfigureAwait(false);

            // Loop: heartbeat every 25s until client disconnects.
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromSeconds(25), ct).ConfigureAwait(false);
                await sub.WriteAsync(":heartbeat\n\n", ct).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) { /* normal client disconnect */ }
        finally
        {
            // Centralized disposal site (PR #4 review feedback, Copilot). The
            // publisher path (OnInboxUpdated → WriteAndEvictOnFailureAsync) may
            // have already removed this subscriber from _writers on a write
            // failure — Remove's bool return guards against double-decrementing
            // _subs. The publisher path does NOT dispose, so we ALWAYS dispose
            // here: this finally is guaranteed to fire when the request completes,
            // and is the single owner of the SseSubscriber's lifetime. That
            // closes the race where a publisher-side write failure disposed the
            // subscriber's SemaphoreSlim out from under the still-running
            // heartbeat loop, causing the next heartbeat write to surface an
            // unhandled ObjectDisposedException.
            bool removed;
            lock (_gate) removed = _writers.Remove(sub);
            if (removed) _subs.Decrement();
            sub.Dispose();
        }
    }

    private static readonly Action<ILogger, Exception?> s_writeFailedLog =
        LoggerMessage.Define(LogLevel.Debug, new EventId(0, "SseWriteFailed"),
            "SSE write failed; evicting subscriber");

    private void OnInboxUpdated(InboxUpdated evt)
    {
        var json = JsonSerializer.Serialize(evt, JsonSerializerOptionsFactory.Api);
        var frame = $"event: inbox-updated\ndata: {json}\n\n";
        SseSubscriber[] snapshot;
        lock (_gate) snapshot = _writers.ToArray();
        foreach (var s in snapshot)
        {
            // Fire-and-forget by design: this handler runs on the publisher's thread
            // and must not block. Per-subscriber serialization is enforced inside
            // SseSubscriber (a SemaphoreSlim guards the underlying HttpResponse.Body
            // PipeWriter, which is not thread-safe). The helper observes the write
            // task's exceptions (so they don't become unobserved) and evicts dead
            // subscribers from _writers so the publisher stops writing to them.
            // Backpressure remains deferred to S3 (spec § 11).
            _ = WriteAndEvictOnFailureAsync(s, frame);
        }
    }

#pragma warning disable CA1031 // SSE write failures must not crash the publisher; observe + evict.
    private async Task WriteAndEvictOnFailureAsync(SseSubscriber s, string frame)
    {
        try
        {
            // Pass the subscriber's request-aborted token so a stalled/disconnected
            // client cancels the write promptly rather than blocking the
            // fire-and-forget task indefinitely (PR #4 review feedback). The
            // heartbeat loop already uses this token; this brings the publisher
            // path in line.
            await s.WriteAsync(frame, s.RequestAborted).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Normal client-disconnect path. Remove from _writers so the publisher
            // stops writing to this subscriber and decrement _subs once (Remove's
            // bool return guards against double-decrementing if RunSubscriberAsync's
            // finally also runs Remove). Disposal is centralized in
            // RunSubscriberAsync's finally — see the note there. Don't log
            // loudly — disconnects are routine.
            bool removed;
            lock (_gate) removed = _writers.Remove(s);
            if (removed) _subs.Decrement();
        }
        catch (Exception ex)
        {
            s_writeFailedLog(_log, ex);

            // Atomically evict the subscriber so the publisher stops writing to it.
            // Remove's bool return guards against double-decrementing _subs if
            // RunSubscriberAsync's finally also runs. Disposal is centralized in
            // RunSubscriberAsync's finally so we never dispose the SemaphoreSlim
            // out from under the still-running heartbeat loop (PR #4 review:
            // ObjectDisposedException race).
            bool removed;
            lock (_gate) removed = _writers.Remove(s);
            if (removed) _subs.Decrement();
        }
    }
#pragma warning restore CA1031

    public void Dispose() => _busSub.Dispose();

    private sealed class SseSubscriber : IDisposable
    {
        private readonly HttpResponse _response;
        // Per-subscriber lock that serializes writes to the response body. The two write
        // paths (heartbeat loop in RunSubscriberAsync, and event delivery from the bus
        // via OnInboxUpdated) both flow through WriteAsync, so they cannot interleave
        // and corrupt SSE framing. Disposal is centralized in RunSubscriberAsync's
        // finally block (the single lifetime owner) — the publisher's eviction path
        // (WriteAndEvictOnFailureAsync) only Removes from _writers and decrements
        // _subs, never disposes. This avoids the race where a publisher-side write
        // failure could dispose the SemaphoreSlim out from under a still-running
        // heartbeat loop, causing the next heartbeat write to throw
        // ObjectDisposedException unhandled (PR #4 review feedback).
        private readonly SemaphoreSlim _writeLock = new(1, 1);

        public SseSubscriber(HttpResponse response, CancellationToken requestAborted)
        {
            _response = response;
            RequestAborted = requestAborted;
        }

        // Per-request cancellation token (HttpContext.RequestAborted), captured at
        // construction so the publisher's fire-and-forget write path
        // (OnInboxUpdated → WriteAndEvictOnFailureAsync) can cancel writes when the
        // client disconnects. The heartbeat loop in RunSubscriberAsync already
        // receives this token directly via its parameter.
        public CancellationToken RequestAborted { get; }

        public async Task WriteAsync(string frame, CancellationToken ct)
        {
            await _writeLock.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                await _response.WriteAsync(frame, ct).ConfigureAwait(false);
                await _response.Body.FlushAsync(ct).ConfigureAwait(false);
            }
            finally
            {
                _writeLock.Release();
            }
        }

        public void Dispose() => _writeLock.Dispose();
    }
}
