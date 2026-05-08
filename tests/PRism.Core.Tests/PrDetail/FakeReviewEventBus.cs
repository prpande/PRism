using PRism.Core.Events;

namespace PRism.Core.Tests.PrDetail;

internal sealed class FakeReviewEventBus : IReviewEventBus
{
    private readonly List<object> _published = new();
    private readonly object _gate = new();

    public IReadOnlyList<object> Published
    {
        get { lock (_gate) return _published.ToArray(); }
    }

    public void Publish<TEvent>(TEvent evt) where TEvent : IReviewEvent
    {
        ArgumentNullException.ThrowIfNull(evt);
        lock (_gate) _published.Add(evt);
    }

    public IDisposable Subscribe<TEvent>(Action<TEvent> handler) where TEvent : IReviewEvent
        => new NullDisposable();

    private sealed class NullDisposable : IDisposable { public void Dispose() { } }
}
