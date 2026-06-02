namespace PRism.Core.Inbox;

/// <summary>
/// Hardcoded bounds for the recently-closed inbox section (spec § 2 — not config:
/// ConfigStore.PatchAsync has no Int type, so these stay constants until one exists).
/// </summary>
public static class InboxHistoryConstants
{
    public const int HistoryWindowDays = 14;
    public const int MaxHistoryRows = 30;
    public const string SectionId = "recently-closed";
}
