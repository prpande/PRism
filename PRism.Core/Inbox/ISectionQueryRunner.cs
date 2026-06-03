namespace PRism.Core.Inbox;

public interface ISectionQueryRunner
{
    Task<IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> QueryAllAsync(
        IReadOnlySet<string> visibleSectionIds,
        CancellationToken ct);

    /// <summary>
    /// Runs the closed-history participant searches (involves + reviewed-by, is:closed,
    /// closed:&gt;=today−windowDays), unions + dedupes by PrReference. Returns raw items
    /// WITHOUT close-state — the orchestrator enriches them for MergedAt/ClosedAt.
    /// </summary>
    Task<IReadOnlyList<RawPrInboxItem>> QueryClosedHistoryAsync(int windowDays, CancellationToken ct);
}
