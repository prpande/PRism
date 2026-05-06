using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

public interface ICiFailingDetector
{
    /// <summary>
    /// For each authored PR, queries Checks API and legacy combined-statuses;
    /// returns the items whose CI is failing (any failing check-run OR any
    /// error/failure status). Annotates each input with its CiStatus along
    /// the way (returns the *full* list with Ci populated; orchestrator
    /// filters down to ci-failing rows separately).
    /// </summary>
    Task<IReadOnlyList<(RawPrInboxItem Item, CiStatus Ci)>> DetectAsync(
        IReadOnlyList<RawPrInboxItem> authoredItems,
        CancellationToken ct);
}
