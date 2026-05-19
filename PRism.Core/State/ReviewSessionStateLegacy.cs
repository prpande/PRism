namespace PRism.Core.State;

// TEMPORARY — removed when Tasks 7/8/9 land. Returns the most-recently-stamped head sha across
// all tabs as a "best effort" pre-V6-compatible value. This is the OLD bypass-prone semantic by
// design — every read site that uses this stub is replaced in a later task with the per-tab logic.
public static class ReviewSessionStateLegacy
{
    // TEMPORARY scaffolding visibility. The class + method are removed when Tasks 7/8/9 land.
    // Public during Phase 1 so PRism.Web.Tests (no IVT from PRism.Core) can call the stub
    // through ReviewSessionState's existing public surface area. Phase 5 deletes the file.
    public static string? LegacyMostRecentHeadSha(this ReviewSessionState session)
    {
        ArgumentNullException.ThrowIfNull(session);
        return session.TabStamps
            .Values
            .OrderByDescending(s => s.StampedAtUtc)
            .FirstOrDefault()?.HeadSha;
    }
}
