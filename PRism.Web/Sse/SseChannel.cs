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
            lock (_gate) _writers.Remove(sub);
            _subs.Decrement();
            sub.Dispose();
        }
    }

    private static readonly Action<ILogger, Exception?> s_writeFailedLog =
        LoggerMessage.Define(LogLevel.Debug, new EventId(0, "SseWriteFailed"),
            "SSE write failed; subscriber will be evicted on next loop");

    private void OnInboxUpdated(InboxUpdated evt)
    {
        var json = JsonSerializer.Serialize(evt, JsonSerializerOptionsFactory.Api);
        var frame = $"event: inbox-updated\ndata: {json}\n\n";
        SseSubscriber[] snapshot;
        lock (_gate) snapshot = _writers.ToArray();
        foreach (var s in snapshot)
        {
            // Fire-and-forget by design: this handler runs on the publisher's thread and
            // must not block. Per-subscriber serialization is enforced inside SseSubscriber
            // (a SemaphoreSlim guards the underlying HttpResponse.Body PipeWriter, which is
            // not thread-safe). Reviewer suggested also evicting subscribers on write
            // failure; that is deferred to S3 along with backpressure (spec § 11).
            try { _ = s.WriteAsync(frame, default); }
#pragma warning disable CA1031 // SSE write failures should not crash the publisher; subscriber will be evicted on its own loop's next failure.
            catch (Exception ex)
            {
                s_writeFailedLog(_log, ex);
            }
#pragma warning restore CA1031
        }
    }

    public void Dispose() => _busSub.Dispose();

    private sealed class SseSubscriber : IDisposable
    {
        private readonly HttpResponse _response;
        // Per-subscriber lock that serializes writes to the response body. The two write
        // paths (heartbeat loop in RunSubscriberAsync, and event delivery from the bus
        // via OnInboxUpdated) both flow through WriteAsync, so they cannot interleave
        // and corrupt SSE framing. Disposed when the subscriber is removed from
        // _writers (RunSubscriberAsync's finally block) — by that point no further
        // writes can be issued because the publisher already snapshotted _writers.
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
