namespace PRism.Core.Inbox;

/// <summary>
/// Bounds for the recently-closed inbox section. The history window is config-backed
/// (InboxConfig.RecentlyClosedWindowDays); the repo cap stays a constant heuristic (#133).
/// </summary>
public static class InboxHistoryConstants
{
    /// <summary>Max number of distinct repos shown in recently-closed (cap is on repos, not PRs).</summary>
    public const int MaxHistoryRepos = 20;
    public const string SectionId = "recently-closed";
}
