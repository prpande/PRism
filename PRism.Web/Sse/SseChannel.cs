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
            await response.WriteAsync(":heartbeat\n\n", ct).ConfigureAwait(false);
            await response.Body.FlushAsync(ct).ConfigureAwait(false);

            // Loop: heartbeat every 25s until client disconnects.
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromSeconds(25), ct).ConfigureAwait(false);
                await response.WriteAsync(":heartbeat\n\n", ct).ConfigureAwait(false);
                await response.Body.FlushAsync(ct).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) { /* normal client disconnect */ }
        finally
        {
            lock (_gate) _writers.Remove(sub);
            _subs.Decrement();
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
            try { _ = s.WriteAsync(frame); }
#pragma warning disable CA1031 // SSE write failures should not crash the publisher; subscriber will be evicted on its own loop's next failure.
            catch (Exception ex)
            {
                s_writeFailedLog(_log, ex);
            }
#pragma warning restore CA1031
        }
    }

    public void Dispose() => _busSub.Dispose();

    private sealed class SseSubscriber
    {
        private readonly HttpResponse _response;
        public SseSubscriber(HttpResponse response) { _response = response; }
        public async Task WriteAsync(string frame)
        {
            await _response.WriteAsync(frame).ConfigureAwait(false);
            await _response.Body.FlushAsync().ConfigureAwait(false);
        }
    }
}
