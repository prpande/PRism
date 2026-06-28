namespace PRism.Core.PrDetail;

/// <summary>
/// Signals a background poller to cut its current delay short and tick immediately.
/// Implemented by <see cref="ActivePrPoller"/> so the SSE channel can request a
/// fresh mergeability read the moment a new subscriber connects.
/// </summary>
public interface IImmediateRefresh
{
    void RequestImmediateRefresh();
}
