using PRism.Core.Inbox;

namespace PRism.Core.Tests.TestHelpers;

// Hand-rolled IInboxRefreshOrchestrator double for the InboxPoller tests (house rule:
// no Moq on internal seams). It is a counting spy plus a per-call override so a test can
// inject throw-on-Nth-call, record invocation timestamps, or signal a TaskCompletionSource.
//
// RefreshCalls is incremented BEFORE the override runs (so a throwing override still counts,
// matching how a mock records the invocation) and is read via Volatile/Interlocked because the
// poller writes it from its BackgroundService thread while the test thread reads it concurrently.
//
// NOTE: a parallel public copy lives in PRism.Web.Tests/TestHelpers (Web.Tests does not
// reference Core.Tests, so the double is intentionally project-local on both sides — see #334).
internal sealed class FakeInboxRefreshOrchestrator : IInboxRefreshOrchestrator
{
    private int _refreshCalls;
    private int _coldStartKicked;

    public InboxSnapshot? Current { get; set; }

    /// <summary>
    /// Runs on every RefreshAsync call. A test can throw from it (synchronously, to drive the
    /// poller's exception/rate-limit handling), record DateTime.UtcNow, or complete a TCS.
    /// Null → the default no-op success.
    /// </summary>
    public Func<CancellationToken, Task>? RefreshOverride { get; set; }

    public int RefreshCalls => Volatile.Read(ref _refreshCalls);

    public Task<bool> WaitForFirstSnapshotAsync(TimeSpan timeout, CancellationToken ct)
        => Task.FromResult(Current != null);

    public Task RefreshAsync(CancellationToken ct, bool hardRefresh = false, bool forceNotify = false)
    {
        Interlocked.Increment(ref _refreshCalls);
        return RefreshOverride?.Invoke(ct) ?? Task.CompletedTask;
    }

    // Honor the IInboxRefreshOrchestrator contract: fire exactly once per lifetime;
    // subsequent calls are no-ops (CAS guard mirrors the Web.Tests fake). The Task is
    // intentionally discarded — cold-start is fire-and-forget.
    public void TryColdStartRefresh()
    {
        if (Interlocked.CompareExchange(ref _coldStartKicked, 1, 0) != 0) return;
        _ = RefreshAsync(CancellationToken.None);
    }
}
