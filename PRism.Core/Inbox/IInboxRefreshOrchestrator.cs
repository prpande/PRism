namespace PRism.Core.Inbox;

public interface IInboxRefreshOrchestrator
{
    InboxSnapshot? Current { get; }

    /// <summary>
    /// True while the served snapshot is a rehydrated, not-yet-successfully-revalidated cache
    /// (drives the <c>stale</c> wire flag, #619). Flips false once the first refresh since launch
    /// commits. A failed (network) revalidation does NOT clear it — the data is still stale.
    /// Default implementation returns false so existing fakes that don't override it keep
    /// compiling — no CS0535 blast radius. The concrete <see cref="InboxRefreshOrchestrator"/>
    /// overrides it with the real flag.
    /// </summary>
    bool IsServingRehydratedSnapshot => false;

    Task<bool> WaitForFirstSnapshotAsync(TimeSpan timeout, CancellationToken ct);

    /// <summary>
    /// Pulls a fresh inbox snapshot. <paramref name="hardRefresh"/> = true forces a live-CI
    /// re-read bypassing the (ref, headSha) cache (the manual "Refresh now" path, #355); the
    /// background poll and cold-start pass false to keep the cheap cached path.
    /// <paramref name="forceNotify"/> = true publishes <c>InboxUpdated</c> even when the PR set is
    /// unchanged — used by the AI-mode-change path, whose refresh re-populates only the
    /// (enrichment-blind-to-<c>ComputeDiff</c>) AI enrichments/settled set (#508/#548 follow-up).
    /// </summary>
    Task RefreshAsync(CancellationToken ct, bool hardRefresh = false, bool forceNotify = false);

    /// <summary>
    /// Fires a single background refresh exactly once per orchestrator lifetime. Subsequent
    /// calls are no-ops. Use from cold-start paths (e.g., the first <c>/api/inbox</c> request)
    /// to avoid queuing multiple concurrent refreshes when <see cref="Current"/> is still null.
    /// </summary>
    void TryColdStartRefresh();
}
