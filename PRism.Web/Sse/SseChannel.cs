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

        var sub = new SseSubscriber(response);
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
            // The publisher path (OnInboxUpdated → WriteAndEvictOnFailureAsync) may
            // have already evicted this subscriber on a write failure. Use Remove's
            // bool return to avoid double-decrementing _subs and double-disposing.
            bool removed;
            lock (_gate) removed = _writers.Remove(sub);
            if (removed)
            {
                _subs.Decrement();
                sub.Dispose();
            }
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
            await s.WriteAsync(frame, default).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            s_writeFailedLog(_log, ex);

            // Atomically evict the subscriber so the publisher stops writing to it.
            // RunSubscriberAsync's finally also removes on cancellation; whichever
            // path wins the Remove race is responsible for the matching decrement +
            // dispose. The other path observes Remove == false and does nothing.
            bool removed;
            lock (_gate) removed = _writers.Remove(s);
            if (removed)
            {
                _subs.Decrement();
                s.Dispose();
            }
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
        // and corrupt SSE framing. Disposed by whichever path evicts the subscriber from
        // _writers (RunSubscriberAsync's finally on cancellation, or
        // WriteAndEvictOnFailureAsync on a publisher-side write failure) — guarded by
        // the bool return of List.Remove so only one path disposes.
        private readonly SemaphoreSlim _writeLock = new(1, 1);

        public SseSubscriber(HttpResponse response) { _response = response; }

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
