namespace PRism.Core.Contracts;

// Pure precedence resolver (spec §4). All raw GitHub enum inputs are nullable strings
// compared case-insensitively; unrecognized values fall through to None (never throw —
// these GitHub fields are semi-documented and in flux). Mirrors AwaitingAuthorRule:
// stateless, single responsibility, exhaustively unit-tested.
public static class MergeReadinessRule
{
    public static MergeReadiness Derive(
        PrState state,
        bool isDraft,
        string? mergeable,        // MERGEABLE | CONFLICTING | UNKNOWN | null
        string? mergeStateStatus, // CLEAN|DIRTY|BEHIND|BLOCKED|UNSTABLE|HAS_HOOKS|DRAFT|UNKNOWN|null
        string? reviewDecision)   // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
    {
        // 1-2: terminal states win over every merge signal (fixes the stale merged-PR pill by construction).
        if (state == PrState.Merged) return MergeReadiness.Merged;
        if (state == PrState.Closed) return MergeReadiness.Closed;

        // 3: draft -> None (the PR-state glyph carries draft; badge renders nothing).
        if (isDraft || Eq(mergeStateStatus, "DRAFT")) return MergeReadiness.None;

        // 4: conflicts dominate any weaker mergeStateStatus (mergeable == CONFLICTING is an independent source).
        if (Eq(mergeStateStatus, "DIRTY") || Eq(mergeable, "CONFLICTING")) return MergeReadiness.Conflicts;

        // 5: out of date with base.
        if (Eq(mergeStateStatus, "BEHIND")) return MergeReadiness.BehindBase;

        // 6-8: BLOCKED granularity comes from reviewDecision (D1/D2: no ruleset reads, CI is its own dot).
        if (Eq(mergeStateStatus, "BLOCKED"))
        {
            if (Eq(reviewDecision, "CHANGES_REQUESTED")) return MergeReadiness.ChangesRequested;
            if (Eq(reviewDecision, "REVIEW_REQUIRED")) return MergeReadiness.ReviewRequired;
            return MergeReadiness.BlockedByProtection; // approved/null -> required check or other protection
        }

        // 9: checks unstable.
        if (Eq(mergeStateStatus, "UNSTABLE")) return MergeReadiness.Unstable;

        // 10-11: clean family. A reviewer's open change-request on a clean PR (protection doesn't
        // require review) stays green-family but flags the caveat.
        if (Eq(mergeStateStatus, "CLEAN") || Eq(mergeStateStatus, "HAS_HOOKS"))
        {
            return Eq(reviewDecision, "CHANGES_REQUESTED")
                ? MergeReadiness.ReadyWithChangesRequested
                : MergeReadiness.Ready;
        }

        // 12: UNKNOWN / null / unrecognized / no-push-access -> None.
        return MergeReadiness.None;
    }

    private static bool Eq(string? value, string token)
        => string.Equals(value, token, System.StringComparison.OrdinalIgnoreCase);
}
