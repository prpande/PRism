using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.Json;
using PRism.Core.PrDetail;

namespace PRism.Web.Sse;

internal sealed class SseChannel : IDisposable
{
    private readonly InboxSubscriberCount _subs;
    private readonly ILogger<SseChannel> _log;
    private readonly ActivePrSubscriberRegistry _activeRegistry;

    // subscriberId → SseSubscriber. The single source of truth for "who is connected".
    private readonly ConcurrentDictionary<string, SseSubscriber> _subscribers = new();

    // cookieSessionId → ordered list of subscriberIds (most-recent at tail). Multiple SSE
    // connections from the same browser (multi-tab) share one cookieSessionId — see spec
    // § 6.2 + the deferrals sidecar entry "[Skip] Singular {cookieSessionId → subscriberId}
    // map" for why this is a multimap with most-recent-wins for POST/DELETE resolution.
    private readonly Dictionary<string, List<string>> _cookieToSubs = new(StringComparer.Ordinal);
    private readonly object _cookieGate = new();

    private readonly IDisposable _busInbox;
    private readonly IDisposable _busActivePr;

    public SseChannel(
        IReviewEventBus bus,
        InboxSubscriberCount subs,
        ActivePrSubscriberRegistry activeRegistry,
        ILogger<SseChannel> log)
    {
        ArgumentNullException.ThrowIfNull(bus);
        ArgumentNullException.ThrowIfNull(activeRegistry);
        _subs = subs;
        _log = log;
        _activeRegistry = activeRegistry;
        _busInbox = bus.Subscribe<InboxUpdated>(OnInboxUpdated);
        _busActivePr = bus.Subscribe<ActivePrUpdated>(OnActivePrUpdated);
    }

    // Returns the most-recent subscriberId for the given cookieSessionId, or null if no
    // active SSE connection exists for that cookie. POST/DELETE on /api/events/subscriptions
    // call this to resolve "which subscriber is the requesting tab" — they NEVER trust a
    // subscriberId from the request body (closes the cross-tab forge attack).
    public string? LatestSubscriberIdForCookieSession(string? cookieSessionId)
    {
        if (string.IsNullOrEmpty(cookieSessionId)) return null;
        lock (_cookieGate)
        {
            return _cookieToSubs.TryGetValue(cookieSessionId, out var list) && list.Count > 0
                ? list[^1]
                : null;
        }
    }

    public async Task RunSubscriberAsync(HttpResponse response, string? cookieSessionId, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(response);

        response.Headers["Content-Type"] = "text/event-stream";
        response.Headers["Cache-Control"] = "no-store";
        response.Headers["Connection"] = "keep-alive";

        // 128-bit cryptorandom subscriber id (Guid.NewGuid is RNG-backed on .NET 6+,
        // ~122 effective bits after RFC 4122 version/variant). Spec § 6.2 trust model.
        var subscriberId = Guid.NewGuid().ToString("N");
        var sub = new SseSubscriber(response, subscriberId, ct);
        _subscribers[subscriberId] = sub;
        if (!string.IsNullOrEmpty(cookieSessionId))
        {
            lock (_cookieGate)
            {
                if (!_cookieToSubs.TryGetValue(cookieSessionId, out var list))
                    _cookieToSubs[cookieSessionId] = list = new List<string>();
                list.Add(subscriberId);
            }
        }
        _subs.Increment();

        try
        {
            // First message: subscriber-assigned. Frontend uses this as the handshake
            // completion signal AND remembers the subscriberId for subsequent
            // POST /api/events/subscriptions calls (over fetch with the cookie).
            var assigned = $"event: subscriber-assigned\ndata: {{\"subscriberId\":\"{subscriberId}\"}}\n\n";
            await sub.WriteAsync(assigned, ct).ConfigureAwait(false);

            // Heartbeat as a NAMED event (not an SSE comment). Spec § 6.2: comment-form
            // `:heartbeat` is invisible to browser EventSource onmessage and cannot drive
            // the frontend silence-watcher.
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromSeconds(25), ct).ConfigureAwait(false);
                await sub.WriteAsync("event: heartbeat\ndata: {}\n\n", ct).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) { /* normal client disconnect */ }
        catch (IOException) { /* broken pipe / connection reset */ }
        finally
        {
            _subscribers.TryRemove(subscriberId, out _);
            if (!string.IsNullOrEmpty(cookieSessionId))
            {
                lock (_cookieGate)
                {
                    if (_cookieToSubs.TryGetValue(cookieSessionId, out var list))
                    {
                        list.Remove(subscriberId);
                        if (list.Count == 0) _cookieToSubs.Remove(cookieSessionId);
                    }
                }
            }
            // Subscription registry holds prRef → subscriberId entries; drop them all on
            // disconnect so the poller stops polling PRs whose only subscriber is gone.
            _activeRegistry.RemoveSubscriber(subscriberId);
            _subs.Decrement();
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
        // Inbox events broadcast to every subscriber — each connected client sees
        // every inbox change. Per-subscriber serialization remains in WriteAsync.
        foreach (var s in _subscribers.Values)
            _ = WriteAndEvictOnFailureAsync(s, frame);
    }

    private void OnActivePrUpdated(ActivePrUpdated evt)
    {
        var json = JsonSerializer.Serialize(evt, JsonSerializerOptionsFactory.Api);
        var frame = $"event: pr-updated\ndata: {json}\n\n";
        // Per-PR fanout — only subscribers that registered for evt.PrRef receive the event.
        foreach (var subscriberId in _activeRegistry.SubscribersFor(evt.PrRef))
        {
            if (_subscribers.TryGetValue(subscriberId, out var sub))
                _ = WriteAndEvictOnFailureAsync(sub, frame);
        }
    }

#pragma warning disable CA1031 // SSE write failures must not crash the publisher; observe + evict.
    private async Task WriteAndEvictOnFailureAsync(SseSubscriber s, string frame)
    {
        try
        {
            // Per-write 5s timeout linked to the request-aborted token (spec § 6.2).
            // A subscriber whose pipe is blocked beyond 5s gets evicted; healthy subscribers
            // are unaffected. The same RequestAborted token still drives normal
            // disconnect detection.
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(s.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(5));
            await s.WriteAsync(frame, cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            EvictSubscriber(s);
        }
        catch (Exception ex)
        {
            s_writeFailedLog(_log, ex);
            EvictSubscriber(s);
        }
    }
#pragma warning restore CA1031

    private void EvictSubscriber(SseSubscriber s)
    {
        if (_subscribers.TryRemove(s.SubscriberId, out _))
            _subs.Decrement();
    }

    public void Dispose()
    {
        _busInbox.Dispose();
        _busActivePr.Dispose();
    }

    internal sealed class SseSubscriber : IDisposable
    {
        private readonly HttpResponse _response;
        // Per-subscriber lock that serializes writes to the response body. The two write
        // paths (heartbeat loop in RunSubscriberAsync and event delivery from the bus
        // via OnInboxUpdated / OnActivePrUpdated) both flow through WriteAsync. Disposal
        // is centralized in RunSubscriberAsync's finally block — the publisher's eviction
        // path only Removes from _subscribers + decrements _subs, never disposes.
        private readonly SemaphoreSlim _writeLock = new(1, 1);

        public SseSubscriber(HttpResponse response, string subscriberId, CancellationToken requestAborted)
        {
            _response = response;
            SubscriberId = subscriberId;
            RequestAborted = requestAborted;
        }

        public string SubscriberId { get; }
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
