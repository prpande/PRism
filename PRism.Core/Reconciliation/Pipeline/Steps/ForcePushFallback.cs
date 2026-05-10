using PRism.Core.State;

namespace PRism.Core.Reconciliation.Pipeline.Steps;

internal static class ForcePushFallback
{
    public sealed record FallbackResult(
        DraftStatus Status,
        int? ResolvedLine,
        StaleReason? StaleReason);

    // Whole-file scan against the new content. There is no original-line tie-breaker
    // because the original commit was rewritten — the line number from the old anchor
    // is no longer meaningful. Multi-match (any combination of tiers) → Stale per
    // spec/03 § 5 history-rewrite branch.
    public static FallbackResult Apply(string newFileContent, string anchoredContent, string filePath)
    {
        // originalLine = -1 ensures ExactAtOriginal stays empty; the matcher returns all
        // matches in ExactElsewhere / WhitespaceEquivAll.
        var matches = LineMatching.Compute(newFileContent, originalLine: -1, anchoredContent, filePath);

        var totalExact = matches.ExactElsewhere.Count;
        var totalWs = matches.WhitespaceEquivAll.Count;

        if (totalExact == 1 && totalWs == 0)
            return new FallbackResult(DraftStatus.Moved, matches.ExactElsewhere[0], null);

        if (totalExact == 0 && totalWs == 1)
            return new FallbackResult(DraftStatus.Moved, matches.WhitespaceEquivAll[0], null);

        if (totalExact == 0 && totalWs == 0)
            return new FallbackResult(DraftStatus.Stale, null, Reconciliation.StaleReason.NoMatch);

        return new FallbackResult(DraftStatus.Stale, null, Reconciliation.StaleReason.ForcePushAmbiguous);
    }
}
