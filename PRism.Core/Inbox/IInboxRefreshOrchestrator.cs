namespace PRism.Core.Inbox;

public interface IInboxRefreshOrchestrator
{
    InboxSnapshot? Current { get; }
    Task<bool> WaitForFirstSnapshotAsync(TimeSpan timeout, CancellationToken ct);
    Task RefreshAsync(CancellationToken ct);

    /// <summary>
    /// Fires a single background refresh exactly once per orchestrator lifetime. Subsequent
    /// calls are no-ops. Use from cold-start paths (e.g., the first <c>/api/inbox</c> request)
    /// to avoid queuing multiple concurrent refreshes when <see cref="Current"/> is still null.
    /// </summary>
    void TryColdStartRefresh();
}
