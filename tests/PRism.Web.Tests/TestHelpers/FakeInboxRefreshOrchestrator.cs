using PRism.Core.Inbox;

namespace PRism.Web.Tests.TestHelpers;

public sealed class FakeInboxRefreshOrchestrator : IInboxRefreshOrchestrator
{
    public InboxSnapshot? Current { get; set; }
    public Func<TimeSpan, CancellationToken, Task<bool>>? WaitOverride { get; set; }
    public int RefreshCalls { get; private set; }

    public Task<bool> WaitForFirstSnapshotAsync(TimeSpan timeout, CancellationToken ct)
        => WaitOverride?.Invoke(timeout, ct) ?? Task.FromResult(Current != null);

    public Task RefreshAsync(CancellationToken ct) { RefreshCalls++; return Task.CompletedTask; }
}
