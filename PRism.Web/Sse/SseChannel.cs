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
    private const int PerWriteTimeoutSeconds = 5;
    private const int HeartbeatIntervalSeconds = 25;

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
    // active SSE connection exists for that cookie. Used by tests to assert multimap
    // behavior. Endpoint code uses TrySubscribe / TryUnsubscribe instead — those run the
    // registry mutation under _cookieGate so a concurrent SSE disconnect cannot race
    // between the lookup and the Add (closes the orphan-registry-entry TOCTOU).
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

    // Atomically resolves the cookie's most-recent still-connected subscriberId and adds
    // (subscriberId, prRef) to the registry. Returns false if the cookie has no active
    // SSE connection. The lock is the same one disconnect holds when removing from
    // _cookieToSubs — so disconnect's "remove from cookie list" + "registry.RemoveSubscriber"
    // sequence cannot interleave with this method's "lookup + Add" between them, closing
    // the TOCTOU window where orphan entries could end up in the registry indefinitely.
    public bool TrySubscribe(string? cookieSessionId, PrReference prRef, ActivePrSubscriberRegistry registry)
    {
        ArgumentNullException.ThrowIfNull(prRef);
        ArgumentNullException.ThrowIfNull(registry);
        if (string.IsNullOrEmpty(cookieSessionId)) return false;
        lock (_cookieGate)
        {
            if (!_cookieToSubs.TryGetValue(cookieSessionId, out var list)) return false;
            for (var i = list.Count - 1; i >= 0; i--)
            {
                var subscriberId = list[i];
                if (_subscribers.ContainsKey(subscriberId))
                {
                    registry.Add(subscriberId, prRef);
                    return true;
                }
            }
            return false;
        }
    }

    public bool TryUnsubscribe(string? cookieSessionId, PrReference prRef, ActivePrSubscriberRegistry registry)
    {
        ArgumentNullException.ThrowIfNull(prRef);
        ArgumentNullException.ThrowIfNull(registry);
        if (string.IsNullOrEmpty(cookieSessionId)) return false;
        lock (_cookieGate)
        {
            if (!_cookieToSubs.TryGetValue(cookieSessionId, out var list)) return false;
            for (var i = list.Count - 1; i >= 0; i--)
            {
                var subscriberId = list[i];
                if (_subscribers.ContainsKey(subscriberId))
                {
                    registry.Remove(subscriberId, prRef);
                    return true;
                }
            }
            return false;
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
        // Lifecycle CTS links to RequestAborted AND can be cancelled by EvictSubscriber.
        // Heartbeat awaits use this token, so a publisher-side eviction immediately
        // unblocks the heartbeat loop instead of letting it block on a stalled pipe.
        using var lifecycleCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var sub = new SseSubscriber(response, subscriberId, lifecycleCts, ct);
        var registered = false;

        try
        {
            // Write the subscriber-assigned handshake BEFORE registering the subscriber
            // in _subscribers / _cookieToSubs. Closes the race where a concurrent
            // OnInboxUpdated could pick up the new subscriberId (via _subscribers.Values)
            // and deliver an inbox-updated frame before the handshake — the SPA reads
            // the handshake to learn its subscriberId, so out-of-order delivery breaks
            // the contract documented at spec § 6.2 line 295-299.
            var assigned = $"event: subscriber-assigned\ndata: {{\"subscriberId\":\"{subscriberId}\"}}\n\n";
            await sub.WriteAsync(assigned, lifecycleCts.Token).ConfigureAwait(false);

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
            registered = true;

            // Heartbeat as a NAMED event (not an SSE comment). Spec § 6.2: comment-form
            // `:heartbeat` is invisible to browser EventSource onmessage and cannot drive
            // the frontend silence-watcher. Per-write 5s timeout linked to the lifecycle
            // token gives heartbeat the same eviction discipline as the publisher path.
            while (!lifecycleCts.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromSeconds(HeartbeatIntervalSeconds), lifecycleCts.Token).ConfigureAwait(false);
                using var writeCts = CancellationTokenSource.CreateLinkedTokenSource(lifecycleCts.Token);
                writeCts.CancelAfter(TimeSpan.FromSeconds(PerWriteTimeoutSeconds));
                await sub.WriteAsync("event: heartbeat\ndata: {}\n\n", writeCts.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) { /* normal client disconnect or eviction */ }
        catch (IOException) { /* broken pipe / connection reset */ }
        finally
        {
            // Double-decrement guard: TryRemove returns false if EvictSubscriber already
            // removed the subscriber from the publisher path. Decrement only if we still
            // hold the count (mirror EvictSubscriber's path). Without this, a publisher-
            // evicted subscriber whose RunSubscriberAsync still runs to completion
            // would Decrement twice. While InboxSubscriberCount.Decrement clamps at 0,
            // the second clamp-decrement still runs the 1→0 transition logic, which
            // resets the InboxPoller's gate — and any other still-connected subscriber
            // sees inbox polls stop until it reconnects. (Adversarial reviewer ADV-001.)
            var actuallyRemoved = registered && _subscribers.TryRemove(subscriberId, out _);
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
            if (actuallyRemoved) _subs.Decrement();
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
            // are unaffected.
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(s.RequestAborted);
            cts.CancelAfter(TimeSpan.FromSeconds(PerWriteTimeoutSeconds));
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
        {
            // Cancel the lifecycle token so the heartbeat loop in RunSubscriberAsync
            // exits its next await (Task.Delay or WriteAsync). Without this, the
            // heartbeat keeps trying to write to the same stalled pipe behind
            // _writeLock, and the request thread is stuck until Kestrel finally
            // tears the connection down via RequestAborted.
            s.RequestEviction();
            _subs.Decrement();
        }
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
        private readonly CancellationTokenSource _lifecycleCts;

        public SseSubscriber(HttpResponse response, string subscriberId, CancellationTokenSource lifecycleCts, CancellationToken requestAborted)
        {
            _response = response;
            SubscriberId = subscriberId;
            _lifecycleCts = lifecycleCts;
            RequestAborted = requestAborted;
        }

        public string SubscriberId { get; }
        public CancellationToken RequestAborted { get; }

        // Cancels the lifecycle CTS so RunSubscriberAsync's heartbeat loop exits.
        // Safe to call concurrently with the heartbeat loop's own token observation —
        // CTS.Cancel is idempotent and thread-safe. Disposal happens in the finally
        // block via the `using var` declared in RunSubscriberAsync, NOT here.
        public void RequestEviction()
        {
            try { _lifecycleCts.Cancel(); }
#pragma warning disable CA1031 // CTS.Cancel can throw AggregateException of registration callbacks; swallow because eviction is best-effort.
            catch { }
#pragma warning restore CA1031
        }

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
