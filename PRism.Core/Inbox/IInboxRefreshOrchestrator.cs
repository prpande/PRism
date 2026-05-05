namespace PRism.Core.Inbox;

public interface IInboxRefreshOrchestrator
{
    InboxSnapshot? Current { get; }
    Task<bool> WaitForFirstSnapshotAsync(TimeSpan timeout, CancellationToken ct);
    Task RefreshAsync(CancellationToken ct);
}
