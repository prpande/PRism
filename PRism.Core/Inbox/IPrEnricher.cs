using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

public interface IPrEnricher
{
    /// <summary>Adds head_sha, additions, deletions, pushed_at, iterationNumber from pulls/{n}.</summary>
    Task<IReadOnlyList<RawPrInboxItem>> EnrichAsync(
        IReadOnlyList<RawPrInboxItem> items, CancellationToken ct);
}
