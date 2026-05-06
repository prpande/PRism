namespace PRism.Core.Events;

public interface IReviewEventBus
{
    void Publish<TEvent>(TEvent evt) where TEvent : IReviewEvent;
    IDisposable Subscribe<TEvent>(Action<TEvent> handler) where TEvent : IReviewEvent;
}
