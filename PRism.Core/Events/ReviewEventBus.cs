namespace PRism.Core.Events;

public sealed class ReviewEventBus : IReviewEventBus
{
    private readonly Dictionary<Type, List<Delegate>> _handlers = new();
    private readonly object _gate = new();

    public void Publish<TEvent>(TEvent evt) where TEvent : IReviewEvent
    {
        Delegate[] snapshot;
        lock (_gate)
        {
            if (!_handlers.TryGetValue(typeof(TEvent), out var list)) return;
            snapshot = list.ToArray();
        }
        foreach (var d in snapshot) ((Action<TEvent>)d)(evt);
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

    private sealed class Subscription : IDisposable
    {
        private readonly Action _onDispose;
        public Subscription(Action onDispose) { _onDispose = onDispose; }
        public void Dispose() => _onDispose();
    }
}
