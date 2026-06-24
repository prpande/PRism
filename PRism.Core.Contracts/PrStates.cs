namespace PRism.Core.Contracts;

// The single place a GitHub state string becomes a PrState. REST emits lowercase
// open/closed and reports a merged PR as "closed", so callers pass the merge signal
// separately (merged_at present). GraphQL emits uppercase OPEN/CLOSED/MERGED. This
// helper tolerates both casings and the literal "MERGED"; unknown/null → Open.
public static class PrStates
{
    public static PrState FromGitHub(string? rawState, bool merged)
    {
        if (merged || string.Equals(rawState, "merged", StringComparison.OrdinalIgnoreCase))
            return PrState.Merged;
        return string.Equals(rawState, "closed", StringComparison.OrdinalIgnoreCase)
            ? PrState.Closed
            : PrState.Open;
    }

    // Reconstructs PR lifecycle state from the only signals an inbox row carries (no raw
    // `state` string is fetched for inbox). Merged wins over Closed (a merged PR also has a
    // closedAt on some payloads); both null -> Open.
    public static PrState FromTimestamps(DateTimeOffset? mergedAt, DateTimeOffset? closedAt)
        => mergedAt.HasValue ? PrState.Merged
         : closedAt.HasValue ? PrState.Closed
         : PrState.Open;
}
