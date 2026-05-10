using PRism.Core.State;

namespace PRism.Core.Reconciliation.Pipeline.Steps;

internal static class Classifier
{
    public sealed record ClassifyResult(
        DraftStatus Status,
        int? ResolvedLine,
        int AlternateMatchCount,
        StaleReason? StaleReason);

    public static ClassifyResult Classify(LineMatching.MatchSet matches, int originalLine)
    {
        // Row 1: exact at original, no others → Fresh (silent re-anchor).
        if (matches.ExactAtOriginal.Count == 1 && matches.ExactElsewhere.Count == 0)
            return new ClassifyResult(DraftStatus.Draft, originalLine, 0, null);

        // Row 2: exact at original + N others → Fresh-but-ambiguous.
        if (matches.ExactAtOriginal.Count == 1 && matches.ExactElsewhere.Count > 0)
            return new ClassifyResult(DraftStatus.Draft, originalLine, matches.ExactElsewhere.Count, null);

        // Row 3: exact elsewhere only, single → Moved.
        if (matches.ExactAtOriginal.Count == 0 && matches.ExactElsewhere.Count == 1)
            return new ClassifyResult(DraftStatus.Moved, matches.ExactElsewhere[0], 0, null);

        // Row 4: multiple exact elsewhere, none at original → Moved-ambiguous (closest wins).
        if (matches.ExactAtOriginal.Count == 0 && matches.ExactElsewhere.Count > 1)
        {
            var closest = ClosestTo(matches.ExactElsewhere, originalLine);
            return new ClassifyResult(DraftStatus.Moved, closest, matches.ExactElsewhere.Count - 1, null);
        }

        // Row 5: no exact, single whitespace-equivalent → Fresh.
        if (matches.ExactAtOriginal.Count == 0
            && matches.ExactElsewhere.Count == 0
            && matches.WhitespaceEquivAll.Count == 1)
            return new ClassifyResult(DraftStatus.Draft, matches.WhitespaceEquivAll[0], 0, null);

        // Row 6: no exact, multiple whitespace-equivalent → Moved-ambiguous (closest wins).
        if (matches.ExactAtOriginal.Count == 0
            && matches.ExactElsewhere.Count == 0
            && matches.WhitespaceEquivAll.Count > 1)
        {
            var closest = ClosestTo(matches.WhitespaceEquivAll, originalLine);
            return new ClassifyResult(DraftStatus.Moved, closest, matches.WhitespaceEquivAll.Count - 1, null);
        }

        // Row 7: no match → Stale.
        return new ClassifyResult(DraftStatus.Stale, null, 0, Reconciliation.StaleReason.NoMatch);
    }

    private static int ClosestTo(IReadOnlyList<int> candidates, int target)
    {
        // Tie-break: when two candidates are equidistant from target, the lower line number
        // wins. This is a deterministic, explicit rule (not an artifact of LineMatching's
        // ascending iteration order) so future refactors of the matcher can't change the
        // classifier's resolved-line output. Rationale lives in
        // docs/specs/2026-05-09-s4-drafts-and-composer-deferrals.md under the Row 6
        // ResolvedLineNumber adjustment entry.
        int best = candidates[0];
        int bestDist = Math.Abs(best - target);
        for (int i = 1; i < candidates.Count; i++)
        {
            int dist = Math.Abs(candidates[i] - target);
            if (dist < bestDist || (dist == bestDist && candidates[i] < best))
            {
                best = candidates[i];
                bestDist = dist;
            }
        }
        return best;
    }
}
