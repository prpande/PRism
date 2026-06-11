using PRism.Core.Contracts;
using PRism.Core.State;

namespace PRism.Core.Inbox;

/// <summary>
/// Single source of truth for the inbox "viewed-state" projection. Both the refresh-time
/// materialization (<see cref="InboxRefreshOrchestrator"/>) and the read-time overlay
/// (GET /api/inbox) route through <see cref="Project"/>, so the projection cannot fork.
/// </summary>
public static class InboxViewedState
{
    /// <summary>
    /// Projects a PR's last-viewed head + last-seen comment id from the persisted session.
    /// The "last viewed head" is the most-recent <see cref="TabStamp"/> across all tabs
    /// (the user has one inbox, not one per tab). Session key is the canonical slash form
    /// (<see cref="PrReference.ToString"/>), matching how mark-viewed writes its stamp.
    /// </summary>
    public static (string? LastViewedHeadSha, long? LastSeenCommentId) Project(
        PrReference reference, AppState state)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(state);
        if (!state.Reviews.Sessions.TryGetValue(reference.ToString(), out var session))
            return (null, null);

        var lastViewedHeadSha = session.TabStamps.Values
            .OrderByDescending(s => s.StampedAtUtc)
            .FirstOrDefault()?.HeadSha;

        long? lastSeenCommentId = null;
        if (session.LastSeenCommentId != null
            && long.TryParse(session.LastSeenCommentId, System.Globalization.CultureInfo.InvariantCulture, out var n))
            lastSeenCommentId = n;

        return (lastViewedHeadSha, lastSeenCommentId);
    }

    /// <summary>
    /// Returns a copy of <paramref name="snapshot"/> in which every item's
    /// <c>LastViewedHeadSha</c>/<c>LastSeenCommentId</c> is re-projected from the live
    /// <paramref name="state"/>. Total replacement (never a merge), so the result depends
    /// only on <paramref name="state"/> — the snapshot's baked viewed-state is irrelevant
    /// once overlaid. Section keys are preserved, so endpoint ordering is unaffected.
    /// </summary>
    public static InboxSnapshot ApplyViewedState(InboxSnapshot snapshot, AppState state)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        ArgumentNullException.ThrowIfNull(state);

        var rebuilt = snapshot.Sections.ToDictionary(
            kv => kv.Key,
            kv => (IReadOnlyList<PrInboxItem>)kv.Value
                .Select(item =>
                {
                    var (lastViewedHeadSha, lastSeenCommentId) = Project(item.Reference, state);
                    return item with
                    {
                        LastViewedHeadSha = lastViewedHeadSha,
                        LastSeenCommentId = lastSeenCommentId,
                    };
                })
                .ToList());

        return snapshot with { Sections = rebuilt };
    }
}
