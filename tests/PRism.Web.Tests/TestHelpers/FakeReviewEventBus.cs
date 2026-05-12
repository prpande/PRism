using PRism.Core.Events;

namespace PRism.Web.Tests.TestHelpers;

// Records every published IReviewEvent so endpoint tests can assert what the submit pipeline
// fanned out, without standing up an SSE stream. Subscribe is a no-op (returns a disposable
// that does nothing) — tests using this in place of the real ReviewEventBus assert against
// Published, not against actual SSE delivery.
internal sealed class FakeReviewEventBus : IReviewEventBus
{
    private readonly object _gate = new();
    private readonly List<IReviewEvent> _published = new();

    public IReadOnlyList<IReviewEvent> Published
    {
        get { lock (_gate) { return _published.ToArray(); } }
    }

    public void Publish<TEvent>(TEvent evt) where TEvent : IReviewEvent
    {
        ArgumentNullException.ThrowIfNull(evt);
        lock (_gate) { _published.Add(evt); }
    }

    public IDisposable Subscribe<TEvent>(Action<TEvent> handler) where TEvent : IReviewEvent
    {
        ArgumentNullException.ThrowIfNull(handler);
        return NoopSubscription.Instance;
    }

    public void Clear()
    {
        lock (_gate) { _published.Clear(); }
    }

    private sealed class NoopSubscription : IDisposable
    {
        public static readonly NoopSubscription Instance = new();
        public void Dispose() { }
    }
}
