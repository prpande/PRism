using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace PRism.Core.Events;

public sealed class ReviewEventBus : IReviewEventBus
{
    private readonly Dictionary<Type, List<Delegate>> _handlers = new();
    private readonly object _gate = new();
    private readonly ILogger _log;

    // Optional logger: DI resolves ILogger<ReviewEventBus> from the container, while the
    // ~45 `new ReviewEventBus()` test call sites get NullLogger. Mirrors the optional-logger
    // ctor pattern on InboxRefreshOrchestrator.
    public ReviewEventBus(ILogger<ReviewEventBus>? log = null) => _log = log ?? NullLogger<ReviewEventBus>.Instance;

    public void Publish<TEvent>(TEvent evt) where TEvent : IReviewEvent
    {
        Delegate[] snapshot;
        lock (_gate)
        {
            if (!_handlers.TryGetValue(typeof(TEvent), out var list)) return;
            snapshot = list.ToArray();
        }
        // Per-handler fault isolation (#323): one throwing subscriber must not abort dispatch
        // to the remaining subscribers, nor propagate into the publisher. OperationCanceledException
        // is rethrown so cooperative cancellation still aborts the publish.
        foreach (var d in snapshot)
        {
            try
            {
                ((Action<TEvent>)d)(evt);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
#pragma warning disable CA1031 // a faulting subscriber is isolated and logged, not propagated
            catch (Exception ex)
#pragma warning restore CA1031
            {
                s_subscriberFaulted(_log, typeof(TEvent).Name, ex);
            }
        }
    }

    public IDisposable Subscribe<TEvent>(Action<TEvent> handler) where TEvent : IReviewEvent
    {
        ArgumentNullException.ThrowIfNull(handler);
        lock (_gate)
        {
            if (!_handlers.TryGetValue(typeof(TEvent), out var list))
                _handlers[typeof(TEvent)] = list = new List<Delegate>();
            list.Add(handler);
        }
        return new Subscription(() =>
        {
            lock (_gate)
            {
                if (_handlers.TryGetValue(typeof(TEvent), out var list)) list.Remove(handler);
            }
        });
    }

    private static readonly Action<ILogger, string, Exception?> s_subscriberFaulted =
        LoggerMessage.Define<string>(LogLevel.Error,
            new EventId(1, "ReviewEventBusSubscriberFaulted"),
            "A {EventType} subscriber threw; isolating the fault and continuing dispatch");

    private sealed class Subscription : IDisposable
    {
        private readonly Action _onDispose;
        public Subscription(Action onDispose) { _onDispose = onDispose; }
        public void Dispose() => _onDispose();
    }
}
